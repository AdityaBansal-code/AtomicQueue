/**
 * Public (unauthenticated) business endpoints:
 *
 *   - GET /api/businesses        — cursor-paginated directory listing for
 *                                  the `/businesses` customer discovery page
 *   - GET /api/businesses/:slug  — single business, the one piece of
 *                                  identity a customer-facing page has
 *                                  from the URL; every other public
 *                                  endpoint (`publicAvailability`,
 *                                  `publicCatalog`, `waitlist` join)
 *                                  needs it resolved to a businessId.
 *
 * Both return an explicit projection — id, name, slug (+ serviceCount,
 * a service-name preview and priceFrom on the list) — never a raw
 * document, never `ownerId` or any auth field.
 */

import { asyncHandler } from '../../lib/asyncHandler.js';
import { getActiveServiceSummaryByBusiness } from '../services/index.js';
import { redis } from '../../lib/redis.js';

import {
  getBusinessBySlug,
  listBusinessesPage,
  type BusinessCursorKey,
} from './tenants.service.js';

export const getPublicBusiness = asyncHandler<{ slug: string }>(async (req, res) => {
  const business = await getBusinessBySlug(req.params.slug);

  if (!business) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Business not found' },
    });
    return;
  }

  res.status(200).json({
    data: {
      id: business.id,
      name: business.name,
      slug: business.slug,
    },
  });
});

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** base64url(JSON) of the last item's (name, id) — opaque to the client. */
function encodeCursor(key: BusinessCursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): BusinessCursorKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { name?: unknown }).name !== 'string' ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    !OBJECT_ID_RE.test((parsed as { id: string }).id)
  ) {
    return null;
  }

  const { name, id } = parsed as { name: string; id: string };
  return { name, id };
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * GET /api/businesses — public, cursor-paginated customer directory.
 *
 * Query params (all optional): `q` (case-insensitive name substring),
 * `limit` (integer 1..50, default 20), `cursor` (opaque, from a previous
 * response's `pagination.nextCursor`). An invalid `limit` or `cursor` is
 * a `400 VALIDATION_ERROR`.
 *
 * Response: `{ data: [{ id, name, slug, serviceCount, services, priceFrom }],
 *              pagination: { nextCursor: string | null, hasMore: boolean } }`
 * where `services` is up to five active service names (cheapest first)
 * and `priceFrom` is the lowest active-service price (`null` if none).
 * Only businesses with at least one active service are listed.
 */
export const getPublicBusinesses = asyncHandler(async (req, res) => {
  // ── page size ──────────────────────────────────────────────────────
  let limit = DEFAULT_LIMIT;
  const rawLimit = firstQueryValue(req.query.limit);
  if (req.query.limit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
          fields: { limit: `must be an integer between 1 and ${MAX_LIMIT}` },
        },
      });
      return;
    }
    limit = n;
  }

  // ── cursor ─────────────────────────────────────────────────────────
  let cursor: BusinessCursorKey | undefined;
  if (req.query.cursor !== undefined) {
    const rawCursor = firstQueryValue(req.query.cursor);
    const decoded = rawCursor ? decodeCursor(rawCursor) : null;
    if (!decoded) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid or malformed cursor.',
          fields: { cursor: 'invalid or malformed' },
        },
      });
      return;
    }
    cursor = decoded;
  }

  // ── search ─────────────────────────────────────────────────────────
  const q = firstQueryValue(req.query.q)?.slice(0, 100);

  // ── cache ──────────────────────────────────────────────────────────
  const cacheKey = 'cache:public:businesses:default';
  const isDefaultQuery = !q && !cursor && limit === DEFAULT_LIMIT;

  if (isDefaultQuery) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.status(200).json(JSON.parse(cached));
        return;
      }
    } catch {
      // ignore redis errors and fall back to db
    }
  }

  // ── page ───────────────────────────────────────────────────────────
  const serviceSummaries = await getActiveServiceSummaryByBusiness();

  const { items, hasMore, nextKey } = await listBusinessesPage({
    query: q,
    limit,
    cursor,
    includeIds: [...serviceSummaries.keys()],
  });

  const SERVICE_PREVIEW_LIMIT = 5;

  const responseData = {
    data: items.map((business) => {
      const summary = serviceSummaries.get(business.id);
      return {
        id: business.id,
        name: business.name,
        slug: business.slug,
        serviceCount: summary?.count ?? 0,
        services: summary?.names.slice(0, SERVICE_PREVIEW_LIMIT) ?? [],
        priceFrom: summary?.priceFrom ?? null,
      };
    }),
    pagination: {
      nextCursor: nextKey ? encodeCursor(nextKey) : null,
      hasMore,
    },
  };

  if (isDefaultQuery) {
    try {
      await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 300);
    } catch {
      // ignore redis write errors
    }
  }

  res.status(200).json(responseData);
});
