import { Worker } from 'bullmq';
import { expireWaitlistEntry, notifyNextWaitlistEntry } from './modules/waitlist/index.js';
import { connectDatabase } from './lib/db.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { JOBS_QUEUE_NAME, jobsQueue, queueConnection } from './lib/queue.js';
import { listBusinessIds } from './modules/tenants/index.js';
import {
  generateWeeklySlots,
  releaseExpiredHolds,
} from './modules/slots/index.js';
import { sendEmail, type SendEmailInput } from './modules/notifications/index.js';
import { runNoShowScoringJob } from './modules/noshow/index.js';

/**
 * Standalone worker process — separate from the API server (`server.ts`)
 * so a slow/failing job never blocks request handling. Run with
 * `npm run worker` alongside `npm run dev`.
 */

const GENERATE_WEEKLY_SLOTS_JOB = 'generate-weekly-slots';
const WAITLIST_EXPIRE_CHECK_JOB = 'waitlist-expire-check';
/** Same literal `notifications.service.ts` enqueues onto — see that file's comment on why this isn't a shared constant. */
const PROCESS_HOLD_EXPIRY_JOB = 'process-hold-expiry';
const SEND_TRANSACTIONAL_EMAIL_JOB = 'send-transactional-email';
const SEND_REMINDER_EMAIL_JOB = 'send-reminder-email';
/** Same literal `noshow.service.ts` enqueues onto (architecture doc §10). */
const SCORE_NO_SHOW_RISK_JOB = 'score-no-show-risk';

/**
 * Tops up every business's rolling slot-generation window (architecture
 * doc §6). Thin wrapper — all the actual logic already lives in
 * `generateWeeklySlots` (Phase 3); this just iterates every business.
 *
 * Safe if one business fails: `generateWeeklySlots` is idempotent per
 * business, so a thrown error here (surfaced to BullMQ's own retry)
 * only delays that one business's generation, never corrupts another
 * business's slots or double-generates anything on retry.
 */
async function runGenerateWeeklySlots(): Promise<void> {
  const businessIds = await listBusinessIds();

  for (const businessId of businessIds) {
    const result = await generateWeeklySlots(businessId);
    logger.info(
      { businessId, ...result },
      'generate-weekly-slots ran for business',
    );
  }
}

/**
 * Periodic backstop for a Redis hold that expired without anyone
 * retrying against it (architecture doc §5). The claim-triggered lazy
 * release in `bookings.service.ts` already handles the common case —
 * a customer whose hold expired but who then tries again gets it
 * cleaned up immediately, inline. This sweep is only for a hold nobody
 * ever touches again: it never expires on its own otherwise, since
 * nothing else is watching it.
 *
 * Uses the same `hold:<slotId>` Redis key convention
 * `bookings.service.ts`'s hold mechanism writes
 * (`SET hold:slotId ... EX 300 NX`) — if that key is gone, Redis's own
 * TTL already expired it, so the Mongo-side `held` slot is stale and
 * safe to release.
 *
 * On release, calls `notifyNextWaitlistEntry` directly — the same
 * synchronous "trigger on slot release" call `claimAndHold`'s own
 * lazy-release path already makes (it's best-effort and never throws,
 * so there's no need to queue a separate hop for it; that function
 * already schedules its own `waitlist-expire-check` follow-up
 * internally once it actually notifies someone).
 */
async function runProcessHoldExpiry(): Promise<void> {
  const businessIds = await listBusinessIds();
  let releasedCount = 0;

  for (const businessId of businessIds) {
    releasedCount += await releaseExpiredHolds(businessId);
  }

  if (releasedCount > 0) {
    logger.info({ releasedCount }, 'process-hold-expiry released stale holds');
  }
}

function isSendEmailInput(payload: unknown): payload is SendEmailInput {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as SendEmailInput).to === 'string' &&
    typeof (payload as SendEmailInput).subject === 'string' &&
    typeof (payload as SendEmailInput).text === 'string'
  );
}

/**
 * Handles both `send-transactional-email` and `send-reminder-email` —
 * same payload shape, same delivery mechanism. Kept as two job names
 * (not one) per PROJECT_PLAN so their retry/backoff policy can differ
 * later if needed, even though today they do the same thing.
 */
async function runSendEmail(jobName: string, payload: unknown): Promise<void> {
  if (!isSendEmailInput(payload)) {
    logger.warn({ jobName, payload }, 'email job received a malformed payload');
    return;
  }

  await sendEmail(payload);
}

async function processJob(
  jobName: string,
  data: Record<string, unknown>,
): Promise<void> {
  switch (jobName) {
    case GENERATE_WEEKLY_SLOTS_JOB:
      await runGenerateWeeklySlots();
      break;
    case PROCESS_HOLD_EXPIRY_JOB:
      await runProcessHoldExpiry();
      break;
    case SEND_TRANSACTIONAL_EMAIL_JOB:
    case SEND_REMINDER_EMAIL_JOB:
      await runSendEmail(jobName, data);
      break;
    case WAITLIST_EXPIRE_CHECK_JOB: {
      const entryId = data.entryId;

      if (typeof entryId !== 'string' || !entryId) {
        throw new Error('waitlist-expire-check requires entryId');
      }

      await expireWaitlistEntry(entryId);
      break;
    }

    case SCORE_NO_SHOW_RISK_JOB: {
      const bookingId = data.bookingId;

      if (typeof bookingId !== 'string' || !bookingId) {
        throw new Error('score-no-show-risk requires bookingId');
      }

      // Self-contained: the handler swallows its own domain failures
      // (Gemini down, booking gone) so this never surfaces as a failed
      // job — AI is never load-bearing (architecture doc §10).
      await runNoShowScoringJob(bookingId);
      break;
    }

    default:
      logger.warn(`No handler registered for job "${jobName}"`);
  }
}

// Last-resort safety net: an unhandled rejection outside a job's own
// try/catch (e.g. a bug in the scheduler setup itself) would otherwise
// crash the worker silently — log it before exiting so it shows up.
process.on('uncaughtException', (error) => {
  logger.error(error, 'Uncaught exception in worker');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(reason, 'Unhandled promise rejection in worker');
  process.exit(1);
});

async function startWorker() {
  await connectDatabase();

  const worker = new Worker(
    JOBS_QUEUE_NAME,
    async (job) => {
      await processJob(job.name, job.data);
    },
    { connection: queueConnection },
  );

  worker.on('ready', () => {
    logger.info(`Worker listening on queue "${JOBS_QUEUE_NAME}"`);
  });

  worker.on('failed', (job, error) => {
    logger.error(error, `Job "${job?.name}" failed`);
  });

  // Registers the recurring schedules — idempotent (upsert), so safe to
  // call on every worker boot rather than needing a separate one-time
  // setup step.
  await jobsQueue.upsertJobScheduler(
    // Runs once a day to keep generateWeeklySlots's own rolling 7-day
    // window from ever going stale.
    GENERATE_WEEKLY_SLOTS_JOB,
    { pattern: '0 0 * * *' },
    { name: GENERATE_WEEKLY_SLOTS_JOB },
  );

  await jobsQueue.upsertJobScheduler(
    // Runs every minute — holds have a 5-minute TTL (architecture doc
    // §5), so this bounds how long a truly abandoned hold can sit
    // stale before this backstop catches it.
    PROCESS_HOLD_EXPIRY_JOB,
    { pattern: '* * * * *' },
    { name: PROCESS_HOLD_EXPIRY_JOB },
  );

  async function shutdown() {
    logger.info('Worker shutting down');
    await worker.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startWorker();
