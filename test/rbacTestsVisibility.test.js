// Fix round 1 (Task 6 review): item A and item B each split a single "isStaff"
// predicate into two separate permission checks. These tests pin the split so a
// future edit can't silently re-merge them. See the "Fix round 1" section of
// task-6-report.md for which OLD-code assertion each test would have failed and why.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Test = require('../src/models/Test');
const Question = require('../src/models/Question');
const TestAttempt = require('../src/models/TestAttempt');
const { createTestsController } = require('../src/controllers/testsController');
// Task 2: every plan-gated handler now resolves the caller's tier through
// entitlement.viewerFor, which reads the active SubscriptionPlan rows. Stub
// that one query (there is no database here) and drop the 60 s plan cache
// between tests so one test's fixture can never leak into the next.
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { invalidateEntitlementPlans, questionPlanClause, buildViewer } = require('../src/utils/entitlement');
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'basic', display_name: 'Basic', tier: 1, is_active: true },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
  { plan_name: 'ultimate', display_name: 'Ultimate', tier: 3, is_active: true },
];


const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub (same shape as test/testsAttempts.test.js).
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
test.beforeEach(() => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
});
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
  invalidateEntitlementPlans();
});

function controller() {
  return createTestsController({ createNotification: async () => {}, broadcastUserEvent: () => {} });
}

// --- Item B: listTestQuestions answer-key predicate (spec 5.2: CanViewQuestions only) ---

test('listTestQuestions: CanViewTests sees the test but NOT the answer key', async () => {
  const testId = oid();
  stub(Test, 'findById', () => q({ _id: testId, is_published: true, is_active: true }));
  const question = {
    _id: oid(), correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
    media: [{ role: 'explanation' }, { role: 'stem' }],
  };
  stub(Question, 'find', () => q([question]));
  const res = mockRes();
  await controller().listTestQuestions({
    params: { id: String(testId) }, userId: String(oid()),
    user: { effective_permissions: ['CanViewTests'] },
  }, res);
  assert.equal(res.statusCode, 200);
  const [returned] = res.body.questions;
  assert.equal(returned.correct_answers, undefined);
  assert.equal(returned.explanation, undefined);
  assert.equal(returned.explanation_image_url, undefined);
});

test('listTestQuestions: CanViewQuestions sees the answer key', async () => {
  const testId = oid();
  stub(Test, 'findById', () => q({ _id: testId, is_published: true, is_active: true }));
  const question = { _id: oid(), correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png' };
  stub(Question, 'find', () => q([question]));
  const res = mockRes();
  await controller().listTestQuestions({
    params: { id: String(testId) }, userId: String(oid()),
    user: { effective_permissions: ['CanViewQuestions'] },
  }, res);
  assert.equal(res.statusCode, 200);
  const [returned] = res.body.questions;
  assert.deepEqual(returned.correct_answers, ['1']);
  assert.equal(returned.explanation, 'why');
  assert.equal(returned.explanation_image_url, 'x.png');
});

test('listTestQuestions: CanAccessTests (plain student) is still stripped', async () => {
  const testId = oid();
  stub(Test, 'findById', () => q({ _id: testId, is_published: true, is_active: true }));
  const question = { _id: oid(), correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png' };
  stub(Question, 'find', () => q([question]));
  const res = mockRes();
  await controller().listTestQuestions({
    params: { id: String(testId) }, userId: String(oid()),
    user: { effective_permissions: ['CanAccessTests'] },
  }, res);
  assert.equal(res.statusCode, 200);
  const [returned] = res.body.questions;
  assert.equal(returned.correct_answers, undefined);
  assert.equal(returned.explanation, undefined);
  assert.equal(returned.explanation_image_url, undefined);
});

// --- Item A: getTestStats splits test-content visibility from attempts widening ---

test('getTestStats: CanViewTests unlocks a draft/inactive test but is NOT widened to other users\' attempts', async () => {
  const testId = oid();
  const requesterId = oid();
  stub(Test, 'findById', () => q({ _id: testId, is_active: false, is_published: true, total_marks: 100 }));
  stub(TestAttempt, 'aggregate', async () => [{ _id: null, total: 0, scored: 0 }]);
  const findOneCalls = [];
  stub(TestAttempt, 'findOne', (filter) => { findOneCalls.push(filter); return q(null); });
  stub(TestAttempt, 'find', () => q([]));
  stub(TestAttempt, 'countDocuments', () => q(0));

  const res = mockRes();
  await controller().getTestStats({
    params: { id: String(testId) },
    userId: String(requesterId),
    user: { effective_permissions: ['CanViewTests'] },
    query: { attempt_id: String(oid()) },
  }, res);

  // Visibility: a CanViewTests holder can see a draft test's stats.
  assert.equal(res.statusCode, 200);
  // Widening: without CanViewAllAttempts, every TestAttempt.findOne lookup is
  // still scoped to the caller's own attempts.
  assert.ok(findOneCalls.length > 0, 'expected at least one attempt lookup');
  assert.ok(
    findOneCalls.every((filter) => String(filter.user_id) === String(requesterId)),
    'attempt lookups must stay scoped to the caller when CanViewAllAttempts is absent'
  );
});

test('getTestStats: CanViewAllAttempts alone does not unlock a draft/inactive test', async () => {
  const testId = oid();
  stub(Test, 'findById', () => q({ _id: testId, is_active: false, is_published: true, total_marks: 100 }));
  stub(TestAttempt, 'aggregate', async () => [{ _id: null, total: 0, scored: 0 }]);
  stub(TestAttempt, 'findOne', () => q(null));
  stub(TestAttempt, 'find', () => q([]));
  stub(TestAttempt, 'countDocuments', () => q(0));

  const res = mockRes();
  await controller().getTestStats({
    params: { id: String(testId) },
    userId: String(oid()),
    user: { effective_permissions: ['CanViewAllAttempts'] },
    query: {},
  }, res);

  assert.equal(res.statusCode, 404);
});

// --- Fix round 1: the tier rule as the HANDLER actually applies it ---
// The unit tests pin questionPlanClause; these pin that listTestQuestions hands
// exactly that clause to Mongo, for a viewer at tier 0 and one at tier 2, so a
// future edit cannot quietly widen or narrow what students are asked.
function captureQuestionFilter(user) {
  const testId = oid();
  stub(Test, 'findById', () => q({ _id: testId, is_published: true, is_active: true }));
  const seen = [];
  stub(Question, 'find', (filter) => { seen.push(filter); return q([]); });
  return { testId, seen, req: { params: { id: String(testId) }, userId: String(oid()), user } };
}

test('listTestQuestions: a free student is asked only for questions at tier 0', async () => {
  const { seen, req } = captureQuestionFilter({ effective_permissions: ['CanAccessTests'], subscription_plan: 'free' });
  const res = mockRes();
  await controller().listTestQuestions(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].is_active, true);
  assert.deepEqual(seen[0].required_plan, questionPlanClause(buildViewer({ subscription_plan: 'free' }, PLANS)));
  assert.deepEqual(seen[0].required_plan, { $in: ['free', '', null] });
});

test('listTestQuestions: a premium student is asked for everything except the tiers above them', async () => {
  const { seen, req } = captureQuestionFilter({ effective_permissions: ['CanAccessTests'], subscription_plan: 'premium' });
  const res = mockRes();
  await controller().listTestQuestions(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen[0].required_plan, questionPlanClause(buildViewer({ subscription_plan: 'premium' }, PLANS)));
  assert.deepEqual(seen[0].required_plan.$nin.sort(), ['advance', 'ultimate'], 'only the tier-3 plan and its legacy alias');
});

// The staff bypass is untouched: no plan clause at all, and deactivated
// questions stay visible to them.
test('listTestQuestions: a CanViewQuestions holder gets no plan or is_active narrowing', async () => {
  const { seen, req } = captureQuestionFilter({ effective_permissions: ['CanViewQuestions'], subscription_plan: 'free' });
  await controller().listTestQuestions(req, mockRes());
  assert.equal(seen[0].required_plan, undefined);
  assert.equal(seen[0].is_active, undefined);
});
