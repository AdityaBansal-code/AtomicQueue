#!/usr/bin/env node
import 'dotenv/config';

const BASE = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
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

async function run() {
  try {
    console.log('Setting up business without availability...');
    const owner = jar();
    const email = `demo_${rnd()}@example.com`;
    let r = await owner.f('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Demo Owner',
        email,
        password: 'password123',
        businessName: `Generation Test ${rnd()}`,
      }),
    });
    if (r.status !== 201) throw new Error(`signup failed: ${r.status}`);
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

    // Waitlist users join BEFORE slots exist
    const waitlistUser1 = jar();
    const wlEmail1 = `wl1_${rnd()}@example.com`;
    r = await waitlistUser1.f('/api/waitlist', {
      method: 'POST',
      body: JSON.stringify({
        businessId,
        desiredServiceId: serviceId,
        desiredProviderId: ownerId,
        customer: { name: 'Waitlist Gen 1', contact: wlEmail1 }
      })
    });
    expect(r.status === 201, 'Waitlist entry 1 created before generation');

    const waitlistUser2 = jar();
    const wlEmail2 = `wl2_${rnd()}@example.com`;
    r = await waitlistUser2.f('/api/waitlist', {
      method: 'POST',
      body: JSON.stringify({
        businessId,
        desiredServiceId: serviceId,
        desiredProviderId: ownerId,
        customer: { name: 'Waitlist Gen 2', contact: wlEmail2 }
      })
    });
    expect(r.status === 201, 'Waitlist entry 2 created before generation');

    // Add availability and generate slots
    const everyDay = Array.from({ length: 7 }, (_, d) => ({
      dayOfWeek: d, startTime: '00:00', endTime: '23:00',
    }));
    await owner.f('/api/availability', {
      method: 'POST',
      body: JSON.stringify({ providerId: ownerId, providerType: 'staff', serviceId, weeklyWindows: everyDay }),
    });

    console.log('Generating slots...');
    await owner.f('/api/slots/generate', { method: 'POST', body: JSON.stringify({ days: 3 }) });

    // Wait a brief moment for generation to finish async notifies if any (we awaited them, but just in case)
    await new Promise(res => setTimeout(res, 1000));

    const getWl = await owner.f(`/api/waitlist`);
    const entries = getWl.body?.data || [];
    const entry1 = entries.find(e => e.customer.contact === wlEmail1);
    const entry2 = entries.find(e => e.customer.contact === wlEmail2);
    expect(entry1?.status === 'notified', 'Waitlist user 1 is notified upon generation');
    expect(entry2?.status === 'notified', 'Waitlist user 2 is notified upon generation');

    // Check DB manually to get the token
    const { MongoClient } = await import('mongodb');
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/atomic-queue-dev';
    const client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db();
    
    const slotDoc1 = await db.collection('slots').findOne({ reservedForWaitlistEntryId: entry1?.id });
    expect(!!slotDoc1, 'Slot 1 is properly reserved for waitlist user 1 in the DB');
    expect(!!slotDoc1.reservedForWaitlistToken, 'Slot 1 has a waitlist token');

    const slotDoc2 = await db.collection('slots').findOne({ reservedForWaitlistEntryId: entry2?.id });
    expect(!!slotDoc2, 'Slot 2 is properly reserved for waitlist user 2 in the DB');
    expect(!!slotDoc2.reservedForWaitlistToken, 'Slot 2 has a waitlist token');

    expect(String(slotDoc1._id) !== String(slotDoc2._id), 'Waitlist users received different slots');

    const token1 = slotDoc1?.reservedForWaitlistToken;

    // Sniper attempt
    if (slotDoc1) {
      const sniper = jar();
      let snipeHold = await sniper.f('/api/bookings/hold', {
        method: 'POST',
        body: JSON.stringify({
          slug, providerId: ownerId, providerType: 'staff', serviceId,
          datetime: slotDoc1.datetime.toISOString(), sessionId: `sniper_${rnd()}`
        }),
      });
      expect(snipeHold.status === 409, 'Sniper cannot hold the newly generated reserved slot 1');

      // Waitlist user 1 claims their reserved slot
      let wlHold1 = await waitlistUser1.f('/api/bookings/hold', {
        method: 'POST',
        body: JSON.stringify({
          slug, providerId: ownerId, providerType: 'staff', serviceId,
          datetime: slotDoc1.datetime.toISOString(), sessionId: `sess_${rnd()}`, waitlistToken: token1
        }),
      });
      expect(wlHold1.status === 201, 'Waitlist user 1 can hold their generated slot', wlHold1.body);
    }

    await client.close();

    console.log(`\nTests finished. ${failures} failures`);
    process.exit(failures > 0 ? 1 : 0);

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
