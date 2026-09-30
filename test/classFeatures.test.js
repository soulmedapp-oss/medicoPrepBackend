// Final fix wave, Rec 3 (ruled): the live-class AI endpoints are the same two
// features the watch page gates on a lecture — ai_summary and ai_tutor — but
// only carried the class's own plan lock, so a free student could read an AI
// summary of a FREE class while the identical tab on a lecture was locked.
// Same shape as test/videoFeatures.test.js: the feature gate runs after the
// existing plan/entitlement checks and before the AI call.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const LiveClass = require('../src/models/LiveClass');
const Subject = require('../src/models/Subject');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');

const settingsService = require('../src/services/settingsService');
const tutorService = require('../src/services/tutorService');
settingsService.getOpenAiKey = async () => ({ value: 'fake-key', source: 'test' });
// The controller destructures these at require time, so the counters have to
// live in the functions installed BEFORE the require below.
let summaryCalls = 0;
let chatCalls = 0;
tutorService.requestClassSummary = async () => { summaryCalls += 1; return 'class summary'; };
tutorService.requestClassChat = async () => { chatCalls += 1; return 'class chat answer'; };

const { createClassesController } = require('../src/controllers/classesController');
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
test.beforeEach(() => {
  summaryCalls = 0;
  chatCalls = 0;
  stub(Subject, 'exists', async () => false);
});
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
  invalidateEntitlementPlans();
});

// free: only 'transcript'; premium: all three — the seeded defaults (spec §2).
const PLANS_F = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true, features: ['transcript'] },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true, features: ['ai_tutor', 'ai_summary', 'transcript'] },
];

function controller() {
  return createClassesController({ createNotification: async () => {} });
}

// A class ANY student may open (published, active, free), so every refusal
// here comes from the feature gate and never from the class's own plan lock.
function openClass() {
  return {
    _id: oid(), title: 'Anatomy revision', is_published: true, is_active: true, is_free: true, allowed_plans: [],
    transcript_text: 'hello world',
  };
}

function student(plan) {
  return {
    _id: oid(), email: 's@x.com', role: 'student', subscription_plan: plan,
    effective_permissions: ['CanAccessLiveClasses'],
  };
}
const STAFF = {
  _id: oid(), email: 'staff@x.com', role: 'admin', subscription_plan: 'free',
  effective_permissions: ['CanViewClasses'],
};
const LOCK = { required_plan: 'premium', required_label: 'Premium', required_tier: 2 };

// --- getClassSummary ---

test('getClassSummary: a free-plan student (no ai_summary feature) is refused 403 with the uniform body, and the AI service is never invoked', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const liveClass = openClass();
  stub(LiveClass, 'findById', () => q(liveClass));

  const res = mockRes();
  await controller().getClassSummary({ user: student('free'), params: { id: String(liveClass._id) } }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, upgradeRefusal(LOCK));
  assert.equal(summaryCalls, 0, 'requestClassSummary must never run for a locked feature');
});

test('getClassSummary: a premium-plan student (has ai_summary) gets 200', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const liveClass = openClass();
  stub(LiveClass, 'findById', () => q(liveClass));

  const res = mockRes();
  await controller().getClassSummary({ user: student('premium'), params: { id: String(liveClass._id) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.summary, 'class summary');
  assert.equal(summaryCalls, 1);
});

test('getClassSummary: staff (CanViewClasses) gets 200 regardless of plan', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const liveClass = openClass();
  stub(LiveClass, 'findById', () => q(liveClass));

  const res = mockRes();
  await controller().getClassSummary({ user: STAFF, params: { id: String(liveClass._id) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.summary, 'class summary');
});

// --- chatAboutClass ---

test('chatAboutClass: a free-plan student (no ai_tutor feature) is refused 403 with the uniform body, and the AI service is never invoked', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const liveClass = openClass();
  stub(LiveClass, 'findById', () => q(liveClass));

  const res = mockRes();
  await controller().chatAboutClass({ user: student('free'), params: { id: String(liveClass._id) }, body: { message: 'hi' } }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, upgradeRefusal(LOCK));
  assert.equal(chatCalls, 0, 'requestClassChat must never run for a locked feature');
});

test('chatAboutClass: a premium-plan student (has ai_tutor) gets 200', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const liveClass = openClass();
  stub(LiveClass, 'findById', () => q(liveClass));

  const res = mockRes();
  await controller().chatAboutClass({ user: student('premium'), params: { id: String(liveClass._id) }, body: { message: 'hi' } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.answer, 'class chat answer');
  assert.equal(chatCalls, 1);
});

test('chatAboutClass: staff (CanViewClasses) gets 200 regardless of plan', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  const liveClass = openClass();
  stub(LiveClass, 'findById', () => q(liveClass));

  const res = mockRes();
  await controller().chatAboutClass({ user: STAFF, params: { id: String(liveClass._id) }, body: { message: 'hi' } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.answer, 'class chat answer');
});

// The class's OWN plan lock still wins where it applies — the feature gate is
// added on top of it, not in place of it.
test('getClassSummary: a plan-locked class still refuses with the class lock, even for a student whose plan has ai_summary', async () => {
  const PLANS_LOCKED = [
    { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true, features: ['ai_summary'] },
    { plan_name: 'elite', display_name: 'Elite', tier: 3, is_active: true, features: ['ai_summary'] },
  ];
  stub(SubscriptionPlan, 'find', () => q(PLANS_LOCKED));
  const liveClass = { ...openClass(), is_free: false, allowed_plans: ['elite'] };
  stub(LiveClass, 'findById', () => q(liveClass));

  const res = mockRes();
  await controller().getClassSummary({ user: student('free'), params: { id: String(liveClass._id) } }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, upgradeRefusal({ required_plan: 'elite', required_label: 'Elite', required_tier: 3 }));
  assert.equal(summaryCalls, 0);
});
