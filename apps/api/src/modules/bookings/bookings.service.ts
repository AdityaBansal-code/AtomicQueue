import { createHash, randomBytes } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../../lib/Apperror.js';

import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { getBusinessById } from '../tenants/index.js';
import { enqueueNoShowScoring } from '../noshow/index.js';
import {
  enqueueReminderEmail,
  enqueueTransactionalEmail,
} from '../notifications/index.js';
import {
  claimSlot,
  confirmAvailableSlot,
  confirmHeldSlot,
  releaseHeldSlot,
  cancelConfirmedSlot,
  rescheduleConfirmedSlots,
  emitBookingConfirmationUpdate,
  getSlotById,
  listHeldSlotsForBucket,
  releaseExistingHoldForSession,
} from '../slots/index.js';
import { notifyNextWaitlistEntry } from '../waitlist/index.js';

import { BookingModel } from './bookings.model.js';

const HOLD_TTL_SECONDS = 300;
/**
 * The magic-link credential's own lifetime — a fixed application
 * constant (architecture doc §9a), NOT `Business.cancellationCutoffMinutes`.
 * Anchored to the appointment's datetime, never booking-creation time, so
 * a link for a far-future appointment doesn't expire before it happens;
 * recomputed against the new slot on reschedule.
 */
const ACCESS_TOKEN_TTL_DAYS = 7;

function computeAccessTokenExpiry(datetime: Date | string): Date {
  return new Date(
    new Date(datetime).getTime() + ACCESS_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
}

const REMINDER_OFFSETS_MS = [24 * 60 * 60 * 1000, 60 * 60 * 1000];

/**
 * Renders and enqueues the customer-facing emails for a booking event
 * (architecture doc §6/§8). Strictly post-commit, best-effort — never
 * throws into the caller, since a failed enqueue never affects booking
 * correctness. Skipped entirely for a contact with no email on file
 * (§9a's no-email boundary).
 */
function enqueueBookingEmails(params: {
  kind: 'confirmation' | 'cancellation' | 'reschedule';
  contactType: ContactType;
  contact: string;
  bookingId: string;
  accessToken?: string;
  slotDatetime?: Date | string;
}): void {
  if (params.contactType !== 'email') return;

  const manageUrl = params.accessToken
    ? `${env.FRONTEND_URL}/manage?bookingId=${params.bookingId}&token=${params.accessToken}`
    : `${env.FRONTEND_URL}/manage`;

  const when = params.slotDatetime
    ? new Date(params.slotDatetime).toLocaleString('en-US', { timeZone: 'UTC' })
    : null;

  const subject =
    params.kind === 'confirmation'
      ? 'Your booking is confirmed'
      : params.kind === 'cancellation'
        ? 'Your booking was cancelled'
        : 'Your booking was rescheduled';

  const body =
    params.kind === 'cancellation'
      ? `Your booking has been cancelled.`
      : `${when ? `Your appointment: ${when} (UTC).\n\n` : ''}Manage this booking: ${manageUrl}`;

  void enqueueTransactionalEmail({ to: params.contact, subject, text: body }).catch(
    (error: unknown) => {
      logger.warn(
        { err: error, bookingId: params.bookingId },
        'failed to enqueue booking email',
      );
    },
  );

  // Reminders only make sense for a booking that still has a future
  // appointment — i.e. confirmation / reschedule, not cancellation.
  if (params.kind !== 'cancellation' && params.slotDatetime) {
    const appointment = new Date(params.slotDatetime).getTime();
    for (const offset of REMINDER_OFFSETS_MS) {
      const sendAt = new Date(appointment - offset);
      if (sendAt.getTime() <= Date.now()) continue; // window already passed
      void enqueueReminderEmail(
        {
          to: params.contact,
          subject: 'Appointment reminder',
          text: `Reminder: your appointment is coming up.\n\nManage it: ${manageUrl}`,
        },
        sendAt,
      ).catch((error: unknown) => {
        logger.warn(
          { err: error, bookingId: params.bookingId },
          'failed to enqueue reminder email',
        );
      });
    }
  }
}

type ProviderType = 'staff' | 'resource';
type ContactType = 'email' | 'phone';

export interface ConfirmBookingInput {
  businessId: string;
  providerId: string;
  providerType: ProviderType;
  serviceId: string;
  datetime: Date | string;

  customer: {
    name: string;
    contactType: ContactType;
    contact: string;
  };

  /**
   * null for customer self-service.
   * User id for staff/owner walk-ins.
   */
  createdBy: string | null;

  /**
   * Server-side authenticated session id.
   * Used to fence the Redis hold to the browser/session that created it.
   */
  sessionId: string;
}

export interface ConfirmBookingResult {
  bookingId: string;
  accessToken: string;
}

export interface BookingServiceDependencies {
  mongoSession?: ClientSession;
}

interface RedisHold {
  sessionId: string;
  holdVersion: string;
}

export interface BookingListItem {
  id: string;
  businessId: string;
  slotId: string;
  customer: {
    name: string;
    contactType: 'email' | 'phone';
    contact: string;
  };
  createdBy: string | null;
  status: 'confirmed' | 'cancelled' | 'completed' | 'no-show';
  accessTokenExpiresAt: string | null;
  noShowRiskNote: string | null;
  createdAt: string;
  cancelledAt: string | null;
}


export interface WalkInBookingInput {
  businessId: string;
  providerId: string;
  providerType: ProviderType;
  serviceId: string;
  datetime: Date | string;
  customer: {
    name: string;
    contactType: ContactType;
    contact: string;
  };
  createdBy: string;
}

function getHoldKey(slotId: string): string {
  return `hold:${slotId}`;
}

function hashAccessToken(token: string): string {
  return createHash('sha256')
    .update(token)
    .digest('hex');
}

function normalizeContact(
  contactType: ContactType,
  contact: string,
): string {
  const normalized = contact.trim();

  return contactType === 'email'
    ? normalized.toLowerCase()
    : normalized;
}

async function readRedisHold(
  slotId: string,
): Promise<RedisHold | null> {
  const value = await redis.get(getHoldKey(slotId));

  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('sessionId' in parsed) ||
      !('holdVersion' in parsed) ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.holdVersion !== 'string'
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      holdVersion: parsed.holdVersion,
    };
  } catch {
    return null;
  }
}

async function createRedisHold(
  slotId: string,
  sessionId: string,
  holdVersion: string,
): Promise<boolean> {
  const result = await redis.set(
    getHoldKey(slotId),
    JSON.stringify({
      sessionId,
      holdVersion,
    }),
    'EX',
    HOLD_TTL_SECONDS,
    'NX',
  );

  return result === 'OK';
}

/**
 * Deletes the Redis hold only if it still belongs to this exact
 * session + fencing token.
 *
 * This prevents one request from deleting a newer hold that reused
 * the same slot.
 */
async function deleteRedisHold(
  slotId: string,
  sessionId: string,
  holdVersion: string,
): Promise<void> {
  const key = getHoldKey(slotId);

  const current = await redis.get(key);

  if (!current) {
    return;
  }

  try {
    const parsed: unknown = JSON.parse(current);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'sessionId' in parsed &&
      'holdVersion' in parsed &&
      parsed.sessionId === sessionId &&
      parsed.holdVersion === holdVersion
    ) {
      await redis.del(key);
    }
  } catch {
    // If the value is malformed, don't delete blindly.
    // TTL cleanup will remove it.
  }
}

/**
 * Claim an available Mongo slot and pair it with a Redis TTL hold.
 *
 * If claimSlot reports a held slot, we inspect Redis using the exact
 * Mongo fencing token. A missing/mismatched Redis hold means the Mongo
 * hold is stale, so we release it conditionally and retry once.
 */
async function claimAndHold(
  input: ConfirmBookingInput,
): Promise<{
  slotId: string;
  holdVersion: string;
}> {
  const oldHold = await releaseExistingHoldForSession(
    input.businessId,
    input.sessionId,
  );

  if (oldHold) {
    try {
      await deleteRedisHold(oldHold.slotId, input.sessionId, oldHold.holdVersion);
    } catch {
      // Best effort
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let claim;
    try {
      claim = await claimSlot(
        input.businessId,
        input.providerId,
        input.providerType,
        input.serviceId,
        input.datetime,
        input.sessionId,
      );
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as any).code === 11000) {
        throw new AppError(
          409,
          'SLOT_NOT_AVAILABLE',
          'Another slot was held concurrently by this session.',
        );
      }
      throw error;
    }

    if (claim.ok) {
      const redisHoldCreated = await createRedisHold(
        claim.slotId,
        input.sessionId,
        claim.holdVersion,
      );

      if (!redisHoldCreated) {
        /*
         * Mongo is already held. We deliberately do not perform an
         * unsafe compensating write here. The fencing token makes the
         * state recoverable by the normal stale-hold cleanup path.
         */
        throw new AppError(
          500,
          'SLOT_HOLD_FAILED',
          'Unable to hold the selected slot. Please try again.',
        );
      }

      return {
        slotId: claim.slotId,
        holdVersion: claim.holdVersion,
      };
    }

    if (claim.error === 'SLOT_NOT_AVAILABLE') {
      throw new AppError(
        409,
        'SLOT_NOT_AVAILABLE',
        'The selected slot is no longer available.',
      );
    }

    /*
     * SLOT_HELD:
     *
     * We only release the Mongo hold if Redis does NOT contain the
     * exact observed fencing token.
     */
    const redisHold = await readRedisHold(claim.slotId);

    if (
      redisHold &&
      redisHold.holdVersion === claim.holdVersion
    ) {
      throw new AppError(
        409,
        'SLOT_NOT_AVAILABLE',
        'The selected slot is no longer available.',
      );
    }

    await releaseHeldSlot(
      claim.slotId,
      claim.holdVersion,
    );

    // This slot just came back to 'available' via the stale-hold lazy
    // release — the "trigger on slot release" the waitlist module
    // needs (architecture doc §6/§13a). Best-effort, fire-and-forget:
    // never blocks or delays this loop's claim retry.
    void notifyNextWaitlistEntry(input.businessId, claim.slotId);
  }

  throw new AppError(
    409,
    'SLOT_NOT_AVAILABLE',
    'The selected slot is no longer available.',
  );
}

/**
 * Given a slot this caller has already claimed + holds (Mongo `held`,
 * Redis `hold:` key with a matching `sessionId`), runs the confirmation:
 * the `held → confirmed` fencing write and the `Booking` insert in one
 * Mongo transaction (§4), then every external side effect strictly
 * post-commit (§4e) — realtime emit, Redis hold cleanup, no-show scoring
 * (§10), and the confirmation + reminder emails (§6/§8).
 *
 * Shared by the authenticated `confirmBooking` and the anonymous
 * `confirmCustomerBooking` so there is exactly one confirmation code
 * path, never a parallel "customer path" through the state machine.
 */
async function finalizeConfirmation(
  slotId: string,
  holdVersion: string,
  input: ConfirmBookingInput,
  dependencies: BookingServiceDependencies = {},
): Promise<ConfirmBookingResult> {
  const rawAccessToken = randomBytes(32).toString('base64url');
  const accessTokenHash = hashAccessToken(rawAccessToken);
  const accessTokenExpiresAt = computeAccessTokenExpiry(input.datetime);

  const session =
    dependencies.mongoSession ?? (await mongoose.startSession());
  const ownsSession = !dependencies.mongoSession;

  try {
    let bookingId = '';

    await session.withTransaction(async () => {
      const confirmed = await confirmHeldSlot(
        slotId,
        input.businessId,
        holdVersion,
        session,
      );

      if (!confirmed) {
        throw new AppError(
          409,
          'SLOT_HOLD_EXPIRED',
          'The slot hold has expired. Please select the slot again.',
        );
      }

      const booking = await BookingModel.create(
        [
          {
            businessId: input.businessId,
            slotId,
            customer: {
              name: input.customer.name.trim(),
              contactType: input.customer.contactType,
              contact: normalizeContact(
                input.customer.contactType,
                input.customer.contact,
              ),
            },
            createdBy: input.createdBy,
            status: 'confirmed',
            accessTokenHash,
            accessTokenExpiresAt,
            noShowRiskNote: null,
            cancelledAt: null,
          },
        ],
        { session },
      );

      bookingId = String(booking[0]._id);
    });

    // ---- strictly post-commit (§4e) ----
    await emitBookingConfirmationUpdate(
      input.businessId,
      input.providerId,
      input.providerType,
      input.serviceId,
      input.datetime,
    );

    try {
      await deleteRedisHold(slotId, input.sessionId, holdVersion);
    } catch {
      // Best effort — the Redis TTL removes it anyway.
    }

    void enqueueNoShowScoring(bookingId).catch((error: unknown) => {
      logger.warn(
        { err: error, bookingId },
        'failed to enqueue no-show scoring',
      );
    });

    enqueueBookingEmails({
      kind: 'confirmation',
      contactType: input.customer.contactType,
      contact: normalizeContact(
        input.customer.contactType,
        input.customer.contact,
      ),
      bookingId,
      accessToken: rawAccessToken,
      slotDatetime: input.datetime,
    });

    return { bookingId, accessToken: rawAccessToken };
  } finally {
    if (ownsSession) {
      await session.endSession();
    }
  }
}

/**
 * Confirms a booking in one call — claim + Redis hold + confirm. Used by
 * the authenticated staff/self-service path. External Redis operations
 * happen outside the Mongo transaction.
 */
export async function confirmBooking(
  input: ConfirmBookingInput,
  dependencies: BookingServiceDependencies = {},
): Promise<ConfirmBookingResult> {
  const { slotId, holdVersion } = await claimAndHold(input);

  // Verify the Redis hold (authorization) before the transaction (§4).
  const hold = await readRedisHold(slotId);

  if (
    !hold ||
    hold.sessionId !== input.sessionId ||
    hold.holdVersion !== holdVersion
  ) {
    throw new AppError(
      409,
      'SLOT_HOLD_EXPIRED',
      'The slot hold has expired. Please select the slot again.',
    );
  }

  return finalizeConfirmation(slotId, holdVersion, input, dependencies);
}

export interface HoldSlotForCustomerInput {
  businessId: string;
  providerId: string;
  providerType: ProviderType;
  serviceId: string;
  datetime: Date | string;
  sessionId: string;
}

export interface HoldSlotForCustomerResult {
  /** ISO timestamp the Redis hold expires at — drives the client countdown. */
  heldUntil: string;
}

/**
 * Anonymous customer step 1 (architecture doc §13a `POST /api/bookings/hold`):
 * atomically claims one available unit for the (provider, datetime,
 * service) bucket and pairs it with a Redis TTL hold fenced to this
 * browser's `sessionId`. Returns only when a customer has a real hold —
 * `claimAndHold` throws `409 SLOT_NOT_AVAILABLE` otherwise, which the
 * caller surfaces as "offer the waitlist".
 */
export async function holdSlotForCustomer(
  input: HoldSlotForCustomerInput,
): Promise<HoldSlotForCustomerResult> {
  await claimAndHold({
    ...input,
    // claimAndHold only reads the slot-identifying tuple + sessionId.
    customer: { name: '', contactType: 'email', contact: '' },
    createdBy: null,
  });

  return {
    heldUntil: new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString(),
  };
}

export interface ConfirmCustomerBookingInput {
  businessId: string;
  providerId: string;
  providerType: ProviderType;
  serviceId: string;
  datetime: Date | string;
  sessionId: string;
  customer: {
    name: string;
    contactType: ContactType;
    contact: string;
  };
}

/**
 * Anonymous customer step 2 (architecture doc §13a `POST /api/bookings/confirm`):
 * finds the `held` slot in this (provider, datetime, service) bucket
 * whose Redis hold belongs to this `sessionId`, then runs the shared
 * `finalizeConfirmation`. The client never knows a `slotId` (§4b), so
 * the held slot is re-resolved here from the tuple + the fenced Redis
 * hold rather than trusted from the request.
 */
export async function confirmCustomerBooking(
  input: ConfirmCustomerBookingInput,
): Promise<ConfirmBookingResult> {
  const heldSlots = await listHeldSlotsForBucket(
    input.businessId,
    input.providerId,
    input.providerType,
    input.serviceId,
    input.datetime,
  );

  for (const heldSlot of heldSlots) {
    const hold = await readRedisHold(heldSlot.slotId);
    if (hold && hold.sessionId === input.sessionId) {
      return finalizeConfirmation(heldSlot.slotId, hold.holdVersion, {
        ...input,
        createdBy: null,
      });
    }
  }

  throw new AppError(
    409,
    'SLOT_HOLD_EXPIRED',
    'Your hold on this slot has expired. Please pick a time again.',
  );
}


export async function createWalkInBooking(
  input: WalkInBookingInput,
): Promise<{ bookingId: string }> {
  const parsedDatetime = new Date(input.datetime);

  if (Number.isNaN(parsedDatetime.getTime())) {
    throw new AppError(
      400,
      'INVALID_REQUEST',
      'Invalid booking datetime.',
    );
  }

  const confirmedSlot = await confirmAvailableSlot(
    input.businessId,
    input.providerId,
    input.providerType,
    input.serviceId,
    parsedDatetime,
  );

  if (!confirmedSlot) {
    throw new AppError(
      409,
      'SLOT_NOT_AVAILABLE',
      'The selected slot is no longer available.',
    );
  }

  const booking = await BookingModel.create({
    businessId: input.businessId,
    slotId: confirmedSlot.slotId,
    customer: {
      name: input.customer.name.trim(),
      contactType: input.customer.contactType,
      contact: normalizeContact(
        input.customer.contactType,
        input.customer.contact,
      ),
    },
    createdBy: input.createdBy,
    status: 'confirmed',
    accessTokenHash: undefined,
    accessTokenExpiresAt: null,
    noShowRiskNote: null,
    cancelledAt: null,
  });

  const bookingId = String(booking._id);

  /*
   * A walk-in is a confirmed Booking too, so it gets scored the same
   * way (architecture doc §10: "customer self-service and staff/owner
   * walk-ins alike"). Fire-and-forget, after the write.
   */
  void enqueueNoShowScoring(bookingId).catch((error: unknown) => {
    logger.warn(
      { err: error, bookingId },
      'failed to enqueue no-show scoring',
    );
  });

  return {
    bookingId,
  };
}

export interface CancelBookingResult {
  bookingId: string;
  slotId: string;
}

export async function cancelBooking(
  businessId: string,
  bookingId: string,
  dependencies: BookingServiceDependencies = {},
): Promise<CancelBookingResult> {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    throw new AppError(
      404,
      'BOOKING_NOT_FOUND',
      'Booking not found.',
    );
  }

  const session =
    dependencies.mongoSession ??
    await mongoose.startSession();

  const ownsSession = !dependencies.mongoSession;

  try {
    const tx = await session.withTransaction(async () => {
    const existingBooking = await BookingModel.findOne({
      _id: bookingId,
      businessId,
    })
      .select({ _id: 1, slotId: 1, status: 1, customer: 1 })
      .session(session)
      .lean();

    if (!existingBooking) {
      throw new AppError(
        404,
        'BOOKING_NOT_FOUND',
        'Booking not found.',
      );
    }

    if (existingBooking.status !== 'confirmed') {
      throw new AppError(
        409,
        'BOOKING_NOT_CANCELLABLE',
        'The booking is no longer cancellable.',
      );
    }

    const booking = await BookingModel.findOneAndUpdate(
      {
        _id: bookingId,
        businessId,
        status: 'confirmed',
      },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
        },
      },
      {
        session,
        new: false,
      },
    )
      .select({ _id: 1, slotId: 1 })
      .lean();

    if (!booking) {
      throw new AppError(
        409,
        'BOOKING_NOT_CANCELLABLE',
        'The booking is no longer cancellable.',
      );
    }

    const released = await cancelConfirmedSlot(
      String(booking.slotId),
      businessId,
      session,
    );

    if (!released) {
      throw new AppError(
        409,
        'BOOKING_SLOT_CONFLICT',
        'The booking slot could not be released.',
      );
    }

    return {
      slotId: String(booking.slotId),
      customer: {
        contactType: existingBooking.customer.contactType,
        contact: existingBooking.customer.contact,
      },
    };
    });

    const cancelledSlotId = tx.slotId;
    const cancelledCustomer = tx.customer;

    /*
     * Mongo committed successfully.
     * Everything below is an external side effect.
     */
    const slot = await getSlotById(
      businessId,
      cancelledSlotId,
    );

    if (slot) {
      await emitBookingConfirmationUpdate(
        businessId,
        slot.providerId,
        slot.providerType,
        slot.serviceId,
        slot.datetime,
      );
    }

    /*
     * Waitlist notification is deliberately after commit.
     * The waitlist module owns matching/notification behavior.
     */
    void notifyNextWaitlistEntry(
      businessId,
      cancelledSlotId,
    );

    // Cancellation email (§6/§8) — post-commit, best-effort.
    enqueueBookingEmails({
      kind: 'cancellation',
      contactType: cancelledCustomer.contactType,
      contact: cancelledCustomer.contact,
      bookingId,
    });

    return {
      bookingId,
      slotId: cancelledSlotId,
    };
  } finally {
    if (ownsSession) {
      await session.endSession();
    }
  }
}

export type BookingOutcome = 'completed' | 'no-show';

export interface UpdateBookingOutcomeResult {
  bookingId: string;
  status: BookingOutcome;
}

export async function updateBookingOutcome(
  businessId: string,
  bookingId: string,
  status: BookingOutcome,
): Promise<UpdateBookingOutcomeResult> {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    throw new AppError(
      404,
      'BOOKING_NOT_FOUND',
      'Booking not found.',
    );
  }

  const booking = await BookingModel.findOneAndUpdate(
    {
      _id: bookingId,
      businessId,
      status: 'confirmed',
    },
    {
      $set: {
        status,
      },
    },
    {
      new: true,
    },
  )
    .select({ _id: 1, status: 1 })
    .lean();

  if (!booking) {
    const existingBooking = await BookingModel.findOne({
      _id: bookingId,
      businessId,
    })
      .select({ _id: 1 })
      .lean();

    if (!existingBooking) {
      throw new AppError(
        404,
        'BOOKING_NOT_FOUND',
        'Booking not found.',
      );
    }

    throw new AppError(
      409,
      'BOOKING_OUTCOME_NOT_ALLOWED',
      'The booking is no longer awaiting an outcome.',
    );
  }

  return {
    bookingId: String(booking._id),
    status: booking.status as BookingOutcome,
  };
}

export interface RescheduleBookingInput {
  businessId: string;
  bookingId: string;
  providerId: string;
  providerType: ProviderType;
  serviceId: string;
  datetime: Date | string;
}

export interface RescheduleBookingResult {
  bookingId: string;
  oldSlotId: string;
  newSlotId: string;
  datetime: string;
}

export async function rescheduleBooking(
  input: RescheduleBookingInput,
  dependencies: BookingServiceDependencies = {},
): Promise<RescheduleBookingResult> {
  if (!mongoose.Types.ObjectId.isValid(input.bookingId)) {
    throw new AppError(
      404,
      'BOOKING_NOT_FOUND',
      'Booking not found.',
    );
  }

  const session =
    dependencies.mongoSession ??
    await mongoose.startSession();

  const ownsSession = !dependencies.mongoSession;

  try {
    const result = await session.withTransaction(
  async (): Promise<
    RescheduleBookingResult & {
      customer: { contactType: ContactType; contact: string };
    }
  > => {
    const booking = await BookingModel.findOne({
      _id: input.bookingId,
      businessId: input.businessId,
    })
      .select({ _id: 1, slotId: 1, status: 1, customer: 1, accessTokenHash: 1 })
      .session(session)
      .lean();

    if (!booking) {
      throw new AppError(
        404,
        'BOOKING_NOT_FOUND',
        'Booking not found.',
      );
    }

    if (booking.status !== 'confirmed') {
      throw new AppError(
        409,
        'BOOKING_NOT_RESCHEDULABLE',
        'The booking is no longer reschedulable.',
      );
    }

    const oldSlotId = String(booking.slotId);

    const slotResult = await rescheduleConfirmedSlots(
      input.businessId,
      oldSlotId,
      input.providerId,
      input.providerType,
      input.serviceId,
      input.datetime,
      session,
    );

    if (!slotResult) {
      throw new AppError(
        409,
        'SLOT_NOT_AVAILABLE',
        'The selected slot is no longer available.',
      );
    }

    // §9a: the magic-link expiry is anchored to the appointment, so it
    // moves with the booking — recomputed against the new slot here.
    const bookingUpdate: Record<string, unknown> = {
      slotId: slotResult.newSlotId,
    };
    if (booking.accessTokenHash) {
      bookingUpdate.accessTokenExpiresAt = computeAccessTokenExpiry(
        slotResult.newDatetime,
      );
    }

    const updatedBooking = await BookingModel.findOneAndUpdate(
      {
        _id: input.bookingId,
        businessId: input.businessId,
        status: 'confirmed',
        slotId: booking.slotId,
      },
      {
        $set: bookingUpdate,
      },
      {
        session,
        new: true,
      },
    )
      .select({ _id: 1 })
      .lean();

    if (!updatedBooking) {
      throw new AppError(
        409,
        'BOOKING_NOT_RESCHEDULABLE',
        'The booking could not be rescheduled.',
      );
    }

    return {
      bookingId: input.bookingId,
      oldSlotId,
      newSlotId: slotResult.newSlotId,
      datetime: slotResult.newDatetime.toISOString(),
      customer: {
        contactType: booking.customer.contactType,
        contact: booking.customer.contact,
      },
    };
  },
);

    const rescheduledCustomer = result.customer;

    /*
     * Mongo committed. Realtime updates happen only now.
     *
     * We emit the old and new buckets separately because the customer
     * availability view needs both sides of the move reflected.
     */
    const oldSlot = await getSlotById(
      input.businessId,
      result.oldSlotId,
    );

    if (oldSlot) {
      await emitBookingConfirmationUpdate(
        input.businessId,
        oldSlot.providerId,
        oldSlot.providerType,
        oldSlot.serviceId,
        oldSlot.datetime,
      );
    }

    await emitBookingConfirmationUpdate(
      input.businessId,
      input.providerId,
      input.providerType,
      input.serviceId,
      input.datetime,
    );

    void notifyNextWaitlistEntry(
      input.businessId,
      result.oldSlotId,
    );

    // Reschedule email + refreshed reminders (§6/§8) — post-commit.
    enqueueBookingEmails({
      kind: 'reschedule',
      contactType: rescheduledCustomer.contactType,
      contact: rescheduledCustomer.contact,
      bookingId: result.bookingId,
      slotDatetime: result.datetime,
    });

    // Strip the internal `customer` field — responses are an explicit
    // allowlist (§13), never a passthrough of the service's own shape.
    return {
      bookingId: result.bookingId,
      oldSlotId: result.oldSlotId,
      newSlotId: result.newSlotId,
      datetime: result.datetime,
    };

  } finally {

    if (ownsSession) {
      await session.endSession();
    }

  }
}

export async function listBookings(
  businessId: string,
): Promise<BookingListItem[]> {
  const bookings = await BookingModel.find({
    businessId,
  })
    .sort({ createdAt: -1 })
    .lean();

  return bookings.map((booking) => ({
    id: String(booking._id),
    businessId: booking.businessId,
    slotId: booking.slotId,
    customer: {
      name: booking.customer.name,
      contactType: booking.customer.contactType,
      contact: booking.customer.contact,
    },
    createdBy: booking.createdBy,
    status: booking.status,
    accessTokenExpiresAt:
      booking.accessTokenExpiresAt?.toISOString() ?? null,
    noShowRiskNote: booking.noShowRiskNote,
    createdAt: booking.createdAt.toISOString(),
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
  }));
}

export async function getBookingForCustomer(
  bookingId: string,
): Promise<{
  // Customer/magic-link projection — `noShowRiskNote` is staff/owner-
  // only and must never appear in a customer response payload, at the
  // serialization layer, not just the frontend (architecture doc
  // §10/§13).
  booking: Omit<BookingListItem, 'noShowRiskNote'>;
  slot: Awaited<ReturnType<typeof getSlotById>>;
  // Public slug of the owning business — lets the customer manage page
  // query the public availability endpoint when rescheduling, without
  // exposing anything the slug in the booking URL didn't already.
  businessSlug: string | null;
}> {
  const booking = await BookingModel.findById(bookingId).lean();

  if (!booking) {
    throw new AppError(
      404,
      'BOOKING_NOT_FOUND',
      'Booking not found.',
    );
  }

  const slot = await getSlotById(
    booking.businessId,
    booking.slotId,
  );

  if (!slot) {
    throw new AppError(
      404,
      'BOOKING_NOT_FOUND',
      'Booking not found.',
    );
  }

  const business = await getBusinessById(booking.businessId);

  return {
    booking: {
      id: String(booking._id),
      businessId: booking.businessId,
      slotId: booking.slotId,
      customer: {
        name: booking.customer.name,
        contactType: booking.customer.contactType,
        contact: booking.customer.contact,
      },
      createdBy: booking.createdBy,
      status: booking.status,
      accessTokenExpiresAt:
        booking.accessTokenExpiresAt?.toISOString() ?? null,
      // noShowRiskNote deliberately omitted — customer-tier projection.
      createdAt: booking.createdAt.toISOString(),
      cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    },
    slot,
    businessSlug: business?.slug ?? null,
  };
}

export interface BookingScoringContext {
  businessId: string;
  slotId: string;
  customer: {
    name: string;
    contactType: ContactType;
    contact: string;
  };
  createdAt: Date;
  noShowRiskNote: string | null;
}

/**
 * Minimal booking projection the no-show scoring job (architecture doc
 * §10) needs. Lives here so the `noshow` module never touches
 * `BookingModel` directly — it orchestrates and calls Gemini; this
 * module owns every read and write of the collection.
 */
export async function getBookingScoringContext(
  bookingId: string,
): Promise<BookingScoringContext | null> {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    return null;
  }

  const booking = await BookingModel.findById(bookingId)
    .select({
      businessId: 1,
      slotId: 1,
      customer: 1,
      createdAt: 1,
      noShowRiskNote: 1,
    })
    .lean();

  if (!booking) {
    return null;
  }

  return {
    businessId: booking.businessId,
    slotId: booking.slotId,
    customer: {
      name: booking.customer.name,
      contactType: booking.customer.contactType,
      contact: booking.customer.contact,
    },
    createdAt: booking.createdAt,
    noShowRiskNote: booking.noShowRiskNote,
  };
}

export interface CustomerBookingStats {
  totalPast: number;
  confirmedCount: number;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
}

/**
 * Aggregated booking history for "the same customer" — matched by
 * `customer.contact` within a single `businessId` only (architecture
 * doc §10: no cross-tenant identity resolution). `excludeBookingId`
 * drops the booking currently being scored from its own history.
 */
export async function getCustomerBookingStats(
  businessId: string,
  contactType: ContactType,
  contact: string,
  excludeBookingId?: string,
): Promise<CustomerBookingStats> {
  const match: Record<string, unknown> = {
    businessId,
    'customer.contact': normalizeContact(contactType, contact),
  };

  if (
    excludeBookingId &&
    mongoose.Types.ObjectId.isValid(excludeBookingId)
  ) {
    match._id = { $ne: new mongoose.Types.ObjectId(excludeBookingId) };
  }

  const rows = await BookingModel.aggregate<{
    _id: string;
    count: number;
  }>([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const byStatus = new Map(rows.map((row) => [row._id, row.count]));

  const confirmedCount = byStatus.get('confirmed') ?? 0;
  const completedCount = byStatus.get('completed') ?? 0;
  const cancelledCount = byStatus.get('cancelled') ?? 0;
  const noShowCount = byStatus.get('no-show') ?? 0;

  return {
    totalPast:
      confirmedCount + completedCount + cancelledCount + noShowCount,
    confirmedCount,
    completedCount,
    cancelledCount,
    noShowCount,
  };
}

/**
 * Compute-once conditional write for the no-show risk note
 * (architecture doc §10). Filtered on `noShowRiskNote: null`, never an
 * unconditional `$set`, so a duplicated/retried scoring job is a safe
 * no-op. Returns whether this call is the one that landed the note. No
 * `Booking.status` re-check: writing this field has no externally-
 * visible effect, so "written at most once" is the only invariant to
 * protect.
 */
export async function persistNoShowRiskNote(
  bookingId: string,
  note: string,
): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    return false;
  }

  const updated = await BookingModel.findOneAndUpdate(
    { _id: bookingId, noShowRiskNote: null },
    { $set: { noShowRiskNote: note } },
    { new: false },
  )
    .select({ _id: 1 })
    .lean();

  return updated !== null;
}