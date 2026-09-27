import mongoose from 'mongoose';
import { connectDatabase } from './lib/db.js';
import { SlotModel } from './modules/slots/slots.model.js';
import { ServiceModel } from './modules/services/services.model.js';
import { claimSlot, releaseExistingHoldForSession } from './modules/slots/slots.service.js';

async function test() {
  await connectDatabase();
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

  const sessionId = 'test-session';

  try {
    const [req1, req2] = await Promise.all([
      (async () => {
        await releaseExistingHoldForSession(businessId, sessionId);
        return await claimSlot(businessId, providerId, 'staff', serviceId, datetime, sessionId);
      })(),
      (async () => {
        await releaseExistingHoldForSession(businessId, sessionId);
        return await claimSlot(businessId, providerId, 'staff', serviceId, datetime, sessionId);
      })()
    ]);
    console.log('Req1:', req1);
    console.log('Req2:', req2);
  } catch (err) {
    console.error('Error:', err);
  }

  const holds = await SlotModel.find({ businessId, heldBySessionId: sessionId }).lean();
  console.log('Active holds:', holds.length);
  process.exit(0);
}
test();
