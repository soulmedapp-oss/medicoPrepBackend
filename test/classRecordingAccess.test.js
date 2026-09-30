// How a Zoom recording reaches a student: the class row that advertises it
// (utils/classProjection.studentClassRow + classesController's readiness
// query) and the standalone lecture read that serves it
// (videosController.getLectureForStudent). Stubbed-model handler tests in the
// style of test/playlistsLocked.test.js / test/rbacMediaControllers.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Video = require('../src/models/Video');
const Playlist = require('../src/models/Playlist');
const LiveClass = require('../src/models/LiveClass');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');

// videosController destructures the tutor/settings services at require time.
const settingsService = require('../src/services/settingsService');
const tutorService = require('../src/services/tutorService');
settingsService.getOpenAiKey = async () => ({ value: 'fake-key', source: 'test' });
tutorService.requestVideoSummary = async () => 'video summary';
tutorService.requestVideoChat = async () => 'video chat answer';

const { createVideosController } = require('../src/controllers/videosController');
const { readyRecordingLectureIds } = require('../src/controllers/classesController');
const { studentClassRow } = require('../src/utils/classProjection');
const { STUDENT_LECTURE_FIELD_LIST, STUDENT_LECTURE_FIELDS } = require('../src/utils/studentProjection');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');

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

const STUDENT = {
  _id: oid(), email: 's@x.com', role: 'student', subscription_plan: 'free',
  effective_permissions: ['CanAccessVideos'],
};
const reqFor = (user, extra = {}) => ({ user, userId: String(user._id), ...extra });

// ---------------------------------------------------------------------------
// studentClassRow: does the row advertise a watchable lecture?
// ---------------------------------------------------------------------------

const classWithRecording = (overrides = {}) => ({
  _id: oid(), title: 'Renal physiology', status: 'completed', is_published: true, is_active: true,
  recording_video_id: oid(), zoom_recording_files: [{ file_type: 'MP4' }], youtube_url: 'https://y/1',
  ...overrides,
});

test('studentClassRow: a ready recording is advertised as a lecture id and as has_recording', () => {
  const liveClass = classWithRecording();
  const row = studentClassRow(liveClass, null, { recordingLectureReady: true });
  assert.equal(row.recording_lecture_id, String(liveClass.recording_video_id));
  assert.equal(row.has_recording, true);
  // The raw id column is never echoed — recording_lecture_id is the only
  // spelling a student ever sees, and only when it is playable.
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'recording_video_id'), false);
  assert.equal(row.lock, null);
});

test('studentClassRow: a recording still encoding is not advertised as a lecture', () => {
  const row = studentClassRow(classWithRecording(), null, { recordingLectureReady: false });
  assert.equal(row.recording_lecture_id, null, 'the key is always present, so the row shape is stable');
  // The Zoom play URL is still the fallback while Bunny encodes.
  assert.equal(row.has_recording, true);
});

test('studentClassRow: a class with no recording at all reports neither', () => {
  const row = studentClassRow({ _id: oid(), title: 'Upcoming', is_published: true }, null, {});
  assert.equal(row.recording_lecture_id, null);
  assert.equal(row.has_recording, false);
});

// The lecture id is a usable handle on gated content: the watch page takes it
// straight off this row, so a locked row that still carried it pointed the
// client at a lecture /videos/:id would only have refused.
test('studentClassRow: a locked class advertises no lecture id, no recording and no youtube url', () => {
  const lock = { required_plan: 'elite', required_label: 'Elite', required_tier: 2 };
  const row = studentClassRow(classWithRecording(), lock, { recordingLectureReady: true });
  assert.equal(row.recording_lecture_id, null);
  assert.equal(row.has_recording, false);
  assert.equal(row.has_join_link, false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'youtube_url'), false);
  assert.deepEqual(row.lock, lock);
});

// ---------------------------------------------------------------------------
// readyRecordingLectureIds: one query for the whole page
// ---------------------------------------------------------------------------

test('readyRecordingLectureIds: only ready, active lectures count — one query, and none at all when no class has a recording', async () => {
  const readyId = oid();
  const processingId = oid();
  const inactiveId = oid();
  const calls = [];
  stub(Video, 'find', (filter) => {
    calls.push(filter);
    // Stands in for Mongo applying the filter: only the ready+active row matches.
    return q([{ _id: readyId }]);
  });

  const result = await readyRecordingLectureIds([
    { recording_video_id: readyId },
    { recording_video_id: processingId },
    { recording_video_id: inactiveId },
    { recording_video_id: null },
  ]);
  assert.deepEqual([...result], [String(readyId)]);
  assert.equal(result.has(String(processingId)), false, 'a lecture still encoding is not ready');
  assert.equal(result.has(String(inactiveId)), false, 'a deactivated lecture is not ready');

  assert.equal(calls.length, 1, 'one query for the whole page, never one per class');
  assert.equal(calls[0].processing_status, 'ready');
  assert.deepEqual(calls[0].is_active, { $ne: false });
  assert.equal(calls[0]._id.$in.length, 3, 'classes with no recording are not queried for');

  const none = await readyRecordingLectureIds([{ recording_video_id: null }, {}]);
  assert.equal(none.size, 0);
  assert.equal(calls.length, 1, 'no ids means no query at all');
});

// ---------------------------------------------------------------------------
// getLectureForStudent: the standalone watch-page read
// ---------------------------------------------------------------------------

const lectureDoc = (overrides = {}) => ({
  _id: oid(),
  title: 'Renal physiology (2026-09-30) — recording',
  description: '',
  teacher_name: 'Dr Rao',
  subject: 'Physiology',
  subject_id: oid(),
  provider: 'bunny',
  processing_status: 'ready',
  duration_seconds: 3600,
  is_active: true,
  // Everything below must never reach a student.
  transcript_text: 'the whole transcript',
  transcript_url: 'https://cdn/x.vtt',
  bunny_video_id: 'bunny-guid',
  bunny_library_id: 'lib-1',
  allowed_plans: ['elite'],
  is_published: false,
  is_free: false,
  order: 3,
  created_by: oid(),
  updated_by: oid(),
  updated_by_at: new Date(),
  ...overrides,
});

const openClass = (overrides = {}) => ({
  _id: oid(), title: 'Renal physiology', scheduled_date: new Date('2026-09-30T04:30:00Z'),
  is_published: true, is_active: true, is_free: true, ...overrides,
});

function setupLectureRead(lecture, liveClass) {
  stub(Video, 'findById', () => q(lecture));
  stub(Playlist, 'find', () => q([]));
  stub(LiveClass, 'findById', () => q(liveClass));
}

test('getLectureForStudent: the response carries exactly the student lecture allowlist and nothing else', async () => {
  const lecture = lectureDoc({ source_live_class_id: oid() });
  setupLectureRead(lecture, openClass());
  const res = mockRes();
  await createVideosController().getLectureForStudent(reqFor(STUDENT, { params: { id: String(lecture._id) } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const keys = Object.keys(res.body.lecture).sort();
  assert.deepEqual(keys, ['_id', ...STUDENT_LECTURE_FIELD_LIST].sort());
  // The allowlist string and the array are the same list, so a field added to
  // one cannot be missing from the other.
  assert.deepEqual(STUDENT_LECTURE_FIELD_LIST, STUDENT_LECTURE_FIELDS.split(' '));
  assert.equal(keys.includes(''), false, 'no empty field name from a stray space in the allowlist');
  ['transcript_text', 'transcript_url', 'bunny_video_id', 'bunny_library_id', 'allowed_plans',
    'is_free', 'is_published', 'order', 'created_by', 'updated_by', 'updated_by_at'].forEach((field) => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.body.lecture, field),
      false,
      `${field} must never reach a student`
    );
  });
  assert.equal(res.body.lecture.title, lecture.title);
  assert.equal(res.body.lecture.provider, 'bunny');
});

test('getLectureForStudent: source_class names the class a student could have reached anyway', async () => {
  const lecture = lectureDoc({ source_live_class_id: oid() });
  const liveClass = openClass();
  setupLectureRead(lecture, liveClass);
  const res = mockRes();
  await createVideosController().getLectureForStudent(reqFor(STUDENT, { params: { id: String(lecture._id) } }), res);
  assert.deepEqual(res.body.source_class, {
    id: String(liveClass._id),
    title: liveClass.title,
    scheduled_date: liveClass.scheduled_date,
  });
});

// An unpublished or deactivated class is invisible everywhere else, so its
// title must not leak off the one lecture that points at it. The lecture
// itself still plays — an admin may have put it in a playlist — it just has
// no back link.
test('getLectureForStudent: an unpublished or deactivated source class is not named', async () => {
  const controller = createVideosController();
  for (const classState of [{ is_published: false }, { is_active: false }]) {
    const lecture = lectureDoc({ source_live_class_id: oid() });
    const openPlaylist = { is_published: true, is_active: true, is_free: true, items: [{ lecture_id: lecture._id }] };
    stub(Video, 'findById', () => q(lecture));
    stub(Playlist, 'find', () => q([openPlaylist]));
    stub(LiveClass, 'findById', () => q(openClass(classState)));
    const res = mockRes();
    await controller.getLectureForStudent(reqFor(STUDENT, { params: { id: String(lecture._id) } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.source_class, null, JSON.stringify(classState));
    assert.equal(res.body.lecture.title, lecture.title, 'the lecture is still served, only the back link is dropped');
  }
});

test('getLectureForStudent: a lecture with no source class simply has none', async () => {
  const lecture = lectureDoc();
  const openPlaylist = { is_published: true, is_active: true, is_free: true, items: [{ lecture_id: lecture._id }] };
  stub(Video, 'findById', () => q(lecture));
  stub(Playlist, 'find', () => q([openPlaylist]));
  stub(LiveClass, 'findById', () => { throw new Error('must not be queried'); });
  const res = mockRes();
  await createVideosController().getLectureForStudent(reqFor(STUDENT, { params: { id: String(lecture._id) } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.source_class, null);
});

test('getLectureForStudent: a locked recording is refused with the uniform UPGRADE_REQUIRED body, not a lecture', async () => {
  const lecture = lectureDoc({ source_live_class_id: oid() });
  setupLectureRead(lecture, openClass({ is_free: false, allowed_plans: ['elite'] }));
  const res = mockRes();
  await createVideosController().getLectureForStudent(reqFor(STUDENT, { params: { id: String(lecture._id) } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'UPGRADE_REQUIRED');
  assert.deepEqual(res.body.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
  assert.equal(res.body.lecture, undefined);
});
