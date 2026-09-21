/**
 * Mongoose schema for the Slots module.
 *
 * A `Slot` is a bookable time unit generated from a
 * `ProviderAvailability` template by `generateWeeklySlots`. Slots are
 * a separate collection from their template, so editing the template
 * doesn't touch already-generated slots.
 */

import { Schema, model } from 'mongoose';

import type { ProviderType } from '@queueless/shared-types';

export type SlotStatus =
  | 'available'
  | 'held'
  | 'confirmed'
  | 'cancelled'
  | 'blocked';

export interface SlotDocument {
  /** Owning business — every query is scoped by this. */
  businessId: string;
  /** Ref to a Users row (staff) or a Resources row (resource). */
  providerId: string;
  /** Which collection `providerId` refers to. */
  providerType: ProviderType;
  /** The service this slot was generated for. */
  serviceId: string;
  /** UTC instant this slot starts at. */
  datetime: Date;
  /** Snapshotted from Service.durationMinutes once at generation time; never updated after. */
  durationMinutes: number;
  /** 0 for a staff provider; 0..capacity-1 for a resource's parallel units. */
  unitIndex: number;
  status: SlotStatus;
  /** Fencing token for the hold/confirm flow. Non-null only while status is 'held'. */
  holdVersion: string | null;
  /** Identifies which session currently holds this slot, to enforce one hold per session. */
  heldBySessionId: string | null;
  /** If reserved for a waitlist entry, the entry ID. */
  reservedForWaitlistEntryId: string | null;
  /** Secure unguessable token required to claim this reserved slot. */
  reservedForWaitlistToken: string | null;
  /** Optimistic-concurrency counter for non-booking edits; unused by this module. */
  version: number;
}

const slotSchema = new Schema<SlotDocument>(
  {
    businessId: {
      type: String,
      required: true,
    },

    providerId: {
      type: String,
      required: true,
    },

    providerType: {
      type: String,
      enum: ['staff', 'resource'],
      required: true,
    },

    serviceId: {
      type: String,
      required: true,
    },

    datetime: {
      type: Date,
      required: true,
    },

    durationMinutes: {
      type: Number,
      required: true,
    },

    unitIndex: {
      type: Number,
      required: true,
      default: 0,
    },

    status: {
      type: String,
      enum: ['available', 'held', 'confirmed', 'cancelled', 'blocked'],
      required: true,
      default: 'available',
    },

    holdVersion: {
      type: String,
      default: null,
    },

    heldBySessionId: {
      type: String,
      default: null,
    },

    reservedForWaitlistEntryId: {
      type: String,
      default: null,
    },

    reservedForWaitlistToken: {
      type: String,
      default: null,
    },

    version: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Guards against duplicate slot generation. serviceId is excluded
// since a provider can't hold two slots at the same instant regardless
// of service.
slotSchema.index(
  { businessId: 1, providerId: 1, providerType: 1, datetime: 1, unitIndex: 1 },
  { unique: true },
);

// Enforces one active hold per session within a business.
slotSchema.index(
  { businessId: 1, heldBySessionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'held',
      heldBySessionId: { $type: 'string' },
    },
  },
);

// Speeds up the hot-path claim query.
slotSchema.index({
  businessId: 1,
  providerId: 1,
  providerType: 1,
  datetime: 1,
  status: 1,
});

/**
 * Mongoose model for slots. Only the Slots service layer touches
 * this directly; other modules go through `./index.ts`.
 */
export const SlotModel = model<SlotDocument>('Slot', slotSchema);
