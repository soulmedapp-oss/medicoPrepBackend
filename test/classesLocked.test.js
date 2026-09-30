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

// --- Start class (host link) — Option 1: the assigned teacher opens Zoom's
// start link from the app; no Zoom login, no admin on the day.
const { canHostClass, hostWindow } = require('../src/controllers/classesController');
const AuditLog = require('../src/models/AuditLog');

test('canHostClass / hostWindow are pure: teacher by email or CanHostAnyClass; 30 min before start until end', () => {
  const liveClass = { teacher_email: 'Rao@X.com', scheduled_date: new Date('2026-10-01T10:00:00Z'), duration_minutes: 60 };
  assert.equal(canHostClass({ email: 'rao@x.com', effective_permissions: [] }, liveClass), true);
  assert.equal(canHostClass({ email: 'other@x.com', effective_permissions: ['CanHostAnyClass'] }, liveClass), true);
  assert.equal(canHostClass({ email: 'other@x.com', effective_permissions: ['CanViewClasses'] }, liveClass), false);
  assert.equal(hostWindow(liveClass, new Date('2026-10-01T09:29:00Z')).open, false);
  assert.equal(hostWindow(liveClass, new Date('2026-10-01T09:30:00Z')).open, true);
  assert.equal(hostWindow(liveClass, new Date('2026-10-01T11:00:00Z')).open, true);
  assert.equal(hostWindow(liveClass, new Date('2026-10-01T11:01:00Z')).open, false);
});

test('getClassHostLink: the teacher gets the start link inside the window and it is audited; others are refused; students never', async () => {
  const soon = new Date(Date.now() + 5 * 60000);
  const liveClass = { _id: oid(), title: 'Renal', teacher_email: 'rao@x.com', scheduled_date: soon, duration_minutes: 60, is_active: true, is_published: true, zoom_start_url: 'https://zoom/start?zak=SECRET', zoom_join_url: 'https://zoom/j' };
  stub(LiveClass, 'findById', () => q(liveClass));
  const audits = [];
  stub(AuditLog, 'create', async (doc) => { audits.push(doc); });

  const teacher = mockRes();
  await controller().getClassHostLink({ params: { id: String(liveClass._id) }, user: { _id: oid(), email: 'rao@x.com', effective_permissions: ['CanAccessLiveClasses'] } }, teacher);
  assert.equal(teacher.statusCode, 200, JSON.stringify(teacher.body));
  assert.equal(teacher.body.url, 'https://zoom/start?zak=SECRET');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'class.host_link_opened');

  const student = mockRes();
  await controller().getClassHostLink({ params: { id: String(liveClass._id) }, user: { _id: oid(), email: 's@x.com', effective_permissions: ['CanAccessLiveClasses'] } }, student);
  assert.equal(student.statusCode, 403);

  const admin = mockRes();
  await controller().getClassHostLink({ params: { id: String(liveClass._id) }, user: { _id: oid(), email: 'a@x.com', effective_permissions: ['CanHostAnyClass'] } }, admin);
  assert.equal(admin.statusCode, 200);
});

test('getClassHostLink: outside the window → 400 naming when it opens; no start link → 404', async () => {
  const tomorrow = new Date(Date.now() + 24 * 3600000);
  const liveClass = { _id: oid(), title: 'Renal', teacher_email: 'rao@x.com', scheduled_date: tomorrow, duration_minutes: 60, is_active: true, zoom_start_url: 'https://zoom/start' };
  stub(LiveClass, 'findById', () => q(liveClass));
  const early = mockRes();
  await controller().getClassHostLink({ params: { id: String(liveClass._id) }, user: { _id: oid(), email: 'rao@x.com', effective_permissions: [] } }, early);
  assert.equal(early.statusCode, 400);
  assert.match(early.body.error, /can be started from/);
  assert.ok(early.body.opens_at);

  stub(LiveClass, 'findById', () => q({ ...liveClass, scheduled_date: new Date(), zoom_start_url: '', meeting_link: '' }));
  const none = mockRes();
  await controller().getClassHostLink({ params: { id: String(liveClass._id) }, user: { _id: oid(), email: 'rao@x.com', effective_permissions: [] } }, none);
  assert.equal(none.statusCode, 404);
});

test('listClasses: the assigned teacher\'s student row carries can_host; other students false; the start link itself never leaves the student branch', async () => {
  const mine = { _id: oid(), title: 'Mine', is_published: true, is_active: true, is_free: true, status: 'completed', teacher_email: 'rao@x.com', zoom_start_url: 'SECRET' };
  const theirs = { _id: oid(), title: 'Theirs', is_published: true, is_active: true, is_free: true, status: 'completed', teacher_email: 'other@x.com', zoom_start_url: 'SECRET' };
  stub(LiveClass, 'find', () => q([mine, theirs]));
  const Video = require('../src/models/Video');
  stub(Video, 'find', () => q([]));
  const res = mockRes();
  await controller().listClasses({ query: {}, user: { _id: oid(), email: 'rao@x.com', subscription_plan: 'free', effective_permissions: ['CanAccessLiveClasses'] } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const [a, b] = res.body.classes;
  assert.equal(a.can_host, true);
  assert.equal(b.can_host, false);
  assert.equal(a.zoom_start_url, undefined, 'the row flag replaces the link; the link comes from /host-link');
});
