import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import { connectDatabase } from './lib/db.js';
import { SlotModel } from './modules/slots/slots.model.js';
import { ServiceModel } from './modules/services/services.model.js';
import { BookingModel } from './modules/bookings/bookings.model.js';
import { claimSlot, releaseExistingHoldForSession, confirmHeldSlot } from './modules/slots/slots.service.js';
import { confirmBooking } from './modules/bookings/bookings.service.js';
import authRoutes from './modules/auth/auth.routes.js';
import { redis } from './lib/redis.js';

describe('Integration Tests', () => {
  let app: express.Application;

  before(async () => {
    await connectDatabase();
    app = express();
    app.set('trust proxy', 2);
    app.use(express.json());
    app.post('/debug-ip', (req, res) => { res.json({ ip: req.ip, ips: req.ips }); });
    app.use('/auth', authRoutes);
  });

  after(async () => {
    await mongoose.connection.close();
    redis.disconnect();
  });

  test('Auth rate limiting', async (t) => {
    // Generate unique IPs for the test
    const ipA = '192.168.1.100';
    const ipB = '192.168.1.101';
    
    const resDebug = await request(app).post('/debug-ip').set('X-Forwarded-For', ipA);
    console.log('IP Debug:', resDebug.body);
    
    let lastStatusA = 200;
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ipA)
        .send({ email: 'test@example.com', password: 'password123' });
      lastStatusA = res.status;
    }
    // Expected 429 Too Many Requests
    assert.equal(lastStatusA, 429, '11th request from IP A should receive 429');

    // Test IP B is unaffected
    const resB = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', ipB)
      .send({ email: 'test_b@example.com', password: 'password123' });
    assert.notEqual(resB.status, 429, 'Request from IP B should not be blocked');

    // Test signup has its own counter (IP A can still signup)
    const resSignup = await request(app)
      .post('/auth/signup')
      .set('X-Forwarded-For', ipA)
      .send({ name: 'Test', email: 'new@example.com', password: 'password123' });
    assert.notEqual(resSignup.status, 429, 'Signup should have an independent counter');
  });

  test('Cross-user slot contention', async (t) => {
    const businessId = new mongoose.Types.ObjectId().toString();
    const providerId = new mongoose.Types.ObjectId().toString();
    const serviceId = new mongoose.Types.ObjectId().toString();
    const datetime = new Date();
    
    await ServiceModel.create({
      _id: serviceId,
      businessId,
      name: 'Test Service',
      durationMinutes: 30,
      isActive: true,
      price: 0
    });

    await SlotModel.create({
      businessId, providerId, providerType: 'staff', serviceId, datetime, durationMinutes: 30, unitIndex: 0, status: 'available'
    });

    const sessions = Array.from({ length: 50 }, (_, i) => `session-${i}`);
    
    const results = await Promise.allSettled(
      sessions.map(sessionId => claimSlot(businessId, providerId, 'staff', serviceId, datetime, sessionId))
    );

    let successes = 0;
    let fails = 0;
    
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value.ok === true) successes++;
      if (res.status === 'fulfilled' && res.value.ok === false) fails++;
    }

    assert.equal(successes, 1, 'Exactly 1 request should succeed');
    assert.equal(fails, 49, 'Exactly 49 requests should fail safely');

    const holds = await SlotModel.find({ businessId, status: 'held' }).lean();
    assert.equal(holds.length, 1, 'Final database state should contain exactly one active hold');
  });

  test('Same-session contention', async (t) => {
    const businessId = new mongoose.Types.ObjectId().toString();
    const providerId = new mongoose.Types.ObjectId().toString();
    const serviceId = new mongoose.Types.ObjectId().toString();
    const datetime = new Date();
    
    await ServiceModel.create({
      _id: serviceId,
      businessId,
      name: 'Test Service',
      durationMinutes: 30,
      isActive: true,
      price: 0
    });

    await SlotModel.create([
      { businessId, providerId, providerType: 'staff', serviceId, datetime, durationMinutes: 30, unitIndex: 0, status: 'available' },
      { businessId, providerId, providerType: 'staff', serviceId, datetime, durationMinutes: 30, unitIndex: 1, status: 'available' }
    ]);

    const sessionId = 'same-session-contention-test';
    
    const [req1, req2] = await Promise.allSettled([
      (async () => {
        const session = await mongoose.startSession();
        let claim;
        try {
          await session.withTransaction(async () => {
            await releaseExistingHoldForSession(businessId, sessionId, session);
            claim = await claimSlot(businessId, providerId, 'staff', serviceId, datetime, sessionId, undefined, session);
          });
        } finally {
          await session.endSession();
        }
        return claim;
      })(),
      (async () => {
        const session = await mongoose.startSession();
        let claim;
        try {
          await session.withTransaction(async () => {
            await releaseExistingHoldForSession(businessId, sessionId, session);
            claim = await claimSlot(businessId, providerId, 'staff', serviceId, datetime, sessionId, undefined, session);
          });
        } finally {
          await session.endSession();
        }
        return claim;
      })()
    ]);

    const holds = await SlotModel.find({ businessId, heldBySessionId: sessionId, status: 'held' }).lean();
    assert.ok(holds.length <= 1, 'Session should end with at most one active hold');
  });

  test('Double confirmation', async (t) => {
    const businessId = new mongoose.Types.ObjectId().toString();
    const providerId = new mongoose.Types.ObjectId().toString();
    const serviceId = new mongoose.Types.ObjectId().toString();
    const datetime = new Date();
    const holdVersion = new mongoose.Types.ObjectId().toString();
    
    const slot = await SlotModel.create({
      businessId, providerId, providerType: 'staff', serviceId, datetime, durationMinutes: 30, unitIndex: 0, status: 'held', holdVersion, heldBySessionId: 'session'
    });

    const [conf1, conf2] = await Promise.allSettled([
      (async () => {
        const session = await mongoose.startSession();
        let ok = false;
        try {
          await session.withTransaction(async () => {
            ok = await confirmHeldSlot(slot._id.toString(), businessId, holdVersion, session);
          });
        } finally {
          await session.endSession();
        }
        return ok;
      })(),
      (async () => {
        const session = await mongoose.startSession();
        let ok = false;
        try {
          await session.withTransaction(async () => {
            ok = await confirmHeldSlot(slot._id.toString(), businessId, holdVersion, session);
          });
        } finally {
          await session.endSession();
        }
        return ok;
      })()
    ]);

    let successes = 0;
    if (conf1.status === 'fulfilled' && conf1.value === true) successes++;
    if (conf2.status === 'fulfilled' && conf2.value === true) successes++;

    assert.equal(successes, 1, 'Exactly one confirmation request should succeed');

    const confirmedSlot = await SlotModel.findById(slot._id).lean();
    assert.equal(confirmedSlot?.status, 'confirmed', 'Slot should be confirmed');
    assert.equal(confirmedSlot?.holdVersion, undefined, 'Hold version should be cleared');
  });
});
