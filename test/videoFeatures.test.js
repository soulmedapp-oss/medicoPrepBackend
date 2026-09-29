// Task 2 (spec §2/§4): plan-gate the AI summary / AI tutor endpoints, and the
// new transcript endpoint, on top of the existing playback gate. Written
// BEFORE the controller/route edits (TDD) — style follows
// test/rbacMediaControllers.test.js (chainable query stub, mockRes, stub()).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Video = require('../src/models/Video');
const Playlist = require('../src/models/Playlist');
const AuditLog = require('../src/models/AuditLog');

const settingsService = require('../src/services/settingsService');
const tutorService = require('../src/services/tutorService');
settingsService.getOpenAiKey = async () => ({ value: 'fake-key', source: 'test' });
tutorService.requestVideoSummary = async () => 'video summary';
tutorService.requestVideoChat = async () => 'video chat answer';

const { createVideosController } = require('../src/controllers/videosController');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { invalidateEntitlementPlans, upgradeRefusal } = require('../src/utils/entitlement');

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
  invalidateEntitlementPlans();
});
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

// free: only 'transcript'; premium: all three — mirrors the seeded defaults
// in the spec (§2).
const PLANS_F = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true, features: ['transcript'] },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true, features: ['ai_tutor', 'ai_summary', 'transcript'] },
];

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

function controller() {
  return createVideosController();
}

// A lecture playable by anyone (published, free, active playlist), so every
// refusal in these tests comes from the FEATURE gate, never the playback gate.
function playableLecture(videoId, extra) {
  return {
    _id: videoId, is_published: true, is_active: true, allowed_plans: [], transcript_text: 'hello world', ...extra,
  };
}
function playablePlaylist(videoId) {
  return { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: videoId }] };
}

// --- getVideoSummary ---

test('getVideoSummary: a free-plan student (no ai_summary feature) is refused 403 with the uniform body, and the AI service is never invoked', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([playablePlaylist(video._id)]));
  let summoned = false;
  stub(tutorService, 'requestVideoSummary', async () => { summoned = true; return 'video summary'; });

  const student = makeUser(['CanAccessVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().getVideoSummary({ user: student, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, upgradeRefusal({ required_plan: 'premium', required_label: 'Premium', required_tier: 2 }));
  assert.equal(summoned, false, 'requestVideoSummary must never run for a locked feature');
});

test('getVideoSummary: a premium-plan student (has ai_summary) gets 200', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([playablePlaylist(video._id)]));

  const student = makeUser(['CanAccessVideos'], { subscription_plan: 'premium' });
  const res = mockRes();
  await controller().getVideoSummary({ user: student, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.summary, 'video summary');
});

test('getVideoSummary: staff (CanViewVideos) gets 200 regardless of plan', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([]));

  const staff = makeUser(['CanViewVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().getVideoSummary({ user: staff, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.summary, 'video summary');
});

// --- chatAboutVideo ---

test('chatAboutVideo: a free-plan student (no ai_tutor feature) is refused 403 with the uniform body, and the AI service is never invoked', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([playablePlaylist(video._id)]));
  let summoned = false;
  stub(tutorService, 'requestVideoChat', async () => { summoned = true; return 'video chat answer'; });

  const student = makeUser(['CanAccessVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().chatAboutVideo({ user: student, params: { id: String(video._id) }, body: { message: 'hi' } }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, upgradeRefusal({ required_plan: 'premium', required_label: 'Premium', required_tier: 2 }));
  assert.equal(summoned, false, 'requestVideoChat must never run for a locked feature');
});

test('chatAboutVideo: a premium-plan student (has ai_tutor) gets 200', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([playablePlaylist(video._id)]));

  const student = makeUser(['CanAccessVideos'], { subscription_plan: 'premium' });
  const res = mockRes();
  await controller().chatAboutVideo({ user: student, params: { id: String(video._id) }, body: { message: 'hi' } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.answer, 'video chat answer');
});

test('chatAboutVideo: staff (CanViewVideos) gets 200 regardless of plan', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([]));

  const staff = makeUser(['CanViewVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().chatAboutVideo({ user: staff, params: { id: String(video._id) }, body: { message: 'hi' } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.answer, 'video chat answer');
});

// --- getVideoTranscript ---

test('getVideoTranscript: a free-plan student HAS the transcript feature (seeded default) and gets 200 with the text', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([playablePlaylist(video._id)]));

  const student = makeUser(['CanAccessVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().getVideoTranscript({ user: student, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.transcript, 'hello world');
});

test('getVideoTranscript: a plan without the transcript feature is refused 403 with the uniform body, and transcript_text is never selected', async () => {
  const NO_TRANSCRIPT_PLANS = [
    { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true, features: [] },
    { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true, features: ['ai_tutor', 'ai_summary', 'transcript'] },
  ];
  stub(SubscriptionPlan, 'find', () => q(NO_TRANSCRIPT_PLANS));
  const video = playableLecture(oid());
  const selectedFields = [];
  stub(Video, 'findById', () => {
    const chain = q(video);
    const originalSelect = chain.select;
    chain.select = (fields) => { selectedFields.push(fields); return originalSelect(fields); };
    return chain;
  });
  stub(Playlist, 'find', () => q([playablePlaylist(video._id)]));

  const student = makeUser(['CanAccessVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().getVideoTranscript({ user: student, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, upgradeRefusal({ required_plan: 'premium', required_label: 'Premium', required_tier: 2 }));
  assert.ok(
    !selectedFields.some((f) => String(f || '').includes('transcript_text')),
    'transcript_text must never be selected once the feature gate refuses'
  );
});

test('getVideoTranscript: staff (CanViewVideos) gets 200 regardless of plan', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid(), { transcript_text: 'staff can read this' });
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([]));

  const staff = makeUser(['CanViewVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().getVideoTranscript({ user: staff, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.transcript, 'staff can read this');
});

test('getVideoTranscript: an unplayable lecture (in no playlist) is refused by the playback gate\'s own 404 — the transcript is never read', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid());
  let findByIdCalls = 0;
  stub(Video, 'findById', () => { findByIdCalls += 1; return q(video); });
  stub(Playlist, 'find', () => q([]));

  const student = makeUser(['CanAccessVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().getVideoTranscript({ user: student, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Video not found');
  // Only loadVideoForPlayback's own lookup ran — the second, narrow
  // transcript_text read after the gates never happened.
  assert.equal(findByIdCalls, 1);
});

test('getVideoTranscript: an empty transcript_text returns an empty string, not undefined/null', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const video = playableLecture(oid(), { transcript_text: undefined });
  stub(Video, 'findById', () => q(video));
  stub(Playlist, 'find', () => q([playablePlaylist(video._id)]));

  const staff = makeUser(['CanViewVideos'], { subscription_plan: 'free' });
  const res = mockRes();
  await controller().getVideoTranscript({ user: staff, params: { id: String(video._id) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.transcript, '');
});
