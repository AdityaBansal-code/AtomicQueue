import { Router } from 'express';
import {
  getAuthStatus,
  signupOwnerController,
  loginController,
  logoutController,
  logoutEverywhereController,
  signupSchema,
  loginSchema,
} from './auth.controller.js';

import { authenticate } from './authenticate.js';
import { validate } from '../../middleware/validate.js';
import { rateLimit } from 'express-rate-limit';

const router = Router();

const signupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' } }
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' } }
});

router.get('/status', getAuthStatus);
router.post('/signup', signupRateLimiter, validate(signupSchema), signupOwnerController);
router.post('/login', loginRateLimiter, validate(loginSchema), loginController);
router.post('/logout', authenticate, logoutController);
router.post('/logout-everywhere', authenticate, logoutEverywhereController);

export default router;