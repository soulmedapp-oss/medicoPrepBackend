const test = require('node:test');
const assert = require('node:assert/strict');
const TutorSession = require('../src/models/TutorSession');
const Lease = require('../src/models/WorkerLease');
const service = require('../src/services/tutorService');
const { runTutorWorkerOnce } = require('../src/services/tutorWorker');

function fixture(t, matchedCount = 1) {
  const calls = [];
  const session = { _id: 'session', processing_attempts: 1 };
  const stub = (object, key, fn) => { const original = object[key]; object[key] = fn; t.after(() => { object[key] = original; }); };
  stub(Lease, 'findOneAndUpdate', () => ({ lean: async () => ({ _id: 'tutor:0' }) }));
  stub(Lease, 'updateOne', async () => ({ matchedCount: 1 }));
  stub(TutorSession, 'updateMany', async () => ({}));
  stub(TutorSession, 'findOneAndUpdate', () => ({ lean: async () => session }));
  stub(TutorSession, 'updateOne', async (filter, update) => { calls.push({ filter, update }); return { matchedCount }; });
  return { calls, stub };
}

test('a worker that loses its lease cannot checkpoint or overwrite the new owner', async (t) => {
  const { calls, stub } = fixture(t, 0);
  stub(service, 'processTutorSession', async (session, checkpoint) => checkpoint({ $set: { summary: 'stale' } }));
  await assert.rejects(runTutorWorkerOnce(), /lease lost/);
  assert.equal(calls.length, 1, 'lost worker must not reset the new owner’s job');
  assert.ok(calls[0].filter.lease_owner);
  assert.ok(calls[0].filter.lease_until.$gt instanceof Date);
});

test('transient processing failures schedule a durable retry with ownership fencing', async (t) => {
  const { calls, stub } = fixture(t);
  stub(service, 'processTutorSession', async () => { throw new Error('provider unavailable'); });
  await assert.rejects(runTutorWorkerOnce(), /provider unavailable/);
  assert.equal(calls[0].update.$set.status, 'pending');
  assert.ok(calls[0].update.$set.next_run_at > new Date());
  assert.ok(calls[0].filter.lease_owner);
  assert.equal(calls[0].update.$set.items, undefined, 'checkpointed items survive retry');
});
