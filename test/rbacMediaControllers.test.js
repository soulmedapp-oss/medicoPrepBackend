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

const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub (style: test/testsAttempts.test.js).
function q(value) {
  const chain = {
    sort: () => chain,
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
// Task 11: recordAudit is now wired into updateClass/deleteClass/updateVideo/
// deleteVideo. Default it to a silent no-op so pre-existing tests don't hit
// the real model.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
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

// --- videosController.getVideoSummary / chatAboutVideo (loadVideoForUser) ---
// The DB stub below returns a plain non-staff user for a fresh User.findById
// lookup (what the OLD loadVideoForUser(userId, videoId) used); the req.user
// passed to the controller carries CanViewVideos. Only the NEW code (which
// must use req.user, not a fresh DB fetch) can pass this.

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

  const studentReqUser = makeUser(['CanAccessVideos'], { role: 'student', is_teacher: false });
  const resStudent = mockRes();
  await videosController().getVideoSummary(
    { userId: String(studentReqUser._id), user: studentReqUser, params: { id: String(video._id) } },
    resStudent
  );
  assert.equal(resStudent.statusCode, 404);
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
