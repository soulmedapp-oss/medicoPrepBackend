const { randomUUID } = require('node:crypto');
const TutorSession = require('../models/TutorSession');
const WorkerLease = require('../models/WorkerLease');

const leaseMs = 120_000;
const maxAttempts = 5;

// Fixed shared slots bound aggregate concurrency across every worker replica.
async function acquireSlot(owner, now = new Date()) {
  const slots = Math.max(1, Math.min(32, Number(process.env.TUTOR_GLOBAL_CONCURRENCY) || 2));
  for (let i = 0; i < slots; i += 1) {
    try {
      const slot = await WorkerLease.findOneAndUpdate(
        { _id: `tutor:${i}`, expires_at: { $lte: now } },
        { $set: { owner, expires_at: new Date(now.getTime() + leaseMs) } },
        { upsert: true, new: true }
      ).lean();
      if (slot) return slot._id;
    } catch (err) { if (err.code !== 11000) throw err; }
  }
  return null;
}

async function runTutorWorkerOnce() {
  await TutorSession.updateMany({ status: 'pending', processing_attempts: { $gte: maxAttempts },
    lease_until: { $lte: new Date() } }, { $set: { status: 'failed', error_message: 'AI processing stopped after repeated failures. Please contact support.' } });
  const owner = randomUUID();
  const slot = await acquireSlot(owner);
  if (!slot) return false;
  let heartbeat;
  let session;
  let lost = false;
  try {
    const now = new Date();
    session = await TutorSession.findOneAndUpdate({
      status: 'pending',
      $and: [
        { $or: [{ processing_attempts: { $lt: maxAttempts } }, { processing_attempts: { $exists: false } }] },
        { $or: [{ next_run_at: { $lte: now } }, { next_run_at: { $exists: false } }] },
        { $or: [{ lease_until: { $exists: false } }, { lease_until: null }, { lease_until: { $lte: now } }] },
      ],
    }, {
      $set: { lease_owner: owner, lease_until: new Date(now.getTime() + leaseMs) },
      $inc: { processing_attempts: 1 },
    }, { new: true, sort: { next_run_at: 1 } }).lean();
    if (!session) return false;
    const fence = { _id: session._id, lease_owner: owner, status: 'pending' };
    const renew = async () => {
      try {
        const expires = new Date(Date.now() + leaseMs);
        const slotResult = await WorkerLease.updateOne({ _id: slot, owner }, { $set: { expires_at: expires } });
        const jobResult = await TutorSession.updateOne(fence, { $set: { lease_until: expires } });
        if (!slotResult.matchedCount || !jobResult.matchedCount) lost = true;
      } catch { lost = true; }
    };
    heartbeat = setInterval(renew, 30_000);
    heartbeat.unref?.();
    const checkpoint = async (update) => {
      if (lost) throw new Error('Tutor worker lease lost');
      const result = await TutorSession.updateOne({ ...fence, lease_until: { $gt: new Date() } }, update);
      if (!result.matchedCount) { lost = true; throw new Error('Tutor worker lease lost'); }
    };
    await require('./tutorService').processTutorSession(session, checkpoint);
    return true;
  } catch (err) {
    if (session && !lost) {
      const exhausted = session.processing_attempts >= maxAttempts;
      await TutorSession.updateOne({ _id: session._id, lease_owner: owner, status: 'pending' }, {
        $set: {
          status: exhausted ? 'failed' : 'pending',
          error_message: 'AI tutor is unavailable right now. Please try again later.',
          next_run_at: new Date(Date.now() + Math.min(300_000, 5000 * 2 ** session.processing_attempts) + Math.random() * 5000),
        },
        $unset: { lease_owner: '', lease_until: '' },
      });
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
    await WorkerLease.updateOne({ _id: slot, owner }, { $set: { expires_at: new Date(0) }, $unset: { owner: '' } });
  }
}

module.exports = { acquireSlot, runTutorWorkerOnce };
