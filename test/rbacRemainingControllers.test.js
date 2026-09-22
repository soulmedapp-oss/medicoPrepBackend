// Controller-level allow/deny tests (Task 9) for the inline `role === 'admin'`
// checks removed from subscriptionsController.js (createSubscription,
// updateSubscription, deleteSubscription, extendSubscription) and
// paymentsController.js (listAllPayments). Access for these actions is now
// decided entirely at the route level (CanAddSubscriptions,
// CanEditSubscriptions, CanDeactivateSubscriptions, CanViewAllPayments via
// authorize()), so once a request reaches the controller it must proceed
// regardless of the caller's `role` field.
//
// Fix round 1, item C: the original version of this file only had "allow"
// tests asserting a bare status code. Per the coordinator's dispatch (which
// required allow AND deny tests for these removals), this version adds:
//   (1) DENY — for each route, pulls the route's ACTUAL rule middleware off
//       its real router (via listRoutes, same as the coverage test) and runs
//       THAT middleware with a permissionless caller, asserting the exact
//       403 body — proving this specific route denies a caller lacking its
//       specific code (something the generic authorize() unit test cannot
//       show, since it doesn't know which code any given route uses).
//   (2) STRONGER ALLOW — a non-admin caller holding ONLY the route's code
//       succeeds, with the stubbed model calls asserted (not just the status
//       code): listAllPayments must query the UNSCOPED `{}` filter (a
//       regression that silently scoped the ledger would fail this); the
//       subscription mutations assert exactly what was written/touched.
// createSubscription's behavior (provisioning the plan for the CALLER,
// req.userId) is pre-existing and intentionally unchanged; its allow test
// only asserts what it actually does.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');

const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const Subscription = require('../src/models/Subscription');
const Payment = require('../src/models/Payment');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');

const { createSubscriptionsController } = require('../src/controllers/subscriptionsController');
const { createPaymentsController } = require('../src/controllers/paymentsController');
const createSubscriptionsRoutes = require('../src/routes/subscriptionsRoutes');
const createPaymentsRoutes = require('../src/routes/paymentsRoutes');
const { listRoutes } = require('../src/rbac/listRoutes');

const oid = () => new mongoose.Types.ObjectId();

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
// Task 11: recordAudit is now wired into deletePlan/updatePlan/deleteSubscription.
// Default it to a silent no-op so pre-existing tests don't hit the real model.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

function q(value) {
  const chain = {
    sort: () => chain,
    limit: () => chain,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function nonAdminUser(extra) {
  return { _id: oid(), email: 'teacher@x.com', role: 'teacher', is_teacher: true, full_name: 'A Teacher', ...extra };
}

function fakeSubscriptionDoc(overrides) {
  const doc = {
    _id: oid(),
    user_id: oid(),
    plan: 'monthly',
    status: 'active',
    is_active: true,
    start_date: new Date(),
    end_date: new Date(Date.now() + 86400000),
    toObject() { return { ...doc }; },
    async save() { return doc; },
    ...overrides,
  };
  return doc;
}

function subsController() {
  return createSubscriptionsController({
    createNotification: async () => {},
    getPlansCache: () => null,
    setPlansCache: () => {},
    clearPlansCache: () => {},
  });
}

// --- Real routers, built exactly like server.js builds them, so we can pull
// each route's ACTUAL rule middleware instance off the real stack. authMiddleware
// is a pass-through here — we're testing the rule, not login — matching the
// same "isolate the rule" approach as test/rbacRouteOrdering.test.js.
const pass = (req, res, next) => next();
const subsApp = express();
subsApp.use(createSubscriptionsRoutes({
  authMiddleware: pass,
  createNotification: async () => {},
  getPlansCache: () => null,
  setPlansCache: () => {},
  clearPlansCache: () => {},
}));
const paymentsApp = express();
paymentsApp.use(createPaymentsRoutes({ authMiddleware: pass }));

function codesFor(app, method, path) {
  const route = listRoutes(app).find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} is registered`);
  assert.equal(route.rules.length, 1, `${method} ${path} declares exactly one rule`);
  return route.rules[0].codes;
}

// Mirrors listRoutes' own walk, but returns the actual rule HANDLER function
// (not just its recorded codes) so the deny tests can invoke the real thing.
function ruleHandlerFor(app, method, path) {
  let found = null;
  (function walk(stack) {
    (stack || []).forEach((layer) => {
      if (found) return;
      if (layer.route) {
        if (layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
          found = layer.route.stack.map((l) => l.handle).find((h) => h && h.rbacRule) || null;
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack);
      }
    });
  })((app.router || app._router).stack);
  return found;
}

function denyTest(label, app, method, path) {
  test(`DENY: ${label} — the route's own rule refuses a caller with no permissions, with exactly its required codes`, () => {
    const codes = codesFor(app, method, path);
    const handler = ruleHandlerFor(app, method, path);
    assert.ok(handler, 'the rule handler was found on the real route');
    const req = { user: { effective_permissions: [] } };
    const res = mockRes();
    let nexted = false;
    handler(req, res, () => { nexted = true; });
    assert.equal(nexted, false, 'next() must not be called');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Permission denied', required: codes });
  });
}

denyTest('POST /subscriptions (createSubscription)', subsApp, 'POST', '/subscriptions');
denyTest('PATCH /subscriptions/:id (updateSubscription)', subsApp, 'PATCH', '/subscriptions/:id');
denyTest('DELETE /subscriptions/:id (deleteSubscription)', subsApp, 'DELETE', '/subscriptions/:id');
denyTest('POST /subscriptions/:id/extend (extendSubscription)', subsApp, 'POST', '/subscriptions/:id/extend');
denyTest('GET /payments/all (listAllPayments)', paymentsApp, 'GET', '/payments/all');

test('ALLOW (stronger): createSubscription — a non-admin caller holding only CanAddSubscriptions succeeds and provisions the plan for the CALLER (req.userId), matching existing (unchanged) behavior', async () => {
  const codes = codesFor(subsApp, 'POST', '/subscriptions');
  const caller = nonAdminUser({ effective_permissions: codes });
  stub(User, 'findById', () => q(caller));
  stub(SubscriptionPlan, 'findOne', () => q({ plan_name: 'monthly', is_active: true, price: 100 }));
  const createCalls = [];
  stub(Subscription, 'create', async (data) => { createCalls.push(data); return { ...data, _id: oid() }; });
  stub(User, 'findByIdAndUpdate', () => q(null));
  const req = { body: { plan: 'monthly', status: 'active' }, userId: String(caller._id), user: caller };
  const res = mockRes();
  await subsController().createSubscription(req, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(createCalls.length, 1);
  assert.equal(String(createCalls[0].user_id), String(caller._id), 'provisions the CALLER, not an admin-chosen target — pre-existing behavior, left unchanged');
  assert.equal(createCalls[0].user_email, caller.email);
  assert.equal(createCalls[0].plan, 'monthly');
});

test('ALLOW (stronger): updateSubscription — a non-admin caller holding only CanEditSubscriptions succeeds and writes exactly the requested fields to the targeted subscription', async () => {
  const codes = codesFor(subsApp, 'PATCH', '/subscriptions/:id');
  const caller = nonAdminUser({ effective_permissions: codes });
  const sub = fakeSubscriptionDoc({ plan: 'monthly', status: 'active' });
  stub(Subscription, 'findById', async (id) => { assert.equal(String(id), String(sub._id)); return sub; });
  const updateCalls = [];
  stub(User, 'findByIdAndUpdate', (id, update) => { updateCalls.push({ id, update }); return q(null); });
  const req = { params: { id: String(sub._id) }, body: { status: 'cancelled' }, userId: String(caller._id), user: caller };
  const res = mockRes();
  await subsController().updateSubscription(req, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(sub.status, 'cancelled', 'the targeted subscription document was mutated');
  assert.equal(sub.plan, 'monthly', 'a field not in the request body is left alone');
  assert.equal(updateCalls.length, 1);
  assert.equal(String(updateCalls[0].id), String(sub.user_id), 'the subscription owner is the one whose denormalized status is refreshed');
});

test('ALLOW (stronger): deleteSubscription — a non-admin caller holding only CanDeactivateSubscriptions succeeds and deactivates exactly the targeted subscription', async () => {
  const codes = codesFor(subsApp, 'DELETE', '/subscriptions/:id');
  const caller = nonAdminUser({ effective_permissions: codes });
  const sub = fakeSubscriptionDoc({ status: 'active', is_active: true });
  stub(Subscription, 'findById', async (id) => { assert.equal(String(id), String(sub._id)); return sub; });
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const req = { params: { id: String(sub._id) }, userId: String(caller._id), user: caller };
  const res = mockRes();
  await subsController().deleteSubscription(req, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(sub.is_active, false);
  assert.equal(sub.status, 'cancelled');
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'subscription.deactivated');
  assert.equal(saved.target_type, 'subscription');
});

test('deleteSubscription: a not-found subscription writes nothing to the audit log', async () => {
  stub(Subscription, 'findById', async () => null);
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await subsController().deleteSubscription({ params: { id: String(oid()) }, user: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});

// --- deletePlan / updatePlan (subscription_plan) ---

function fakePlanDoc(overrides) {
  const doc = {
    _id: oid(),
    plan_name: 'monthly',
    display_name: 'Monthly',
    is_active: true,
    toObject() { return { ...doc }; },
    async save() { return doc; },
    ...overrides,
  };
  return doc;
}

test('deletePlan: a successful deactivation writes subscription_plan.deactivated with target_* only', async () => {
  const plan = fakePlanDoc({});
  stub(SubscriptionPlan, 'findById', async () => plan);
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await subsController().deletePlan({ params: { id: String(plan._id) }, user: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'subscription_plan.deactivated');
  assert.equal(saved.target_type, 'subscription_plan');
  assert.equal(saved.target_label, 'Monthly');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

test('deletePlan: a not-found plan writes nothing to the audit log', async () => {
  stub(SubscriptionPlan, 'findById', async () => null);
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await subsController().deletePlan({ params: { id: String(oid()) }, user: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});

test('updatePlan: deactivating (is_active true -> false) writes subscription_plan.deactivated', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, is_active: true, plan_name: 'monthly', display_name: 'Monthly' }));
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, plan_name: 'monthly', display_name: 'Monthly' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await subsController().updatePlan({
    params: { id: String(id) }, user: { effective_permissions: ['CanEditSubscriptionPlans', 'CanDeactivateSubscriptionPlans'] }, body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'subscription_plan.deactivated');
});

test('updatePlan: reactivating (is_active false -> true) writes subscription_plan.reactivated', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, is_active: false, plan_name: 'monthly', display_name: 'Monthly' }));
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, plan_name: 'monthly', display_name: 'Monthly' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await subsController().updatePlan({
    params: { id: String(id) }, user: { effective_permissions: ['CanEditSubscriptionPlans', 'CanDeactivateSubscriptionPlans'] }, body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'subscription_plan.reactivated');
});

test('updatePlan: a refused update writes nothing to the audit log', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, is_active: true, plan_name: 'monthly', display_name: 'Monthly' }));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await subsController().updatePlan({
    params: { id: String(id) }, user: { effective_permissions: [] }, body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});

test('ALLOW (stronger): extendSubscription — a non-admin caller holding only CanEditSubscriptions succeeds and extends exactly the targeted subscription by extend_days', async () => {
  const codes = codesFor(subsApp, 'POST', '/subscriptions/:id/extend');
  const caller = nonAdminUser({ effective_permissions: codes });
  const originalEnd = new Date('2026-01-01T00:00:00.000Z');
  const sub = fakeSubscriptionDoc({ end_date: originalEnd, status: 'expired' });
  stub(User, 'findById', () => q(caller));
  stub(Subscription, 'findById', async (id) => { assert.equal(String(id), String(sub._id)); return sub; });
  const updateCalls = [];
  stub(User, 'findByIdAndUpdate', (id, update) => { updateCalls.push({ id, update }); return q(null); });
  const req = { params: { id: String(sub._id) }, body: { extend_days: 10 }, userId: String(caller._id), user: caller };
  const res = mockRes();
  await subsController().extendSubscription(req, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(sub.status, 'active');
  const expected = new Date(originalEnd);
  expected.setDate(expected.getDate() + 10);
  assert.equal(sub.end_date.getTime(), expected.getTime(), 'end_date was extended by exactly extend_days from its previous value');
  assert.equal(updateCalls.length, 1);
  assert.equal(String(updateCalls[0].id), String(sub.user_id));
});

test('ALLOW (stronger): listAllPayments — a non-admin caller holding only CanViewAllPayments succeeds, and Payment.find is called with the UNSCOPED {} filter', async () => {
  const codes = codesFor(paymentsApp, 'GET', '/payments/all');
  const caller = nonAdminUser({ effective_permissions: codes });
  const findCalls = [];
  stub(Payment, 'find', (filter) => { findCalls.push(filter); return q([]); });
  const req = { query: {}, userId: String(caller._id), user: caller };
  const res = mockRes();
  await createPaymentsController().listAllPayments(req, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(findCalls.length, 1);
  assert.deepEqual(findCalls[0], {}, 'the admin ledger view must not be silently scoped to the caller');
});
