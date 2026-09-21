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
      businessName: `Session Hold Demo ${rnd()}`,
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

async function testSequentialHolds(ctx) {
  const { slug, serviceId, ownerId } = ctx;
  const anon = jar();
  const sessionId = `demo_sess_${rnd()}`;

  const r = await anon.f(`/api/businesses/${slug}/availability?serviceId=${serviceId}&providerType=staff`);
  const buckets = r.body.data || [];
  
  const slot1 = buckets[0];
  const slot2 = buckets[1];

  // 1. Hold slot 1
  let hold1 = await anon.f('/api/bookings/hold', {
    method: 'POST',
    body: JSON.stringify({
      slug, providerId: ownerId, providerType: 'staff', serviceId,
      datetime: slot1.datetime, sessionId
    }),
  });
  expect(hold1.status === 201, 'Sequential: First hold succeeds');

  // Verify slot1 is held
  let check1 = await anon.f(`/api/businesses/${slug}/availability?serviceId=${serviceId}&providerType=staff`);
  let bucket1 = check1.body.data.find(b => b.datetime === slot1.datetime);
  expect(bucket1.remaining === bucket1.total - 1, 'Sequential: Slot 1 capacity reduced');

  // 2. Hold slot 2
  let hold2 = await anon.f('/api/bookings/hold', {
    method: 'POST',
    body: JSON.stringify({
      slug, providerId: ownerId, providerType: 'staff', serviceId,
      datetime: slot2.datetime, sessionId
    }),
  });
  expect(hold2.status === 201, 'Sequential: Second hold succeeds');

  // Verify slot1 is released and slot2 is held
  let check2 = await anon.f(`/api/businesses/${slug}/availability?serviceId=${serviceId}&providerType=staff`);
  let bucket1_after = check2.body.data.find(b => b.datetime === slot1.datetime);
  let bucket2_after = check2.body.data.find(b => b.datetime === slot2.datetime);
  
  expect(bucket1_after.remaining === bucket1_after.total, 'Sequential: Slot 1 hold was automatically released');
  expect(bucket2_after.remaining === bucket2_after.total - 1, 'Sequential: Slot 2 capacity reduced');
}

async function testConcurrentHolds(ctx) {
  const { slug, serviceId, ownerId } = ctx;
  const anon = jar();
  const sessionId = `demo_sess_${rnd()}`;

  const r = await anon.f(`/api/businesses/${slug}/availability?serviceId=${serviceId}&providerType=staff`);
  const buckets = (r.body.data || []).slice(2, RACERS + 2);

  // Fire RACERS holds concurrently with the SAME sessionId on DIFFERENT datetimes
  const holds = buckets.map(b => anon.f('/api/bookings/hold', {
    method: 'POST',
    body: JSON.stringify({
      slug, providerId: ownerId, providerType: 'staff', serviceId,
      datetime: b.datetime, sessionId
    }),
  }));

  await Promise.all(holds);

  // Check how many slots are actually held
  const check = await anon.f(`/api/businesses/${slug}/availability?serviceId=${serviceId}&providerType=staff`);
  const testDatetimes = new Set(buckets.map(b => b.datetime));
  const heldBuckets = check.body.data.filter(b => b.remaining < b.total && testDatetimes.has(b.datetime));
  
  console.log(`HELD BUCKETS: ${heldBuckets.length} - ${JSON.stringify(heldBuckets.map(b => b.datetime))}`);
  expect(heldBuckets.length === 1, `Concurrent: Exactly 1 hold is active across ${RACERS} concurrent requests`);
}

(async () => {
  console.log(`\nOne Active Hold Per Session Demo → ${BASE}\n`);
  const ctx = await setupBusiness();
  await testSequentialHolds(ctx);
  await testConcurrentHolds(ctx);
  
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('demo error:', err);
  process.exit(2);
});
