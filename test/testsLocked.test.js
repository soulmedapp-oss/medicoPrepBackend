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

// Final fix wave I1/I2/I5 — the rest of the tests surface. listTests and
// createAttempt were gated, but getTest still returned no lock (so the
// frontend had nothing to render a locked state from), and both
// GET /tests/:id/questions and the completion PATCH went straight through:
// a locked test's paper could be fetched, and an attempt on one could be
// graded and written. Ruling: refuse rather than grade a narrowed paper.
const Question = require('../src/models/Question');
const User = require('../src/models/User');

const student = () => ({ _id: oid(), email: 's@x.com', subscription_plan: 'free', effective_permissions: [] });
const staff = () => ({ _id: oid(), email: 't@x.com', subscription_plan: 'free', effective_permissions: ['CanViewTests'] });
const LOCKED_TEST = () => ({
  _id: oid(), title: 'Elite mock', is_published: true, is_active: true,
  is_free: false, required_plan: 'elite', total_marks: 10,
});

test('getTest: a student gets lock on the test; staff get lock: null', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  const locked = LOCKED_TEST();
  stub(Test, 'findById', () => q(locked));
  const res = mockRes();
  await controller().getTest({ params: { id: String(locked._id) }, user: student() }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.test.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
  const asStaff = mockRes();
  await controller().getTest({ params: { id: String(locked._id) }, user: staff() }, asStaff);
  assert.equal(asStaff.body.test.lock, null, 'staff bypass entitlement entirely');
});

test('getTest: an open test reports lock: null rather than omitting the key', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Test, 'findById', () => q({ _id: oid(), title: 'Free mock', is_published: true, is_active: true, is_free: true, required_plan: 'free' }));
  const res = mockRes();
  await controller().getTest({ params: { id: String(oid()) }, user: student() }, res);
  assert.equal(res.body.test.lock, null);
});

test('listTestQuestions: a locked test → 403 UPGRADE_REQUIRED before any question is read', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  const locked = LOCKED_TEST();
  stub(Test, 'findById', () => q(locked));
  let queried = false;
  stub(Question, 'find', () => { queried = true; return q([]); });
  const res = mockRes();
  await controller().listTestQuestions({ params: { id: String(locked._id) }, user: student() }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'UPGRADE_REQUIRED');
  assert.deepEqual(res.body.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
  assert.equal(queried, false, 'the paper is never queried for a locked test');
  const asStaff = mockRes();
  await controller().listTestQuestions({ params: { id: String(locked._id) }, user: staff() }, asStaff);
  assert.equal(asStaff.statusCode, 200, JSON.stringify(asStaff.body));
  assert.equal(queried, true, 'staff still read the paper');
});

test('completing an attempt on a locked test → 403 UPGRADE_REQUIRED, nothing graded or written', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  const locked = LOCKED_TEST();
  const user = student();
  stub(TestAttempt, 'findById', () => q({
    _id: oid(), user_id: user._id, test_id: locked._id, status: 'in_progress',
    started_at: new Date(Date.now() - 60_000), answers: [],
  }));
  stub(Test, 'findById', () => q(locked));
  let graded = false;
  let written = false;
  stub(Question, 'find', () => { graded = true; return q([]); });
  stub(TestAttempt, 'findOneAndUpdate', () => { written = true; return q({ _id: oid() }); });
  const res = mockRes();
  await controller().updateAttempt({
    params: { id: String(oid()) },
    userId: String(user._id),
    user,
    body: { status: 'completed', answers: {} },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'UPGRADE_REQUIRED');
  assert.deepEqual(res.body.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
  assert.equal(graded, false, 'refuse rather than grade a narrowed paper');
  assert.equal(written, false, 'and never write the completion');
});

test('completing an attempt on an open test still grades and writes', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  const open = { _id: oid(), is_published: true, is_active: true, is_free: true, required_plan: 'free', total_marks: 10 };
  const user = student();
  const attemptId = oid();
  stub(TestAttempt, 'findById', () => q({
    _id: attemptId, user_id: user._id, test_id: open._id, status: 'in_progress',
    started_at: new Date(Date.now() - 60_000), answers: [],
  }));
  stub(Test, 'findById', () => q(open));
  stub(Question, 'find', () => q([]));
  let written = false;
  stub(TestAttempt, 'findOneAndUpdate', () => { written = true; return q({ _id: attemptId, test_id: open._id, user_id: user._id, status: 'completed', percentage: 0 }); });
  stub(TestAttempt, 'aggregate', async () => []);
  stub(TestAttempt, 'countDocuments', async () => 1);
  stub(Test, 'findByIdAndUpdate', () => q(null));
  stub(User, 'findByIdAndUpdate', () => q(null));
  const res = mockRes();
  await controller().updateAttempt({
    params: { id: String(attemptId) },
    userId: String(user._id),
    user,
    body: { status: 'completed', answers: {} },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(written, true);
});

// Final fix wave M5 — a bulk import used to accept any `required_plan` cell in
// silence, so a typo produced questions gated on a plan that does not exist.
// The value is still kept as-is (rewriting it could widen access), but the row
// is now counted and reported back in the import summary.
test('bulk CSV import: an unknown plan name is kept but reported as a warning', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Test, 'findById', () => q({ _id: oid(), subject: 'Anatomy' }));
  let insertedRows = null;
  stub(Question, 'insertMany', async (rows) => { insertedRows = rows; return rows; });
  stub(Question, 'countDocuments', async () => (insertedRows ? insertedRows.length : 0));
  stub(Test, 'findByIdAndUpdate', () => q(null));
  const csv = [
    'question_text,option_a,option_b,option_c,option_d,correct_answers,required_plan',
    'Known plan,1,2,3,4,A,elite',
    'Typo plan,1,2,3,4,A,premim',
    'Blank plan,1,2,3,4,A,',
  ].join('\n');
  const res = mockRes();
  await controller().bulkCsvTestQuestions({
    params: { id: String(oid()) },
    user: staff(),
    file: { originalname: 'q.csv', buffer: Buffer.from(csv, 'utf8') },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.inserted, 3, 'the row is imported, not rejected');
  assert.deepEqual(res.body.errors, []);
  assert.deepEqual(res.body.warnings, [
    'Row 2: unknown plan "premim" — students below tier 1 will not see this question',
  ]);
  assert.equal(insertedRows[1].required_plan, 'premim', 'the cell is kept verbatim, never silently rewritten');
});
