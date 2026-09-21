import { randomBytes } from 'node:crypto';
import { AppError } from '../../lib/Apperror.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSlotById, reserveSlotForWaitlist, releaseWaitlistReservation } from '../slots/index.js';
import { getBusinessById } from '../tenants/index.js';
import { sendEmail } from '../notifications/index.js';
import {
  WaitlistEntryModel,
  type WaitlistStatus,
} from './waitlist.model.js';
import { jobsQueue } from '../../lib/queue.js';

const WAITLIST_NOTIFICATION_TTL_MS = 15 * 60 * 1000;
const WAITLIST_EXPIRE_CHECK_JOB = 'waitlist-expire-check';

export interface JoinWaitlistInput {
  businessId: string;

  customer: {
    name: string;
    contact: string;
  };

  desiredServiceId: string;
  desiredProviderId?: string;
}

export interface WaitlistEntryItem {
  id: string;
  businessId: string;
  customer: {
    name: string;
    contact: string;
  };
  desiredServiceId: string;
  desiredProviderId: string | null;
  status: WaitlistStatus;
  createdAt: string;
}

function toWaitlistItem(
  entry: WaitlistEntryDocumentLike,
): WaitlistEntryItem {
  return {
    id: String(entry._id),
    businessId: entry.businessId,
    customer: {
      name: entry.customer.name,
      contact: entry.customer.contact,
    },
    desiredServiceId: entry.desiredServiceId,
    desiredProviderId: entry.desiredProviderId ?? null,
    status: entry.status,
    createdAt: entry.createdAt.toISOString(),
  };
}

type WaitlistEntryDocumentLike = {
  _id: unknown;
  businessId: string;
  customer: {
    name: string;
    contact: string;
  };
  desiredServiceId: string;
  desiredProviderId?: string;
  status: WaitlistStatus;
  createdAt: Date;
};

/**
 * Adds a customer to the FIFO waitlist.
 */
export async function joinWaitlist(
  input: JoinWaitlistInput,
): Promise<WaitlistEntryItem> {
  const name = input.customer.name.trim();
  const contact = input.customer.contact.trim();

  if (!name || !contact) {
    throw new AppError(
      400,
      'INVALID_CUSTOMER',
      'Customer name and contact are required.',
    );
  }

  if (!input.desiredServiceId) {
    throw new AppError(
      400,
      'INVALID_SERVICE',
      'A desired service is required.',
    );
  }

  const entry = await WaitlistEntryModel.create({
    businessId: input.businessId,
    customer: {
      name,
      contact,
    },
    desiredServiceId: input.desiredServiceId,
    desiredProviderId: input.desiredProviderId,
    status: 'waiting',
  });

  return toWaitlistItem(entry);
}

/**
 * Lists active waitlist entries for a business.
 * FIFO order is preserved.
 */
export async function listWaitlist(
  businessId: string,
): Promise<WaitlistEntryItem[]> {
  const entries = await WaitlistEntryModel.find({
    businessId,
    status: {
      $in: ['waiting', 'notified'],
    },
  })
    .sort({ createdAt: 1 })
    .lean();

  return entries.map(toWaitlistItem);
}

/**
 * Finds the next waiting customer for a slot.
 *
 * Matching:
 * - same business
 * - same service
 * - optional provider preference must match exactly
 * - FIFO by createdAt
 *
 * This function only identifies the candidate. It does not reserve
 * the slot and does not send a notification.
 */
export async function findNextMatchingWaitlistEntry(
  businessId: string,
  slotId: string,
): Promise<WaitlistEntryItem | null> {
  const slot = await getSlotById(businessId, slotId);

  if (!slot || slot.status !== 'available') {
    return null;
  }

  const entry = await WaitlistEntryModel.findOne({
    businessId,
    desiredServiceId: slot.serviceId,
    status: 'waiting',
    $or: [
      { desiredProviderId: slot.providerId },
      { desiredProviderId: { $exists: false } },
    ],
  })
    .sort({ createdAt: 1 })
    .lean();

  if (!entry) {
    return null;
  }

  return toWaitlistItem(entry);
}

/**
 * Marks one waitlist entry as notified.
 *
 * The conditional status check prevents two workers from notifying
 * the same waiting entry concurrently.
 */
export async function markWaitlistEntryNotified(
  entryId: string,
): Promise<WaitlistEntryItem | null> {
  const entry = await WaitlistEntryModel.findOneAndUpdate(
    {
      _id: entryId,
      status: 'waiting',
    },
    {
      $set: {
        status: 'notified',
        notifiedAt: new Date(),
      },
    },
    {
      new: true,
    },
  ).lean();

  if (!entry) {
    return null;
  }

  await jobsQueue.add(
  WAITLIST_EXPIRE_CHECK_JOB,
  {
    entryId: String(entry._id),
  },
  {
    delay: WAITLIST_NOTIFICATION_TTL_MS,
    removeOnComplete: true,
    removeOnFail: false,
  },
);

  return toWaitlistItem(entry);
}

export async function expireWaitlistEntry(
  entryId: string,
): Promise<boolean> {
  const result = await WaitlistEntryModel.findOneAndUpdate(
    {
      _id: entryId,
      status: 'notified',
    },
    {
      $set: {
        status: 'expired',
      },
      $unset: {
        notifiedAt: 1,
      },
    },
    {
      new: false,
    },
  )
    .select({ _id: 1 })
    .lean();

  const releasedSlot = await releaseWaitlistReservation(entryId);
  if (releasedSlot) {
    // Pass it to the next person in line
    void notifyNextWaitlistEntry(releasedSlot.businessId, releasedSlot.slotId);
  }

  return Boolean(result);
}

/**
 * The Phase 3 "trigger on slot release": finds the next matching
 * waiting entry for a slot that just came back to 'available' and
 * notifies them by email, marking the entry 'notified' so a second
 * concurrent release for the same slot doesn't re-notify. Best-effort
 * and never throws — a missed notification here just means this entry
 * stays 'waiting' and is picked up by the next matching opening
 * instead (architecture doc §6), same as everywhere else in this
 * project that treats notifications as best-effort, not guaranteed.
 *
 * This is the Phase 3 foundation for what `waitlist-notify` (the
 * BullMQ job, Phase 4) eventually replaces — a synchronous call for
 * now, since the job queue isn't wired to this trigger yet.
 */
export async function notifyNextWaitlistEntry(
  businessId: string,
  slotId: string,
): Promise<void> {
  try {
    const candidate = await findNextMatchingWaitlistEntry(businessId, slotId);
    if (!candidate) return;

    const marked = await markWaitlistEntryNotified(candidate.id);
    if (!marked) return;

    const token = randomBytes(32).toString('base64url');
    const reserved = await reserveSlotForWaitlist(businessId, slotId, marked.id, token);
    if (!reserved) return;

    const business = await getBusinessById(businessId);
    if (!business) return;

    await sendEmail({
      to: marked.customer.contact,
      subject: 'A slot just opened up',
      text: `Good news — a slot you're waiting for is available again. Book it soon before it's taken: ${env.FRONTEND_URL}/b/${business.slug}?waitlistToken=${token}`,
    });
  } catch (error) {
    logger.warn({ err: error, businessId, slotId }, 'waitlist notify failed');
  }
}