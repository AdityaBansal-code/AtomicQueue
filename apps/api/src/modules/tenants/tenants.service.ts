import { Types, type ClientSession } from "mongoose";

import type { Business } from "@queueless/shared-types";

import { redis } from "../../lib/redis.js";
import { BusinessModel } from "./tenants.model.js";

export interface CreateBusinessInput {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  timezone: string;
  cancellationCutoffMinutes: number;
}

/**
 * Converts a MongoDB business document into the shared API type.
 */
function toBusiness(business: {
  _id: unknown;
  name: string;
  slug: string;
  ownerId: string;
  timezone: string;
  cancellationCutoffMinutes: number;
}): Business {
  return {
    id: String(business._id),
    name: business.name,
    slug: business.slug,
    ownerId: business.ownerId,
    timezone: business.timezone,
    cancellationCutoffMinutes: business.cancellationCutoffMinutes,
  };
}

/**
 * Insert the `Business` half of owner signup.
 *
 * Signup is business creation: the `Business` and the owner `User` are
 * written in one transaction, both or neither. This function only does the
 * `Business` insert, enrolled in the caller's `session`.
 *
 * Slug collisions are the caller's problem: a concurrent collision surfaces
 * here as a duplicate-key error on the `Businesses.slug` unique index, and
 * the caller retries with a fresh slug.
 */
export async function createBusiness(
  input: CreateBusinessInput,
  session: ClientSession,
): Promise<Business> {
  // The Business and the owner User are both-or-neither; fail loudly rather
  // than half-write if there's no open transaction.
  if (!session.inTransaction()) {
    throw new Error(
      "createBusiness must run inside a transaction: the Business and owner User are " +
        "written both-or-neither",
    );
  }

  // Array form so the insert is enrolled in `session` — Model.create only
  // honours the session option when given an array of docs.
  const [business] = await BusinessModel.create(
    [
      {
        _id: input.id,
        name: input.name,
        slug: input.slug,
        ownerId: input.ownerId,
        timezone: input.timezone,
        cancellationCutoffMinutes: input.cancellationCutoffMinutes,
      },
    ],
    { session },
  );

  try {
    await redis.del('cache:public:businesses:default');
  } catch {
    // ignore
  }

  return toBusiness(business);
}

/**
 * Returns one business by id.
 *
 * In practice always "get my own business" — every session carries
 * exactly one `businessId`.
 */
export async function getBusinessById(
  businessId: string,
): Promise<Business | null> {
  const business = await BusinessModel.findById(businessId);

  if (!business) {
    return null;
  }

  return toBusiness(business);
}

/**
 * Lists every business's id. Only for the generate-weekly-slots
 * scheduled job to iterate all tenants — no per-request caller needs
 * this, so it deliberately doesn't take a filter or return full
 * business docs.
 */
export async function listBusinessIds(): Promise<string[]> {
  const businesses = await BusinessModel.find().select({ _id: 1 }).lean();

  return businesses.map((business) => String(business._id));
}

export interface PublicBusinessListItem {
  id: string;
  name: string;
  slug: string;
}

/** Keyset cursor position — the (name, id) of the last item on a page. */
export interface BusinessCursorKey {
  name: string;
  id: string;
}

export interface ListBusinessesPageParams {
  /**
   * Optional case-insensitive substring match on the business name,
   * treated as a literal — the caller escapes regex metacharacters
   * before passing it in.
   */
  query?: string;
  /** Page size — the caller validates this is an integer in 1..50. */
  limit: number;
  /** Decoded/validated cursor from the previous page, if any. */
  cursor?: BusinessCursorKey;
  /**
   * The businessIds eligible to appear (those with >= 1 active service).
   * Resolved by the caller from the `services` module so this function
   * never reaches across the module boundary.
   */
  includeIds: string[];
}

export interface ListBusinessesPageResult {
  items: PublicBusinessListItem[];
  hasMore: boolean;
  /** (name, id) of the last returned item — the next cursor, or null when !hasMore. */
  nextKey: BusinessCursorKey | null;
}

/**
 * One page of the public `/businesses` directory, keyset-paginated.
 *
 * Ordering is a deterministic total order on `(name asc, _id asc)` — the
 * unique `_id` tiebreak means the order is stable even when names
 * collide, so the cursor never skips or repeats a row. No skip/offset.
 *
 * Returns a minimal projection only (`id`, `name`, `slug`) — never a
 * full business document, never `ownerId`/`timezone`/`cancellationCutoffMinutes`
 * or any other non-public field. The caller attaches `serviceCount`.
 */
export async function listBusinessesPage(
  params: ListBusinessesPageParams,
): Promise<ListBusinessesPageResult> {
  const { query, limit, cursor, includeIds } = params;

  const idObjectIds = includeIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

  // No business has an active service → nothing to page.
  if (idObjectIds.length === 0) {
    return { items: [], hasMore: false, nextKey: null };
  }

  const filter: Record<string, unknown> = { _id: { $in: idObjectIds } };

  const trimmed = query?.trim();
  if (trimmed) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = { $regex: escaped, $options: 'i' };
  }

  // Keyset "seek" past the cursor, matching the (name asc, _id asc) sort:
  // strictly-greater name, or same name with a strictly-greater _id.
  if (cursor) {
    filter.$or = [
      { name: { $gt: cursor.name } },
      { name: cursor.name, _id: { $gt: new Types.ObjectId(cursor.id) } },
    ];
  }

  // Fetch one extra to know whether another page exists without a count.
  const rows = await BusinessModel.find(filter)
    .select({ _id: 1, name: 1, slug: 1 })
    .sort({ name: 1, _id: 1 })
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items = page.map((business) => ({
    id: String(business._id),
    name: business.name,
    slug: business.slug,
  }));

  const last = page.at(-1);
  const nextKey =
    hasMore && last ? { name: last.name, id: String(last._id) } : null;

  return { items, hasMore, nextKey };
}

/**
 * Returns one business by its public slug — how an anonymous caller
 * (the public booking page) looks a business up, since it never has
 * a businessId to work with.
 */
export async function getBusinessBySlug(
  slug: string,
): Promise<Business | null> {
  const business = await BusinessModel.findOne({ slug });

  if (!business) {
    return null;
  }

  return toBusiness(business);
}

/**
 * Input required to update a business.
 *
 * `slug` and `ownerId` are not editable here — there is no supported flow
 * to change either.
 */
export interface UpdateBusinessInput {
  businessId: string;
  name?: string;
  timezone?: string;
  cancellationCutoffMinutes?: number;
}

/**
 * Updates a business's editable settings.
 *
 * Returns null if no business exists with the given id.
 */
export async function updateBusiness(
  input: UpdateBusinessInput,
): Promise<Business | null> {
  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    updates.name = input.name;
  }

  if (input.timezone !== undefined) {
    updates.timezone = input.timezone;
  }

  if (input.cancellationCutoffMinutes !== undefined) {
    updates.cancellationCutoffMinutes = input.cancellationCutoffMinutes;
  }

  const business = await BusinessModel.findByIdAndUpdate(
    input.businessId,
    updates,
    { new: true },
  );

  if (!business) {
    return null;
  }

  try {
    await redis.del('cache:public:businesses:default');
  } catch {
    // ignore
  }

  return toBusiness(business);
}
