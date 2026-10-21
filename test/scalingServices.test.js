const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, personalize } = require('../src/services/testStatsCache');
const WorkerLease = require('../src/models/WorkerLease');
const { acquireSlot } = require('../src/services/tutorWorker');
const TestAttempt = require('../src/models/TestAttempt');
const Test = require('../src/models/Test');
const User = require('../src/models/User');
const { reconcileCompletionEffectsBulk } = require('../src/services/completionEffectsWorker');

test('shared statistics preserve exact median and strict-below percentile with ties', () => {
  const distribution = [{ _id: 20, count: 1 }, { _id: 60, count: 2 }, { _id: 100, count: 1 }];
  const stats = summarize(distribution, 5, { percentage: 100, score: 10 }, 10);
  assert.equal(stats.median_percentage, 60);
  assert.equal(stats.total_attempts, 5);
  assert.equal(personalize({ stats, distribution }, 60).percentile, 25);
  assert.equal(personalize({ stats, distribution }, null).percentile, null);
});

test('shared statistics handle empty and odd score distributions', () => {
  assert.equal(summarize([], 0).median_percentage, null);
  assert.equal(summarize([{ _id: 10, count: 2 }, { _id: 90, count: 3 }], 5).median_percentage, 90);
});

test('global tutor slots cannot bypass an occupied lease', async (t) => {
  const original = WorkerLease.findOneAndUpdate;
  const calls = [];
  WorkerLease.findOneAndUpdate = (filter) => {
    calls.push(filter);
    return { lean: async () => { const err = new Error('occupied'); err.code = 11000; throw err; } };
  };
  t.after(() => { WorkerLease.findOneAndUpdate = original; });
  assert.equal(await acquireSlot('worker-a'), null);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((filter) => filter.expires_at.$lte instanceof Date));
});

test('bulk completion effects leave the durable marker pending after a partial write failure', async (t) => {
  const stub = (object, key, value) => { const original = object[key]; object[key] = value; t.after(() => { object[key] = original; }); };
  const pending = [{ _id: 'attempt', test_id: 'test', user_id: 'user' }];
  const query = { sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => pending };
  stub(TestAttempt, 'find', () => query);
  stub(TestAttempt, 'aggregate', (pipeline) => ({ option: async () => [{ _id: pipeline[0].$match.user_id ? 'user' : 'test', count: 1, average: 50 }] }));
  stub(Test, 'bulkWrite', async () => ({}));
  stub(User, 'bulkWrite', async () => { throw new Error('Temporary write failure'); });
  let acknowledged = false;
  stub(TestAttempt, 'updateMany', async () => { acknowledged = true; });
  await assert.rejects(reconcileCompletionEffectsBulk(), /Temporary write failure/);
  assert.equal(acknowledged, false);
});

test('production rate limits fail closed when the shared store is unavailable', async (t) => {
  const { createRateLimiter } = require('../src/middlewares/rateLimit');
  const before = process.env.RATE_LIMIT_FAIL_CLOSED;
  process.env.RATE_LIMIT_FAIL_CLOSED = 'true';
  t.after(() => { if (before === undefined) delete process.env.RATE_LIMIT_FAIL_CLOSED; else process.env.RATE_LIMIT_FAIL_CLOSED = before; });
  const response = { setHeader() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  let passed = false;
  await createRateLimiter({ name: 'test' })({ ip: '127.0.0.1' }, response, () => { passed = true; });
  assert.equal(response.statusCode, 503);
  assert.equal(passed, false);
});
