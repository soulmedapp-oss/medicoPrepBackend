// Final fix wave C2 + I3: the student dashboard obeys the same entitlement
// rule as the list endpoints. `upcoming_classes` used to be raw LiveClass
// documents — meeting_link, recording_url and every zoom_* field included — so
// a free student could read a plan-gated class's join link straight off their
// home page, bypassing both the list sanitizer and the /classes/:id/join gate.
// Rows now go through utils/classProjection (the same projection listClasses
// uses) and carry `lock`; `recent_attempts` carry `test_lock` so the frontend
// can gate the Retake affordance without re-implementing plan ranks.
// Stubbed-model handler tests in the style of test/classesLocked.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Doubt = require('../src/models/Doubt');
const LiveClass = require('../src/models/LiveClass');
const Test = require('../src/models/Test');
const TestAttempt = require('../src/models/TestAttempt');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { createDashboardController } = require('../src/controllers/dashboardController');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');

// Same fixture as test/classesLocked.test.js / test/playlistsLocked.test.js.
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
];

const oid = () => new mongoose.Types.ObjectId();

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

const PREMIUM_TEST_ID = oid();
const FREE_TEST_ID = oid();

// The three reads the dashboard makes that this file cares about are stubbed
// with fixtures; everything else returns empty so the handler runs to the end.
function stubDashboard() {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Doubt, 'countDocuments', async () => 0);
  stub(LiveClass, 'countDocuments', async () => 0);
  stub(TestAttempt, 'aggregate', async (pipeline) => {
    const stages = JSON.stringify(pipeline);
    if (stages.includes('tests')) {
      // recent_attempts / subject_progress both $lookup the tests collection;
      // only recent_attempts projects test_title.
      if (stages.includes('test_title')) {
        return [
          { _id: oid(), test_id: PREMIUM_TEST_ID, percentage: 40, test_title: 'Premium mock' },
          { _id: oid(), test_id: FREE_TEST_ID, percentage: 90, test_title: 'Free mock' },
        ];
      }
      return [];
    }
    return [{ _id: null, count: 2, avgPercentage: 65 }];
  });
  stub(TestAttempt, 'findOne', () => q(null));
  stub(TestAttempt, 'find', () => q([]));
  stub(Test, 'find', () => q([
    { _id: PREMIUM_TEST_ID, is_free: false, required_plan: 'premium' },
    { _id: FREE_TEST_ID, is_free: true, required_plan: 'free' },
  ]));
  stub(LiveClass, 'find', () => q([
    {
      _id: oid(), title: 'Free class', is_published: true, is_active: true, is_free: true,
      status: 'scheduled', scheduled_date: new Date(Date.now() + 3600_000),
      meeting_link: 'https://meet/free', recording_url: 'https://rec/free', youtube_url: 'https://yt/free',
      zoom_join_url: 'https://zoom/join', zoom_start_url: 'https://zoom/start', zoom_recording_password: 'p',
    },
    {
      _id: oid(), title: 'Premium class', is_published: true, is_active: true, allowed_plans: ['premium'],
      status: 'scheduled', scheduled_date: new Date(Date.now() + 7200_000),
      meeting_link: 'https://meet/prem', recording_url: 'https://rec/prem', youtube_url: 'https://yt/prem',
      zoom_join_url: 'https://zoom/join2', zoom_start_url: 'https://zoom/start2', zoom_recording_password: 'p',
    },
  ]));
}

async function studentDashboard() {
  stubDashboard();
  const userId = oid();
  const res = mockRes();
  await createDashboardController().getStudentDashboard(
    { userId: String(userId), user: { _id: userId, subscription_plan: 'free', effective_permissions: [] } },
    res
  );
  return res;
}

test('student dashboard: upcoming_classes never carry a join link, a recording URL or any zoom field', async () => {
  const res = await studentDashboard();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const rows = res.body.upcoming_classes;
  assert.equal(rows.length, 2);
  const leaked = ['meeting_link', 'recording_url', 'zoom_join_url', 'zoom_start_url', 'zoom_recording_files', 'zoom_recording_password'];
  rows.forEach((row) => {
    leaked.forEach((field) => assert.equal(row[field], undefined, `${field} must never reach a student`));
  });
});

test('student dashboard: a premium-only class row is locked and stripped of playback hints', async () => {
  const res = await studentDashboard();
  const [open, locked] = res.body.upcoming_classes;
  assert.equal(open.lock, null);
  assert.equal(open.has_join_link, true);
  assert.equal(open.has_recording, true);
  assert.equal(open.youtube_url, 'https://yt/free');
  assert.deepEqual(locked.lock, { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.equal(locked.required_plan, undefined, 'lock is the only place the requirement is reported');
  assert.equal(locked.has_join_link, false);
  assert.equal(locked.has_recording, false);
  assert.equal(locked.youtube_url, undefined, 'youtube_url plays with no server gate at all');
});

test('student dashboard: recent_attempts carry test_lock — null when the test is open', async () => {
  const res = await studentDashboard();
  const [premium, free] = res.body.recent_attempts;
  assert.deepEqual(premium.test_lock, { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.equal(free.test_lock, null);
});

test('student dashboard: resolving recent_attempts locks takes exactly one Test query', async () => {
  stubDashboard();
  let calls = 0;
  const ids = [];
  stub(Test, 'find', (filter) => { calls += 1; ids.push(filter); return q([]); });
  const userId = oid();
  const res = mockRes();
  await createDashboardController().getStudentDashboard(
    { userId: String(userId), user: { _id: userId, subscription_plan: 'free', effective_permissions: [] } },
    res
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls, 1);
  assert.equal(ids[0]._id.$in.length, 2, 'both attempts resolved in one $in');
  // An unresolvable test cannot be judged, so it reports no lock rather than
  // guessing — the same shape as an open test.
  assert.equal(res.body.recent_attempts[0].test_lock, null);
});
