// Task 4 (spec §1/§2/§6): the student class list carries `lock` per row
// instead of dropping gated classes, locked rows are stripped of
// join/recording hints (youtube_url removed, has_join_link/has_recording
// false) on top of the usual student sanitizer, and the join-link 403 uses
// the uniform UPGRADE_REQUIRED body. Stubbed-model handler tests in the
// style of test/rbacMediaControllers.test.js / test/playlistsLocked.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const LiveClass = require('../src/models/LiveClass');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');

// classesController destructures tutor/settings services at require time.
const settingsService = require('../src/services/settingsService');
const tutorService = require('../src/services/tutorService');
settingsService.getOpenAiKey = async () => ({ value: 'fake-key', source: 'test' });
tutorService.requestClassSummary = async () => 'class summary';
tutorService.requestClassChat = async () => 'class chat answer';

const { createClassesController } = require('../src/controllers/classesController');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');

// Same fixture as test/playlistsLocked.test.js: free (tier 0) + elite (tier 2).
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'elite', display_name: 'Elite', tier: 2, is_active: true },
];

const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub (style: test/rbacMediaControllers.test.js).
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
  return createClassesController({ createNotification: async () => {} });
}

test('listClasses: locked classes are returned with lock and stripped of join/recording hints', async () => {
  // listClasses runs a Zoom-status refresh loop over the fetched classes
  // before mapping the response — both fixtures are already 'completed', so
  // the recomputed status matches and findByIdAndUpdate is never called, but
  // stub it anyway (style: rbacMediaControllers.test.js) so a future change
  // to that recompute can't quietly reach a live model.
  stub(LiveClass, 'findByIdAndUpdate', () => q(null));
  stub(LiveClass, 'find', () => q([
    { _id: oid(), title: 'Free class', is_published: true, is_active: true, is_free: true, status: 'completed', scheduled_date: new Date(Date.now() - 4 * 3600_000), zoom_join_url: 'z', recording_url: 'r', youtube_url: 'y' },
    { _id: oid(), title: 'Elite class', is_published: true, is_active: true, allowed_plans: ['elite'], status: 'completed', scheduled_date: new Date(Date.now() - 4 * 3600_000), zoom_join_url: 'z', recording_url: 'r', youtube_url: 'y' },
  ]));
  const res = mockRes();
  await controller().listClasses({ query: {}, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  const [open, locked] = res.body.classes;
  assert.equal(open.lock, null); assert.equal(open.has_join_link, true); assert.equal(open.has_recording, true);
  assert.deepEqual(locked.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
  assert.equal(locked.has_join_link, false); assert.equal(locked.has_recording, false);
  assert.equal(locked.youtube_url, undefined);
  assert.equal(locked.zoom_join_url, undefined, 'student sanitizer still applies');
});

test('listClasses: all=true staff branch also maps lock: null for a stable row shape', async () => {
  stub(LiveClass, 'findByIdAndUpdate', () => q(null));
  stub(LiveClass, 'find', () => q([
    { _id: oid(), title: 'Elite class', is_published: true, is_active: true, allowed_plans: ['elite'], status: 'completed', scheduled_date: new Date(Date.now() - 4 * 3600_000) },
  ]));
  const res = mockRes();
  const staff = { _id: oid(), email: 'staff@x.com', role: 'admin', is_teacher: false, subscription_plan: 'free', effective_permissions: ['CanViewClasses'] };
  await controller().listClasses({ query: { all: 'true' }, user: staff }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.classes[0].lock, null);
});

test('getClassJoinLink: locked → uniform UPGRADE_REQUIRED body', async () => {
  const scheduled_date = new Date(); // inside the join window (now to now+60m)
  const liveClass = {
    _id: oid(), is_published: true, is_active: true, allowed_plans: ['elite'],
    scheduled_date, duration_minutes: 60, zoom_join_url: 'z', meeting_link: 'm',
  };
  stub(LiveClass, 'findById', () => q(liveClass));
  const student = { _id: oid(), email: 's@x.com', role: 'student', is_teacher: false, subscription_plan: 'free', effective_permissions: ['CanAccessLiveClasses'] };
  const res = mockRes();
  await controller().getClassJoinLink({ params: { id: String(liveClass._id) }, user: student }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'UPGRADE_REQUIRED');
  assert.deepEqual(res.body.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
});
