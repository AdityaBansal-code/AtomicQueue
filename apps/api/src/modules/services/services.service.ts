import mongoose, { type ClientSession } from 'mongoose';

import type { Service } from '@queueless/shared-types';
import { redis } from '../../lib/redis.js';

import {
  blockAndCancelFutureSlotsForService,
  emitBulkSlotUpdates,
  type SlotStatus,
} from '../slots/index.js';
import { removeAvailabilityForService } from '../availability/index.js';

import { ServiceModel } from './services.model.js';

/**
 * Input required to create a service (something a business offers
 * for customers to book, e.g. "Badminton Court").
 */
export interface CreateServiceInput {
  businessId: string;
  name: string;
  durationMinutes: number;
  price: number;
}

/**
 * Creates a new service. isActive defaults to true via the schema.
 */
export async function createService(
  input: CreateServiceInput,
): Promise<Service> {
  const service = await ServiceModel.create({
    businessId: input.businessId,
    name: input.name,
    durationMinutes: input.durationMinutes,
    price: input.price,
  });

  try {
    await redis.del('cache:public:businesses:default');
  } catch {}

  return {
    id: String(service._id),
    businessId: service.businessId,
    name: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    isActive: service.isActive,
  };
}

/**
 * Gets all services belonging to a business.
 */
export async function getServices(
  businessId: string,
): Promise<Service[]> {
  const services = await ServiceModel.find({ businessId }).lean();

  return services.map((service) => ({
    id: String(service._id),
    businessId: service.businessId,
    name: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    isActive: service.isActive,
  }));
}

/**
 * Input required to update an existing service.
 *
 * `isActive` is deliberately not settable here — deactivating/
 * reactivating a service has to go through
 * `deactivateService`/`reactivateService` so the deactivation cascade
 * (architecture doc §2c) can never be bypassed by a plain field patch.
 */
export interface UpdateServiceInput {
  businessId: string;
  serviceId: string;
  name?: string;
  durationMinutes?: number;
  price?: number;
}

/**
 * Updates an existing service. Returns null if no service matches
 * both the ID and businessId.
 */
export async function updateService(
  input: UpdateServiceInput,
): Promise<Service | null> {
  const service = await ServiceModel.findOneAndUpdate(
    {
      _id: input.serviceId,
      businessId: input.businessId,
    },
    {
      name: input.name,
      durationMinutes: input.durationMinutes,
      price: input.price,
    },
    { new: true },
  );

  if (!service) {
    return null;
  }

  try {
    await redis.del('cache:public:businesses:default');
  } catch {}

  return {
    id: String(service._id),
    businessId: service.businessId,
    name: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    isActive: service.isActive,
  };
}

/**
 * Deactivates a service: one transaction, four effects (architecture
 * doc §2c):
 *   1. `Services.isActive: true -> false`
 *   2. Future `available` Slots for this service -> `'blocked'`
 *      (not cancelled — a deliberately different terminal status than
 *      the resource/staff-removal case, since a service being turned
 *      off doesn't mean its provider is going away).
 *   3. Future `held` Slots for this service -> `'cancelled'`,
 *      `holdVersion` cleared.
 *   4. `ProviderAvailability` rows referencing this service
 *      hard-deleted — no new slots generate against it going forward.
 *
 * Future `confirmed` Slots/Bookings are left untouched. Ongoing
 * enforcement beyond this one-time cascade needs no extra code here:
 * `generateWeeklySlots` already re-checks `Services.isActive` live on
 * every run, and once available slots for this service are `'blocked'`,
 * `claimSlot`/`confirmAvailableSlot` (which only match `status:
 * 'available'`) simply stop matching them.
 *
 * Returns `null` if the service doesn't exist or is already inactive
 * (idempotent no-op, no transaction opened in that case).
 */
export async function deactivateService(
  businessId: string,
  serviceId: string,
  dependencies: { mongoSession?: ClientSession } = {},
): Promise<Service | null> {
  const existing = await ServiceModel.findOne({
    _id: serviceId,
    businessId,
    isActive: true,
  }).lean();

  if (!existing) {
    return null;
  }

  const session = dependencies.mongoSession ?? (await mongoose.startSession());
  const ownsSession = !dependencies.mongoSession;

  try {
    let result: Service | null = null;
    let affected: { slotId: string; status: SlotStatus }[] = [];

    await session.withTransaction(async () => {
      await removeAvailabilityForService(businessId, serviceId, session);

      const slotResult = await blockAndCancelFutureSlotsForService(
        businessId,
        serviceId,
        session,
      );
      affected = slotResult.affected;

      const service = await ServiceModel.findOneAndUpdate(
        { _id: serviceId, businessId, isActive: true },
        { isActive: false },
        { session, new: true },
      );

      result = service
        ? {
            id: String(service._id),
            businessId: service.businessId,
            name: service.name,
            durationMinutes: service.durationMinutes,
            price: service.price,
            isActive: service.isActive,
          }
        : null;
    });

    // Post-commit only.
    emitBulkSlotUpdates(businessId, affected);

    try {
      await redis.del('cache:public:businesses:default');
    } catch {}

    return result;
  } finally {
    if (ownsSession) {
      await session.endSession();
    }
  }
}

/**
 * Reactivates a previously deactivated service. A separate, explicit,
 * non-cascading action (architecture doc §2c): flips `isActive` back
 * to `true` only. Resurrects nothing — previously `blocked`/`cancelled`
 * Slots stay exactly as they are, and the deleted `ProviderAvailability`
 * is not restored; the owner reconfigures availability from scratch.
 *
 * Returns `null` if the service doesn't exist or is already active.
 */
export async function reactivateService(
  businessId: string,
  serviceId: string,
): Promise<Service | null> {
  const service = await ServiceModel.findOneAndUpdate(
    { _id: serviceId, businessId, isActive: false },
    { isActive: true },
    { new: true },
  );

  if (!service) {
    return null;
  }

  return {
    id: String(service._id),
    businessId: service.businessId,
    name: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    isActive: service.isActive,
  };
}

/**
 * Per-business summary of a tenant's active services — count, the
 * service names, and the lowest price — keyed by `businessId`, across
 * every tenant.
 *
 * The one read the public business directory (`GET /api/businesses`)
 * needs: to show "N services", a few service-name chips and a "from $X"
 * on a card, and to hide businesses with nothing bookable (only tenants
 * with >= 1 active service get a map entry). Deliberately not
 * business-scoped — it's the only caller and it wants every tenant at
 * once, same shape/rationale as the tenants module's `listBusinessIds`
 * (used by the slot-generation job).
 *
 * Every field here is already public per-service data (the same names
 * and prices `GET /api/businesses/:slug/services` returns); this is a
 * cross-tenant roll-up of it, not a new disclosure.
 */
export interface ActiveServiceSummary {
  count: number;
  /** Active service names, cheapest first (caller trims for display). */
  names: string[];
  /** Lowest active-service price for the business. */
  priceFrom: number;
}

export async function getActiveServiceSummaryByBusiness(): Promise<
  Map<string, ActiveServiceSummary>
> {
  const rows = await ServiceModel.aggregate<
    { _id: string } & ActiveServiceSummary
  >([
    { $match: { isActive: true } },
    // Cheapest-first, then name — so `names` reads sensibly next to
    // `priceFrom` and the order is deterministic across requests.
    { $sort: { price: 1, name: 1 } },
    {
      $group: {
        _id: '$businessId',
        count: { $sum: 1 },
        names: { $push: '$name' },
        priceFrom: { $min: '$price' },
      },
    },
  ]);

  return new Map(
    rows.map((row) => [
      row._id,
      { count: row.count, names: row.names, priceFrom: row.priceFrom },
    ]),
  );
}

/**
 * Gets one service by ID, scoped to a business. Returns null if not found.
 */
export async function getServiceById(
  businessId: string,
  serviceId: string,
): Promise<Service | null> {
  const service = await ServiceModel.findOne({
    _id: serviceId,
    businessId,
  }).lean();

  if (!service) {
    return null;
  }

  return {
    id: String(service._id),
    businessId: service.businessId,
    name: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    isActive: service.isActive,
  };
}
