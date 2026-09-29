// Controller-level allow/deny tests (Task 7) for the inline checks being
// replaced in classesController.js / videosController.js. Written BEFORE the
// controller edits so each one demonstrates the actual behavior change
// (see task-7-report.md for the RED run). Mongoose statics are stubbed
// in-process, style: test/testsAttempts.test.js, test/rbacTestsVisibility.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const LiveClass = require('../src/models/LiveClass');
const Video = require('../src/models/Video');
const Playlist = require('../src/models/Playlist');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');

// classesController/videosController destructure `getOpenAiKey` /
// `requestClassSummary` etc. at require time, so these services must be
// stubbed BEFORE the controllers are first required in this process.
const settingsService = require('../src/services/settingsService');
const tutorService = require('../src/services/tutorService');
settingsService.getOpenAiKey = async () => ({ value: 'fake-key', source: 'test' });
tutorService.requestClassSummary = async () => 'class summary';
tutorService.requestClassChat = async () => 'class chat answer';
tutorService.requestVideoSummary = async () => 'video summary';
tutorService.requestVideoChat = async () => 'video chat answer';

const { createClassesController } = require('../src/controllers/classesController');
const { createVideosController } = require('../src/controllers/videosController');
// Task 2: every plan-gated handler now resolves the caller's tier through
// entitlement.viewerFor, which reads the active SubscriptionPlan rows. Stub
// that one query (there is no database here) and drop the 60 s plan cache
// between tests so one test's fixture can never leak into the next.
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'basic', display_name: 'Basic', tier: 1, is_active: true },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
  { plan_name: 'ultimate', display_name: 'Ultimate', tier: 3, is_active: true },
];


const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub (style: test/testsAttempts.test.js).
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
  invalidateEntitlementPlans();
});
// Task 11: recordAudit is now wired into updateClass/deleteClass/updateVideo/
// deleteVideo. Default it to a silent no-op so pre-existing tests don't hit
// the real model.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
  stub(SubscriptionPlan, 'find', () => q(PLANS));
});

function makeUser(effective_permissions, extra) {
  return {
    _id: oid(),
    email: 'user@x.com',
    role: 'student',
    is_teacher: false,
    subscription_plan: 'free',
    effective_permissions,
    ...extra,
  };
}

function classesController() {
  return createClassesController({ createNotification: async () => {} });
}
function videosController() {
  return createVideosController();
}

// --- classesController.listClasses ---

test('listClasses: holder of only CanAccessLiveClasses gets the sanitized (non-all) list', async () => {
  const u = makeUser(['CanAccessLiveClasses']);
  const liveClass = {
    _id: oid(), title: 'A', scheduled_date: new Date(Date.now() - 3600_000), duration_minutes: 60,
    status: 'completed', is_active: true, is_published: true, allowed_plans: [],
    meeting_link: 'secret-link', recording_url: 'secret-rec', zoom_recording_files: [{ file_type: 'MP4' }],
    zoom_recording_password: 'pw', zoom_start_url: 'start-url', zoom_join_url: 'join-url',
  };
  stub(LiveClass, 'find', () => q([liveClass]));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: {} };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.classes.length, 1);
  const out = res.body.classes[0];
  ['meeting_link', 'recording_url', 'zoom_recording_files', 'zoom_recording_password', 'zoom_start_url', 'zoom_join_url']
    .forEach((field) => assert.equal(out[field], undefined, `${field} must be stripped`));
});

test('listClasses: all=true — holder of CanViewClasses (role=student, no admin/teacher role) sees the full unsanitized list', async () => {
  const u = makeUser(['CanViewClasses'], { role: 'student', is_teacher: false, email: 'staff@x.com' });
  const liveClass = {
    _id: oid(), title: 'A', scheduled_date: new Date(), duration_minutes: 60, status: 'completed',
    is_active: true, is_published: false, teacher_email: 'someone-else@x.com', meeting_link: 'secret-link',
  };
  stub(LiveClass, 'find', () => q([liveClass]));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: { all: 'true' } };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.classes.length, 1);
  assert.equal(res.body.classes[0].meeting_link, 'secret-link');
});

test('listClasses: all=true — a caller with neither CanAccessLiveClasses nor CanViewClasses is refused', async () => {
  const u = makeUser([], { role: 'student', is_teacher: false });
  stub(LiveClass, 'find', () => q([]));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: { all: 'true' } };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 403);
});

test('listClasses: all=true — a caller who only passes the route gate via CanAccessLiveClasses (no CanViewClasses) is refused, no class data', async () => {
  const u = makeUser(['CanAccessLiveClasses'], { role: 'student', is_teacher: false });
  stub(LiveClass, 'find', () => q([{ _id: oid(), title: 'Secret draft', is_published: false }]));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: { all: 'true' } };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.classes, undefined);
});

// --- listClasses: zoom_start_url (Zoom HOST link) — the one exception to "no
// ownership rules" (spec section 2 / 2026-09-19 security review). Kept only
// for the class's own teacher (by email, case-insensitive) or a
// CanHostAnyClass holder; never for any other CanEditClasses holder.

test('listClasses: all=true — CanEditClasses holder who is NOT the class teacher does not get zoom_start_url', async () => {
  const u = makeUser(['CanViewClasses', 'CanEditClasses'], { role: 'teacher', is_teacher: true, email: 'other-teacher@x.com' });
  const liveClass = {
    _id: oid(), title: 'A', scheduled_date: new Date(), duration_minutes: 60, status: 'completed',
    is_active: true, is_published: true, teacher_email: 'owner-teacher@x.com', zoom_start_url: 'start-url',
  };
  stub(LiveClass, 'find', () => q([liveClass]));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: { all: 'true' } };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.classes[0].zoom_start_url, undefined);
});

test('listClasses: all=true — CanEditClasses holder who IS the class teacher (case-insensitive email match) gets zoom_start_url', async () => {
  const u = makeUser(['CanViewClasses', 'CanEditClasses'], { role: 'teacher', is_teacher: true, email: 'Teacher@X.com' });
  const liveClass = {
    _id: oid(), title: 'A', scheduled_date: new Date(), duration_minutes: 60, status: 'completed',
    is_active: true, is_published: true, teacher_email: '  teacher@x.com  ', zoom_start_url: 'start-url',
  };
  stub(LiveClass, 'find', () => q([liveClass]));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: { all: 'true' } };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.classes[0].zoom_start_url, 'start-url');
});

test('listClasses: all=true — CanHostAnyClass holder gets zoom_start_url for every class, regardless of teacher_email', async () => {
  const u = makeUser(['CanViewClasses', 'CanHostAnyClass'], { role: 'teacher', is_teacher: true, email: 'nobody-in-particular@x.com' });
  const liveClasses = [
    { _id: oid(), title: 'A', scheduled_date: new Date(), duration_minutes: 60, status: 'completed', is_active: true, is_published: true, teacher_email: 'owner-a@x.com', zoom_start_url: 'start-url-a' },
    { _id: oid(), title: 'B', scheduled_date: new Date(), duration_minutes: 60, status: 'completed', is_active: true, is_published: true, teacher_email: 'owner-b@x.com', zoom_start_url: 'start-url-b' },
  ];
  stub(LiveClass, 'find', () => q(liveClasses));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: { all: 'true' } };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.classes[0].zoom_start_url, 'start-url-a');
  assert.equal(res.body.classes[1].zoom_start_url, 'start-url-b');
});

test('listClasses: all=true — a class with an empty teacher_email never matches a caller with an empty/undefined email', async () => {
  const u = makeUser(['CanViewClasses', 'CanEditClasses'], { role: 'teacher', is_teacher: true, email: undefined });
  const liveClass = {
    _id: oid(), title: 'A', scheduled_date: new Date(), duration_minutes: 60, status: 'completed',
    is_active: true, is_published: true, teacher_email: '', zoom_start_url: 'start-url',
  };
  stub(LiveClass, 'find', () => q([liveClass]));
  stub(User, 'findById', () => q(u));
  const req = { userId: String(u._id), user: u, query: { all: 'true' } };
  const res = mockRes();
  await classesController().listClasses(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.classes[0].zoom_start_url, undefined);
});

// --- Fix round 1: the tier rule as the class handlers actually apply it ---
// A class restricted to `premium` (tier 2) is refused for a tier-1 viewer and
// allowed for a tier-3 one — the old rule needed the plan name to match exactly,
// so `ultimate` was refused here too. The 403 body is unchanged in this task.
test('getClassRecording: a premium-only class refuses a basic viewer and admits an ultimate one (higher tier includes lower)', async () => {
  const liveClass = {
    _id: oid(), is_published: true, is_active: true, recording_url: 'https://rec',
    youtube_url: '', zoom_recording_files: [], is_free: false, allowed_plans: ['premium'],
  };
  stub(LiveClass, 'findById', () => q(liveClass));
  const basic = makeUser(['CanAccessLiveClasses'], { subscription_plan: 'basic' });
  const ultimate = makeUser(['CanAccessLiveClasses'], { subscription_plan: 'ultimate' });

  const resBasic = mockRes();
  await classesController().getClassRecording(
    { userId: String(basic._id), user: basic, params: { id: String(liveClass._id) } },
    resBasic
  );
  assert.equal(resBasic.statusCode, 403);
  assert.deepEqual(resBasic.body, { error: 'Upgrade required' });

  const resUltimate = mockRes();
  await classesController().getClassRecording(
    { userId: String(ultimate._id), user: ultimate, params: { id: String(liveClass._id) } },
    resUltimate
  );
  assert.equal(resUltimate.statusCode, 200, JSON.stringify(resUltimate.body));
  assert.equal(resUltimate.body.url, 'https://rec');
});

test('listClasses: the student list hides a premium-only class from a basic viewer and shows it to an ultimate one', async () => {
  const free = { _id: oid(), title: 'Free', scheduled_date: new Date(), is_published: true, is_active: true, is_free: true, allowed_plans: [], status: 'completed' };
  const premium = { _id: oid(), title: 'Premium', scheduled_date: new Date(), is_published: true, is_active: true, is_free: false, allowed_plans: ['premium'], status: 'completed' };
  stub(LiveClass, 'find', () => q([free, premium]));
  stub(LiveClass, 'findByIdAndUpdate', () => q(null));

  const basic = makeUser(['CanAccessLiveClasses'], { subscription_plan: 'basic' });
  const resBasic = mockRes();
  await classesController().listClasses({ userId: String(basic._id), user: basic, query: {} }, resBasic);
  assert.equal(resBasic.statusCode, 200);
  assert.deepEqual(resBasic.body.classes.map((c) => c.title), ['Free']);

  const ultimate = makeUser(['CanAccessLiveClasses'], { subscription_plan: 'ultimate' });
  const resUltimate = mockRes();
  await classesController().listClasses({ userId: String(ultimate._id), user: ultimate, query: {} }, resUltimate);
  assert.deepEqual(resUltimate.body.classes.map((c) => c.title), ['Free', 'Premium']);
});

// --- classesController.getClassRecording / getClassSummary ---

test('getClassRecording: CanViewClasses bypasses the published check; plain CanAccessLiveClasses does not', async () => {
  const liveClass = {
    _id: oid(), is_published: false, is_active: true, recording_url: 'https://rec',
    youtube_url: '', zoom_recording_files: [], allowed_plans: [],
  };
  stub(LiveClass, 'findById', () => q(liveClass));
  const staff = makeUser(['CanViewClasses'], { role: 'student', is_teacher: false });
  const student = makeUser(['CanAccessLiveClasses'], { role: 'student', is_teacher: false });

  const resStaff = mockRes();
  await classesController().getClassRecording(
    { userId: String(staff._id), user: staff, params: { id: String(liveClass._id) } },
    resStaff
  );
  assert.equal(resStaff.statusCode, 200);
  assert.equal(resStaff.body.url, 'https://rec');

  const resStudent = mockRes();
  await classesController().getClassRecording(
    { userId: String(student._id), user: student, params: { id: String(liveClass._id) } },
    resStudent
  );
  assert.equal(resStudent.statusCode, 404);
});

test('getClassSummary: CanViewClasses bypasses the published check; plain CanAccessLiveClasses does not', async () => {
  const liveClass = { _id: oid(), is_published: false, is_active: true, allowed_plans: [] };
  stub(LiveClass, 'findById', () => q(liveClass));
  const staff = makeUser(['CanViewClasses'], { role: 'student', is_teacher: false });
  const student = makeUser(['CanAccessLiveClasses'], { role: 'student', is_teacher: false });

  const resStaff = mockRes();
  await classesController().getClassSummary(
    { userId: String(staff._id), user: staff, params: { id: String(liveClass._id) } },
    resStaff
  );
  assert.equal(resStaff.statusCode, 200);
  assert.equal(resStaff.body.summary, 'class summary');

  const resStudent = mockRes();
  await classesController().getClassSummary(
    { userId: String(student._id), user: student, params: { id: String(liveClass._id) } },
    resStudent
  );
  assert.equal(resStudent.statusCode, 404);
});

test('chatAboutClass: CanViewClasses bypasses the published check; plain CanAccessLiveClasses does not', async () => {
  const liveClass = { _id: oid(), is_published: false, is_active: true, allowed_plans: [] };
  stub(LiveClass, 'findById', () => q(liveClass));
  const staff = makeUser(['CanViewClasses'], { role: 'student', is_teacher: false });
  const student = makeUser(['CanAccessLiveClasses'], { role: 'student', is_teacher: false });

  const resStaff = mockRes();
  await classesController().chatAboutClass(
    { userId: String(staff._id), user: staff, params: { id: String(liveClass._id) }, body: { message: 'hi' } },
    resStaff
  );
  assert.equal(resStaff.statusCode, 200);
  assert.equal(resStaff.body.answer, 'class chat answer');

  const resStudent = mockRes();
  await classesController().chatAboutClass(
    { userId: String(student._id), user: student, params: { id: String(liveClass._id) }, body: { message: 'hi' } },
    resStudent
  );
  assert.equal(resStudent.statusCode, 404);
});

// --- classesController: ownership rule removed (canManageClass deleted) ---

test('updateClass: no ownership check remains — controller does not block by teacher_email mismatch (route-level authorize is the only gate)', async () => {
  const existing = { _id: oid(), title: 'Old', teacher_email: 'owner@x.com', is_published: false };
  stub(LiveClass, 'findById', () => q(existing));
  stub(LiveClass, 'findByIdAndUpdate', () => q({ ...existing, title: 'New' }));
  // Task 17: CanEditClasses is required for the edit itself (an is_active-unrelated
  // field, `title`, is being changed here); the point of this test is still that
  // no ownership/teacher_email check blocks a caller who is not the class's teacher.
  const caller = { _id: oid(), role: 'student', is_teacher: false, email: 'nobody@x.com', effective_permissions: ['CanEditClasses'] };
  const req = { user: caller, params: { id: String(existing._id) }, body: { title: 'New' } };
  const res = mockRes();
  await classesController().updateClass(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.liveClass.title, 'New');
});

test('deleteClass: no ownership check remains — controller does not block by teacher_email mismatch', async () => {
  const liveClass = { _id: oid(), teacher_email: 'owner@x.com', is_active: true, is_published: true, save: async function save() { return this; }, toObject() { return this; } };
  stub(LiveClass, 'findById', () => q(liveClass));
  const caller = { _id: oid(), role: 'student', is_teacher: false, email: 'nobody@x.com', effective_permissions: [] };
  const req = { user: caller, params: { id: String(liveClass._id) } };
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await classesController().deleteClass(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'class.deactivated');
  assert.equal(saved.target_type, 'class');
});

test('deleteClass: a not-found class writes nothing to the audit log', async () => {
  stub(LiveClass, 'findById', () => q(null));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await classesController().deleteClass({ user: { effective_permissions: [] }, params: { id: String(oid()) } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});

// Fix round 1, Minor 5: the reactivate direction was covered for test /
// question_bank / plan but not for updateClass.
test('updateClass: reactivating writes class.reactivated', async () => {
  const id = oid();
  stub(LiveClass, 'findById', () => q({ _id: id, is_active: false, title: 'Cardiology' }));
  stub(LiveClass, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, title: 'Cardiology' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await classesController().updateClass({
    params: { id: String(id) }, user: { effective_permissions: ['CanEditClasses', 'CanDeactivateClasses'] }, body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'class.reactivated');
});

// --- videosController.listVideos ---

test('listVideos: all=true — holder of CanViewVideos (role=student) sees the full list; plain CanAccessVideos is refused', async () => {
  const videos = [{ _id: oid(), title: 'V', is_published: false, is_active: true, allowed_plans: [] }];
  stub(Video, 'find', () => q(videos));

  const staff = makeUser(['CanViewVideos'], { role: 'student', is_teacher: false });
  stub(User, 'findById', () => q(staff));
  const resStaff = mockRes();
  await videosController().listVideos({ userId: String(staff._id), user: staff, query: { all: 'true' } }, resStaff);
  assert.equal(resStaff.statusCode, 200);
  assert.equal(resStaff.body.videos.length, 1);

  const student = makeUser(['CanAccessVideos'], { role: 'student', is_teacher: false });
  const resStudent = mockRes();
  await videosController().listVideos({ userId: String(student._id), user: student, query: { all: 'true' } }, resStudent);
  assert.equal(resStudent.statusCode, 403);
});

// --- videosController.getVideoSummary / chatAboutVideo (loadVideoForPlayback) ---
// The DB stub below returns a plain non-staff user for a fresh User.findById
// lookup (what the OLD loadVideoForUser(userId, videoId) used); the req.user
// passed to the controller carries CanViewVideos. Only the NEW code (which
// must use req.user, not a fresh DB fetch) can pass this.
//
// Final fix wave, B1: both handlers now go through loadVideoForPlayback, so
// the playlist gate (spec §5) decides them exactly as it decides playback --
// a lecture's own is_published/allowed_plans no longer grant anything.

test('getVideoSummary: the CanViewVideos bypass reads req.user, not a fresh DB lookup', async () => {
  const video = { _id: oid(), is_published: false, is_active: true, allowed_plans: [] };
  stub(Video, 'findById', () => q(video));
  stub(User, 'findById', () => q({ role: 'student', is_teacher: false, subscription_plan: 'free' }));

  const staffReqUser = makeUser(['CanViewVideos'], { role: 'student', is_teacher: false });
  const resStaff = mockRes();
  await videosController().getVideoSummary(
    { userId: String(staffReqUser._id), user: staffReqUser, params: { id: String(video._id) } },
    resStaff
  );
  assert.equal(resStaff.statusCode, 200);
  assert.equal(resStaff.body.summary, 'video summary');
});

test('getVideoSummary: a student whose lecture sits in no playlist is refused with playbacks own 403', async () => {
  const video = { _id: oid(), is_published: true, is_active: true, allowed_plans: [] };
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([]));

  const studentReqUser = makeUser(['CanAccessVideos'], { role: 'student', is_teacher: false });
  const res = mockRes();
  await videosController().getVideoSummary(
    { userId: String(studentReqUser._id), user: studentReqUser, params: { id: String(video._id) } },
    res
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Upgrade required');
});

test('getVideoSummary: an unpublished lecture inside a published, free playlist is answerable', async () => {
  const video = { _id: oid(), is_published: false, is_active: true, allowed_plans: [] };
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([
    { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: video._id }] },
  ]));

  const studentReqUser = makeUser(['CanAccessVideos'], { role: 'student', is_teacher: false });
  const res = mockRes();
  await videosController().getVideoSummary(
    { userId: String(studentReqUser._id), user: studentReqUser, params: { id: String(video._id) } },
    res
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.summary, 'video summary');
});

test('chatAboutVideo: the CanViewVideos bypass reads req.user, not a fresh DB lookup', async () => {
  const video = { _id: oid(), is_published: false, is_active: true, allowed_plans: [] };
  stub(Video, 'findById', () => q(video));
  stub(User, 'findById', () => q({ role: 'student', is_teacher: false, subscription_plan: 'free' }));

  const staffReqUser = makeUser(['CanViewVideos'], { role: 'student', is_teacher: false });
  const resStaff = mockRes();
  await videosController().chatAboutVideo(
    { userId: String(staffReqUser._id), user: staffReqUser, params: { id: String(video._id) }, body: { message: 'hi' } },
    resStaff
  );
  assert.equal(resStaff.statusCode, 200);
  assert.equal(resStaff.body.answer, 'video chat answer');
});

test('chatAboutVideo: a lecture whose only playlist was unpublished is refused, published lecture or not', async () => {
  const video = { _id: oid(), is_published: true, is_active: true, allowed_plans: [] };
  stub(Video, 'findById', () => q(video));
  // The controller's own Mongo filter already excludes unpublished
  // playlists; returning one here proves the decision function refuses it
  // too, so the gate cannot be widened by a filter change alone.
  stub(Playlist, 'find', () => q([
    { is_published: false, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: video._id }] },
  ]));

  const studentReqUser = makeUser(['CanAccessVideos'], { role: 'student', is_teacher: false });
  const res = mockRes();
  await videosController().chatAboutVideo(
    { userId: String(studentReqUser._id), user: studentReqUser, params: { id: String(video._id) }, body: { message: 'hi' } },
    res
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Upgrade required');
});

// --- videosController.listVideos: the student branch obeys the same gate ---

test('listVideos: a student sees only lectures a published, entitled playlist carries', async () => {
  const inPlaylist = { _id: oid(), title: 'In', is_published: false, is_active: true };
  const orphan = { _id: oid(), title: 'Orphan', is_published: true, is_active: true };
  stub(Video, 'find', () => q([inPlaylist, orphan]));
  stub(Playlist, 'find', () => q([
    { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: inPlaylist._id }] },
  ]));

  const student = makeUser(['CanAccessVideos'], { role: 'student', is_teacher: false });
  const res = mockRes();
  await videosController().listVideos({ userId: String(student._id), user: student, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.videos.map((video) => video.title), ['In']);
});

test('listVideos: the student branch projects through the shared student lecture allowlist', async () => {
  const { STUDENT_LECTURE_FIELDS } = require('../src/utils/studentProjection');
  let selected;
  const chain = {
    sort: () => chain,
    select: (fields) => { selected = fields; return chain; },
    lean: async () => [],
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  stub(Video, 'find', () => chain);
  stub(Playlist, 'find', () => q([]));

  const student = makeUser(['CanAccessVideos'], { role: 'student', is_teacher: false });
  const res = mockRes();
  await videosController().listVideos({ userId: String(student._id), user: student, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(selected, STUDENT_LECTURE_FIELDS);
});

// --- videosController: ownership rule removed (canManageVideo deleted) ---

test('updateVideo: no ownership check remains — controller does not block by created_by/teacher_email mismatch', async () => {
  const existing = { _id: oid(), title: 'Old', teacher_email: 'owner@x.com', created_by: oid() };
  stub(Video, 'findById', () => q(existing));
  stub(Video, 'findByIdAndUpdate', () => q({ ...existing, title: 'New' }));
  // Task 17: CanEditVideos is required for the edit itself (title, an
  // is_active-unrelated field); the point of this test is still that no
  // ownership/created_by/teacher_email check blocks a non-owner caller.
  const caller = { _id: oid(), role: 'student', is_teacher: false, email: 'nobody@x.com', effective_permissions: ['CanEditVideos'] };
  const req = { user: caller, params: { id: String(existing._id) }, body: { title: 'New' } };
  const res = mockRes();
  await videosController().updateVideo(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.video.title, 'New');
});

test('deleteVideo: no ownership check remains — controller does not block by created_by/teacher_email mismatch', async () => {
  const video = { _id: oid(), teacher_email: 'owner@x.com', created_by: oid(), is_active: true, is_published: true, save: async function save() { return this; }, toObject() { return this; } };
  stub(Video, 'findById', () => q(video));
  const caller = { _id: oid(), role: 'student', is_teacher: false, email: 'nobody@x.com', effective_permissions: [] };
  const req = { user: caller, params: { id: String(video._id) } };
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await videosController().deleteVideo(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'video.deactivated');
  assert.equal(saved.target_type, 'video');
});

// Fix round 1, Minor 5: the reactivate direction was covered for test /
// question_bank / plan but not for updateVideo.
test('updateVideo: reactivating writes video.reactivated', async () => {
  const id = oid();
  stub(Video, 'findById', () => q({ _id: id, is_active: false, title: 'Lecture 1' }));
  stub(Video, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, title: 'Lecture 1' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await videosController().updateVideo({
    params: { id: String(id) }, user: { effective_permissions: ['CanEditVideos', 'CanDeactivateVideos'] }, body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'video.reactivated');
});

test('deleteVideo: a not-found video writes nothing to the audit log', async () => {
  stub(Video, 'findById', () => q(null));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await videosController().deleteVideo({ user: { effective_permissions: [] }, params: { id: String(oid()) } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});

// --- permanentlyDeleteVideo (CanDeleteVideos): the one hard delete ---
// Route permission is covered in rbacRoutesMedia; these pin the controller's
// own guarantees: deactivated-first, Bunny-first, 404-tolerant, full cleanup,
// and an audit row that names what was destroyed.
const VideoProgress = require('../src/models/VideoProgress');
const DiscussionPost = require('../src/models/DiscussionPost');
const bunnyProvider = require('../src/services/video/bunnyProvider');
const { canHardDelete } = require('../src/controllers/videosController');

// Task 3: the hard delete also removes the lecture's discussion thread, so
// DiscussionPost.deleteMany is stubbed here too — otherwise these tests would
// reach the real model with no database behind it.
function stubCleanup({ playlists = [], progressCount = 0, discussionCount = 0 } = {}) {
  const calls = { pull: 0, progressDeleted: 0, videoDeleted: 0, discussionsDeleted: 0 };
  stub(Playlist, 'find', () => q(playlists));
  stub(Playlist, 'updateMany', async () => { calls.pull += 1; return { modifiedCount: playlists.length }; });
  stub(VideoProgress, 'countDocuments', async () => progressCount);
  stub(VideoProgress, 'deleteMany', async () => { calls.progressDeleted += 1; return { deletedCount: progressCount }; });
  stub(DiscussionPost, 'deleteMany', async () => { calls.discussionsDeleted += 1; return { deletedCount: discussionCount }; });
  stub(Video, 'deleteOne', async () => { calls.videoDeleted += 1; return { deletedCount: 1 }; });
  return calls;
}

test('canHardDelete: only a deactivated lecture qualifies', () => {
  assert.equal(canHardDelete({ is_active: false }), true);
  assert.equal(canHardDelete({ is_active: true }), false);
  assert.equal(canHardDelete({}), false);
  assert.equal(canHardDelete(null), false);
});

test('permanentlyDeleteVideo: an ACTIVE lecture is refused with 409 and nothing is touched', async () => {
  const video = { _id: oid(), title: 'Live one', is_active: true, provider: 'bunny', bunny_video_id: 'g1' };
  stub(Video, 'findById', () => q(video));
  const calls = stubCleanup();
  let bunnyCalled = false;
  stub(bunnyProvider, 'deleteVideo', async () => { bunnyCalled = true; return { deleted: true, missing: false }; });
  const res = mockRes();
  await videosController().permanentlyDeleteVideo({ user: makeUser(['CanDeleteVideos']), userId: oid(), params: { id: String(video._id) } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(bunnyCalled, false);
  assert.deepEqual(calls, { pull: 0, progressDeleted: 0, videoDeleted: 0, discussionsDeleted: 0 });
});

test('permanentlyDeleteVideo: Bunny refusal -> 502 and local records untouched', async () => {
  const video = { _id: oid(), title: 'Stuck', is_active: false, provider: 'bunny', bunny_video_id: 'g1' };
  stub(Video, 'findById', () => q(video));
  const calls = stubCleanup({ playlists: [{ _id: oid(), name: 'ENT' }] });
  stub(bunnyProvider, 'deleteVideo', async () => { throw new Error('Bunny delete video failed (500)'); });
  let audited = false;
  stub(AuditLog, 'create', async () => { audited = true; });
  const res = mockRes();
  await videosController().permanentlyDeleteVideo({ user: makeUser(['CanDeleteVideos']), userId: oid(), params: { id: String(video._id) } }, res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(calls, { pull: 0, progressDeleted: 0, videoDeleted: 0, discussionsDeleted: 0 });
  assert.equal(audited, false);
});

test('permanentlyDeleteVideo: happy path removes from Bunny, playlists, progress and the collection, and audits video.deleted', async () => {
  const video = { _id: oid(), title: 'Old lecture', subject: 'ENT', is_active: false, provider: 'bunny', bunny_video_id: 'g1', bunny_library_id: '99' };
  stub(Video, 'findById', () => q(video));
  const playlists = [{ _id: oid(), name: 'ENT Basics' }, { _id: oid(), name: 'Crash Course' }];
  const calls = stubCleanup({ playlists, progressCount: 37, discussionCount: 4 });
  let bunnyId;
  stub(bunnyProvider, 'deleteVideo', async (id) => { bunnyId = id; return { deleted: true, missing: false }; });
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await videosController().permanentlyDeleteVideo({ user: makeUser(['CanDeleteVideos']), userId: oid(), params: { id: String(video._id) } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(bunnyId, 'g1');
  assert.deepEqual(calls, { pull: 1, progressDeleted: 1, videoDeleted: 1, discussionsDeleted: 1 });
  assert.deepEqual(res.body, {
    ok: true,
    bunny: { deleted: true, missing: false, skipped: false },
    playlists_updated: 2,
    progress_deleted: 37,
    discussions_deleted: 4,
  });
  assert.equal(saved.action, 'video.deleted');
  assert.equal(saved.target_label, 'Old lecture');
  assert.equal(saved.before.bunny_video_id, 'g1');
  assert.deepEqual(saved.before.playlists.map((p) => p.name), ['ENT Basics', 'Crash Course']);
  assert.equal(saved.before.progress_rows, 37);
  assert.equal(saved.before.discussions_deleted, 4, 'the audit row names the discussion posts destroyed with the lecture');
});

test('permanentlyDeleteVideo: a Bunny 404 (already removed in the dashboard) still cleans up locally', async () => {
  const video = { _id: oid(), title: 'Gone upstream', is_active: false, provider: 'bunny', bunny_video_id: 'g1' };
  stub(Video, 'findById', () => q(video));
  const calls = stubCleanup();
  stub(bunnyProvider, 'deleteVideo', async () => ({ deleted: false, missing: true }));
  const res = mockRes();
  await videosController().permanentlyDeleteVideo({ user: makeUser(['CanDeleteVideos']), userId: oid(), params: { id: String(video._id) } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.bunny, { deleted: false, missing: true, skipped: false });
  assert.deepEqual(calls, { pull: 1, progressDeleted: 1, videoDeleted: 1, discussionsDeleted: 1 });
});

test('permanentlyDeleteVideo: a YouTube lecture skips Bunny entirely', async () => {
  const video = { _id: oid(), title: 'YT', is_active: false, provider: 'youtube', video_url: 'https://youtu.be/x' };
  stub(Video, 'findById', () => q(video));
  const calls = stubCleanup();
  let bunnyCalled = false;
  stub(bunnyProvider, 'deleteVideo', async () => { bunnyCalled = true; });
  const res = mockRes();
  await videosController().permanentlyDeleteVideo({ user: makeUser(['CanDeleteVideos']), userId: oid(), params: { id: String(video._id) } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(bunnyCalled, false);
  assert.deepEqual(res.body.bunny, { deleted: false, missing: false, skipped: true });
  assert.deepEqual(calls, { pull: 1, progressDeleted: 1, videoDeleted: 1, discussionsDeleted: 1 });
});

test('deletionImpact: reports playlists, progress count and whether the delete is allowed', async () => {
  const video = { _id: oid(), title: 'Preview', is_active: true, provider: 'bunny' };
  stub(Video, 'findById', () => q(video));
  stubCleanup({ playlists: [{ _id: oid(), name: 'ENT Basics', is_published: true }], progressCount: 5 });
  const res = mockRes();
  await videosController().deletionImpact({ user: makeUser(['CanDeleteVideos']), params: { id: String(video._id) } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.can_delete, false);
  assert.equal(res.body.progress_count, 5);
  assert.deepEqual(res.body.playlists.map((p) => p.name), ['ENT Basics']);
});
