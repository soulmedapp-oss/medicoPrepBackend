// Final fix wave C1 — the API refusal, at controller level: a paid plan may
// never be saved at tier 0, whether it is being created or patched. The pure
// rule and its merge semantics are unit-tested in test/planPitch.test.js; this
// file pins the wiring — `createPlan` passes `null` (absent fields take their
// schema defaults, so a paid plan with no tier is caught) and `updatePlan`
// passes the stored document, so a patch that only drops the tier, or only
// adds a price, is judged on the merged result. Style:
// test/rbacUpdateDeactivate.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { createSubscriptionsController } = require('../src/controllers/subscriptionsController');

const oid = () => new mongoose.Types.ObjectId();

function q(value) {
  const chain = {
    sort: () => chain,
    select: () => chain,
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
});

const admin = { _id: oid(), effective_permissions: ['CanEditSubscriptionPlans', 'CanDeactivateSubscriptionPlans'] };

function controller() {
  return createSubscriptionsController({
    createNotification: async () => {},
    getPlansCache: () => null,
    setPlansCache: () => {},
    clearPlansCache: () => {},
  });
}

test('createPlan: a paid plan with no tier (or tier 0) is refused and never written', async () => {
  stub(SubscriptionPlan, 'findOne', () => q(null));
  let created = false;
  stub(SubscriptionPlan, 'create', async (doc) => { created = true; return doc; });
  const res = mockRes();
  await controller().createPlan({ user: admin, body: { plan_name: 'elite', display_name: 'Elite', price: 999 } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'A paid plan needs a tier of 1 or more');
  assert.equal(created, false, 'refuse before writing');

  const explicit = mockRes();
  await controller().createPlan({ user: admin, body: { plan_name: 'elite', display_name: 'Elite', price: 999, tier: 0 } }, explicit);
  assert.equal(explicit.statusCode, 400);
  assert.equal(created, false);
});

test('createPlan: a free plan at tier 0 and a tiered paid plan are both accepted', async () => {
  stub(SubscriptionPlan, 'findOne', () => q(null));
  stub(SubscriptionPlan, 'create', async (doc) => ({ _id: oid(), ...doc }));
  const free = mockRes();
  await controller().createPlan({ user: admin, body: { plan_name: 'free', display_name: 'Free', price: 0 } }, free);
  assert.equal(free.statusCode, 201, JSON.stringify(free.body));
  const paid = mockRes();
  await controller().createPlan({ user: admin, body: { plan_name: 'elite', display_name: 'Elite', price: 999, tier: 2 } }, paid);
  assert.equal(paid.statusCode, 201, JSON.stringify(paid.body));
});

test('updatePlan: dropping an existing paid plan to tier 0 is refused and never written', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, plan_name: 'elite', display_name: 'Elite', price: 999, tier: 2, is_active: true }));
  let updated = false;
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => { updated = true; return q({ _id: id }); });
  const res = mockRes();
  await controller().updatePlan({ params: { id: String(id) }, user: admin, body: { tier: 0 } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'A paid plan needs a tier of 1 or more');
  assert.equal(updated, false, 'refuse before writing');
});

test('updatePlan: putting a price on a plan still sitting at tier 0 is refused', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, plan_name: 'starter', display_name: 'Starter', price: 0, tier: 0, is_active: true }));
  let updated = false;
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => { updated = true; return q({ _id: id }); });
  const res = mockRes();
  await controller().updatePlan({ params: { id: String(id) }, user: admin, body: { price: 499 } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(updated, false);
});

test('updatePlan: an unrelated edit to an already-tiered paid plan still succeeds', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, plan_name: 'elite', display_name: 'Elite', price: 999, tier: 2, is_active: true }));
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => q({ _id: id, plan_name: 'elite', display_name: 'Elite Plus', price: 999, tier: 2, is_active: true }));
  const res = mockRes();
  await controller().updatePlan({ params: { id: String(id) }, user: admin, body: { display_name: 'Elite Plus' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});
