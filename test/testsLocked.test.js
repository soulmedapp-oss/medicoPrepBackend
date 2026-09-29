// Task 4 (spec §1/§2/§6): student test lists carry `lock` per row instead of
// hiding gated tests, and a locked test can't be started — createAttempt
// refuses with the uniform UPGRADE_REQUIRED body before any TestAttempt is
// written. Stubbed-model handler tests in the style of
// test/testsAttempts.test.js / test/rbacTestsVisibility.test.js /
// test/playlistsLocked.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Test = require('../src/models/Test');
const TestAttempt = require('../src/models/TestAttempt');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { createTestsController } = require('../src/controllers/testsController');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');

// Same fixture as test/playlistsLocked.test.js: free (tier 0) + elite (tier 2).
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'elite', display_name: 'Elite', tier: 2, is_active: true },
];

const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub (style: test/testsAttempts.test.js).
function q(value) {
  const chain = {
    sort: () => chain,
    select: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const originals = [];
function stub(obj, key, fn) {
  originals.push([obj, key, obj[key]]);
  obj[key] = fn;
}
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
  invalidateEntitlementPlans();
});

function controller() {
  return createTestsController({
    createNotification: async () => {},
    broadcastUserEvent: () => {},
    enqueueTutorSession: async () => {},
  });
}

test('listTests: every row carries lock; a required_plan the student is below locks it', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Test, 'find', () => q([{ _id: oid(), title: 'Free mock', is_free: true, required_plan: 'free' }, { _id: oid(), title: 'Elite mock', is_free: false, required_plan: 'elite' }]));
  const res = mockRes();
  await controller().listTests({ query: {}, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.body.tests[0].lock, null);
  assert.deepEqual(res.body.tests[1].lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
});

test('listTests: all=true staff branch also maps lock: null for a stable row shape', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Test, 'find', () => q([{ _id: oid(), title: 'Elite mock', is_free: false, required_plan: 'elite' }]));
  const res = mockRes();
  await controller().listTests({ query: { all: 'true' }, user: { _id: oid(), subscription_plan: 'free', effective_permissions: ['CanViewTests'] } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tests[0].lock, null);
});

test('createAttempt: locked test → 403 UPGRADE_REQUIRED and no attempt written; staff bypass', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Test, 'findById', () => q({ _id: oid(), is_published: true, is_active: true, is_free: false, required_plan: 'elite', total_marks: 10 }));
  let created = false;
  stub(TestAttempt, 'create', async () => { created = true; return { _id: oid() }; });
  const res = mockRes();
  await controller().createAttempt({ params: { id: String(oid()) }, user: { _id: oid(), email: 's@x.com', subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'UPGRADE_REQUIRED');
  assert.equal(res.body.lock.required_plan, 'elite');
  assert.equal(created, false, 'refuse before writing');
  const staff = mockRes();
  await controller().createAttempt({ params: { id: String(oid()) }, user: { _id: oid(), email: 't@x.com', subscription_plan: 'free', effective_permissions: ['CanViewTests'] } }, staff);
  assert.equal(staff.statusCode, 201);
});
