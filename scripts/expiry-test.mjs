#!/usr/bin/env node

const BASE = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const RACERS = Number(process.argv[3] || 8);

const rnd = () => Math.random().toString(36).slice(2, 10);

function jar() {
  const cookies = {};
  return {
    async f(path, opts = {}) {
      const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
      const ck = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) headers.cookie = ck;
      const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const m = /^([^=]+)=([^;]*)/.exec(line);
        if (m) cookies[m[1]] = m[2];
      }
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body };
    },
  };
}

let failures = 0;
function expect(cond, label, detail) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!cond) failures += 1;
}

async function setupBusiness() {
  const owner = jar();
  const email = `demo_${rnd()}@example.com`;
  let r = await owner.f('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Demo Owner',
      email,
      password: 'password123',
      businessName: `Expiry Demo ${rnd()}`,
    }),
  });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  const { slug, id: businessId, ownerId } = {
    slug: r.body.data.business.slug,
    id: r.body.data.business.id,
    ownerId: r.body.data.user.id,
  };

  r = await owner.f('/api/services', {
    method: 'POST',
    body: JSON.stringify({ name: 'Demo Service', durationMinutes: 60, price: 0 }),
  });
  const serviceId = r.body.data.id;

  const everyDay = Array.from({ length: 7 }, (_, d) => ({
    dayOfWeek: d, startTime: '00:00', endTime: '23:00',
  }));
  await owner.f('/api/availability', {
    method: 'POST',
    body: JSON.stringify({ providerId: ownerId, providerType: 'staff', serviceId, weeklyWindows: everyDay }),
  });

  await owner.f('/api/slots/generate', { method: 'POST', body: JSON.stringify({ days: 3 }) });

  return { slug, businessId, serviceId, ownerId };
}

async function testHoldExpiry(ctx) {
  const { slug, serviceId, ownerId, businessId } = ctx;
  const anon = jar();
  const sessionId = `demo_sess_${rnd()}`;

  const r = await anon.f(`/api/businesses/${slug}/availability?serviceId=${serviceId}&providerType=staff`);
  const buckets = r.body.data || [];
  
  const slot1 = buckets[0];

  // 1. Hold slot 1
  let hold1 = await anon.f('/api/bookings/hold', {
    method: 'POST',
    body: JSON.stringify({
      slug, providerId: ownerId, providerType: 'staff', serviceId,
      datetime: slot1.datetime, sessionId
    }),
  });
  expect(hold1.status === 201, 'Expiry: Hold succeeds');

  // We have a direct mongoose connection to manipulate heldUntil since 5 mins is too long
  const mongoose = await import('mongoose');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/atomic_queue'); // adjust if needed
  const SlotModel = mongoose.model('Slot', new mongoose.Schema({}, { strict: false, collection: 'slots' }));
  
  const res = await SlotModel.updateOne(
      { businessId, status: 'held', heldBySessionId: sessionId },
      { $set: { heldUntil: new Date(Date.now() - 1000) } } // expire it
  );
  expect(res.modifiedCount === 1, 'Expiry: Manually expired the hold in DB');
  
  // Now run the worker expiry check or just try to claim it with another session
  const anon2 = jar();
  const sessionId2 = `demo_sess_${rnd()}`;
  
  let hold2 = await anon2.f('/api/bookings/hold', {
    method: 'POST',
    body: JSON.stringify({
      slug, providerId: ownerId, providerType: 'staff', serviceId,
      datetime: slot1.datetime, sessionId: sessionId2
    }),
  });
  expect(hold2.status === 201, 'Expiry: Another session can claim the expired hold (lazy release)');
  
  await mongoose.disconnect();
}

(async () => {
  console.log(`\nHold Expiry Demo → ${BASE}\n`);
  const ctx = await setupBusiness();
  await testHoldExpiry(ctx);
  
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('demo error:', err);
  process.exit(2);
});
