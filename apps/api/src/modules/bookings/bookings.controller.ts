import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/Apperror.js';
import { getBusinessBySlug } from '../tenants/index.js';
import {
  confirmBooking,
  createWalkInBooking,
  listBookings,
  getBookingForCustomer,
  cancelBooking,
  rescheduleBooking,
  updateBookingOutcome,
  holdSlotForCustomer,
  confirmCustomerBooking,
} from './bookings.service.js';

import {
  exchangeMagicLink,
  setBookingAccessCookie,
  checkResendRateLimit,
  resendMagicLink,
} from './magic-link.service.js';

/**
 * Body schema shared by POST / (customer self-service) and POST
 * /walk-in (staff-entered) — same shape, enforced by `validate()` at
 * the router level.
 */
export const createBookingSchema = z.object({
  providerId: z.string().trim().min(1, 'Provider is required.'),
  providerType: z.enum(['staff', 'resource']),
  serviceId: z.string().trim().min(1, 'Service is required.'),
  datetime: z.string().trim().min(1, 'Date/time is required.'),
  customer: z.object({
    name: z.string().trim().min(1, 'Name is required.'),
    contactType: z.enum(['email', 'phone']),
    contact: z.string().trim().min(1, 'Contact is required.'),
  }),
});

/**
 * Body schema for the anonymous customer hold step
 * (`POST /api/bookings/hold`, architecture doc §13a). The customer has
 * no session — identity is the browser-generated `sessionId` and the
 * business is resolved from its public `slug`. No `slotId`: for a
 * capacity-N resource the client only knows the (provider, datetime,
 * service) bucket (§4b).
 */
export const holdCustomerBookingSchema = z.object({
  slug: z.string().trim().min(1, 'Business is required.'),
  providerId: z.string().trim().min(1, 'Provider is required.'),
  providerType: z.enum(['staff', 'resource']),
  serviceId: z.string().trim().min(1, 'Service is required.'),
  datetime: z.string().trim().min(1, 'Date/time is required.'),
  sessionId: z.string().trim().min(8, 'A session id is required.'),
  waitlistToken: z.string().optional(),
});

/** Body schema for the anonymous customer confirm step (`POST /api/bookings/confirm`). */
export const confirmCustomerBookingSchema = holdCustomerBookingSchema.extend({
  customer: z.object({
    name: z.string().trim().min(1, 'Name is required.'),
    contactType: z.enum(['email', 'phone']),
    contact: z.string().trim().min(1, 'Contact is required.'),
  }),
});

/** Body schema for POST /magic-link/exchange. */
export const exchangeMagicLinkSchema = z.object({
  bookingId: z.string().trim().min(1, 'bookingId is required.'),
  token: z.string().trim().min(1, 'token is required.'),
});

/** Body schema for POST /magic-link/resend. */
export const resendMagicLinkSchema = z.object({
  contact: z.string().trim().min(1, 'Contact is required.'),
});

// Reschudele booking schema
export const rescheduleBookingSchema = z.object({
  providerId: z.string().trim().min(1, 'Provider is required.'),
  providerType: z.enum(['staff', 'resource']),
  serviceId: z.string().trim().min(1, 'Service is required.'),
  datetime: z.string().trim().min(1, 'Date/time is required.'),
});

export const createBooking = asyncHandler(async (req, res) => {
  const {
    providerId,
    providerType,
    serviceId,
    datetime,
    customer,
  } = req.body;

  // authenticate middleware should have populated this.
  // Keep the check because Express does not know middleware ordering.
  if (!req.user) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'Authentication required.',
    );
  }

  // Booking holds are fenced to the authenticated server-side session.
  if (!req.sessionId) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'Authentication required.',
    );
  }

  const result = await confirmBooking({
    businessId: req.user.businessId,
    providerId,
    providerType,
    serviceId,
    datetime,
    customer: {
      name: customer.name,
      contactType: customer.contactType,
      contact: customer.contact,
    },
    createdBy: null,
    sessionId: req.sessionId,
  });

  res.status(201).json({
    data: result,
  });
});

/**
 * `POST /api/bookings/hold` — anonymous. Places a fenced Redis hold on
 * one available unit of a (provider, datetime, service) bucket. A
 * `409 SLOT_NO_LONGER_AVAILABLE` here is the client's cue to offer the
 * waitlist.
 */
export const holdCustomerBookingController = asyncHandler(async (req, res) => {
  const business = await getBusinessBySlug(req.body.slug);

  if (!business) {
    throw new AppError(404, 'NOT_FOUND', 'Business not found.');
  }

  const result = await holdSlotForCustomer({
    businessId: business.id,
    providerId: req.body.providerId,
    providerType: req.body.providerType,
    serviceId: req.body.serviceId,
    datetime: req.body.datetime,
    sessionId: req.body.sessionId,
    waitlistToken: req.body.waitlistToken,
  });

  res.status(201).json({ data: result });
});

/**
 * `POST /api/bookings/confirm` — anonymous. Confirms the slot this
 * browser session is holding and creates the `Booking` (with its
 * magic-link credential). Routes through the same `finalizeConfirmation`
 * the authenticated path uses — no parallel customer state machine (§9a).
 */
export const confirmCustomerBookingController = asyncHandler(async (req, res) => {
  const business = await getBusinessBySlug(req.body.slug);

  if (!business) {
    throw new AppError(404, 'NOT_FOUND', 'Business not found.');
  }

  const result = await confirmCustomerBooking({
    businessId: business.id,
    providerId: req.body.providerId,
    providerType: req.body.providerType,
    serviceId: req.body.serviceId,
    datetime: req.body.datetime,
    sessionId: req.body.sessionId,
    customer: {
      name: req.body.customer.name,
      contactType: req.body.customer.contactType,
      contact: req.body.customer.contact,
    },
  });

  res.status(201).json({ data: result });
});

export function getBookingsStatus(
  _req: Request,
  res: Response,
): void {
  res.json({
    data: {
      module: 'bookings',
      status: 'skeleton',
    },
  });
}

export const getBookings = asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'Authentication required.',
    );
  }

  const bookings = await listBookings(req.user.businessId);

  res.json({
    data: bookings,
  });
});

export const createWalkInBookingController = asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'Authentication required.',
    );
  }

  const {
    providerId,
    providerType,
    serviceId,
    datetime,
    customer,
  } = req.body;

  const result = await createWalkInBooking({
    businessId: req.user.businessId,
    providerId,
    providerType,
    serviceId,
    datetime,
    customer: {
      name: customer.name,
      contactType: customer.contactType,
      contact: customer.contact,
    },
    createdBy: req.user.userId,
  });

  res.status(201).json({
    data: result,
  });
});

export const exchangeMagicLinkController = asyncHandler(async (req, res) => {
  const { bookingId, token } = req.body;

  const booking = await exchangeMagicLink(bookingId, token);

  setBookingAccessCookie(
    res,
    bookingId,
    token,
  );

  res.json({
    data: {
      bookingId: String(booking._id),
    },
  });
});

/**
 * Handles POST /api/bookings/magic-link/resend. Always returns the
 * identical neutral response, whether or not the contact matched a
 * booking — enumeration resistance (architecture doc §13a). A 429
 * from the rate limit is the one exception: it's safe to expose since
 * it reveals nothing about whether the contact matches anything.
 */
export const resendMagicLinkController = asyncHandler(async (req, res) => {
  const { contact } = req.body;

  const withinLimit = await checkResendRateLimit(
    req.ip ?? 'unknown',
    contact,
  );

  if (!withinLimit) {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.',
      },
    });
    return;
  }

  await resendMagicLink(contact);

  res.status(200).json({
    data: {
      message:
        'If that contact matches an upcoming booking, a link has been sent.',
    },
  });
});

export const getCustomerBookingController = asyncHandler(async (req, res) => {
  if (!req.bookingAccess) {
    throw new AppError(
      401,
      'BOOKING_ACCESS_REQUIRED',
      'Booking access is required.',
    );
  }

  const booking = await getBookingForCustomer(
    req.bookingAccess.bookingId,
  );

  res.json({
    data: {
      ...booking.booking,
      slot: booking.slot,
      businessSlug: booking.businessSlug,
      accessTier: req.bookingAccess.tier,
    },
  });
});

export const cancelCustomerBookingController = asyncHandler(async (req, res) => {
  if (!req.bookingAccess) {
    throw new AppError(
      401,
      'BOOKING_ACCESS_REQUIRED',
      'Booking access is required.',
    );
  }

  const result = await cancelBooking(
    req.bookingAccess.businessId,
    req.bookingAccess.bookingId,
  );

  res.json({
    data: result,
  });
});

export const cancelStaffBookingController = asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'Authentication required.',
    );
  }

  const bookingId = req.params.bookingId;

  if (!bookingId || Array.isArray(bookingId)) {
    throw new AppError(
      400,
      'BOOKING_ID_REQUIRED',
      'Booking ID is required.',
    );
  }

  const result = await cancelBooking(
    req.user.businessId,
    bookingId,
  );

  res.json({
    data: result,
  });
});

export const rescheduleCustomerBookingController = asyncHandler(
  async (req, res) => {
    if (!req.bookingAccess) {
      throw new AppError(
        401,
        'BOOKING_ACCESS_REQUIRED',
        'Booking access is required.',
      );
    }

    const {
      providerId,
      providerType,
      serviceId,
      datetime,
    } = req.body;

    const result = await rescheduleBooking({
      businessId: req.bookingAccess.businessId,
      bookingId: req.bookingAccess.bookingId,
      providerId,
      providerType,
      serviceId,
      datetime,
    });

    res.json({
      data: result,
    });
  },
);

export const rescheduleStaffBookingController = asyncHandler(
  async (req, res) => {
    if (!req.user) {
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        'Authentication required.',
      );
    }

    const bookingId = req.params.bookingId;

    if (!bookingId || Array.isArray(bookingId)) {
      throw new AppError(
        400,
        'BOOKING_ID_REQUIRED',
        'Booking ID is required.',
      );
    }

    const {
      providerId,
      providerType,
      serviceId,
      datetime,
    } = req.body;

    const result = await rescheduleBooking({
      businessId: req.user.businessId,
      bookingId,
      providerId,
      providerType,
      serviceId,
      datetime,
    });

    res.json({
      data: result,
    });
  },
);

export const bookingOutcomeSchema = z.object({
  status: z.enum(['completed', 'no-show']),
});

export async function updateBookingOutcomeController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const bookingId = req.params.bookingId;

    if (!bookingId || Array.isArray(bookingId)) {
      throw new AppError(
        400,
        'INVALID_BOOKING_ID',
        'Invalid booking id.',
      );
    }

    if (!req.user?.businessId) {
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        'Authentication required.',
      );
    }

    const result = await updateBookingOutcome(
      req.user.businessId,
      bookingId,
      req.body.status,
    );

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}