// Controller-level tests (Task 17) for the CanDeactivate… check added to
// update handlers whose PATCH route already accepted any(CanEdit…, CanDeactivate…)
// only at the route level (bypassable — see task-17-brief.md). Each group below
// tests one handler with three cases: (1) an edit-only user changing is_active
// is denied and nothing is saved; (2) a deactivate-only user changing only
// is_active succeeds; (3) an edit-only user saving a full form with an
// UNCHANGED is_active succeeds. Style: test/rbacMediaControllers.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Test = require('../src/models/Test');
const Question = require('../src/models/Question');
const LiveClass = require('../src/models/LiveClass');
const Video = require('../src/models/Video');
const Coupon = require('../src/models/Coupon');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const AuditLog = require('../src/models/AuditLog');

const { createTestsController } = require('../src/controllers/testsController');
const { createClassesController } = require('../src/controllers/classesController');
const { createVideosController } = require('../src/controllers/videosController');
const { createCouponsController } = require('../src/controllers/couponsController');
const { createSubscriptionsController } = require('../src/controllers/subscriptionsController');
const { createUsersController } = require('../src/controllers/usersController');
const { createRolesController } = require('../src/controllers/rolesController');

const oid = () => new mongoose.Types.ObjectId();

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
// Task 11, addendum D: recordAudit is now wired into every PATCH handler
// below. Default it to a silent no-op so a test that doesn't care about
// auditing doesn't hit the real model and print "Failed to write audit log
// entry" — tests that DO care override this stub to capture what was written.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

// editOnly/deactivateOnly are the same shape — a caller holding exactly one
// code — kept as two names for readability at each call site (an "edit-only"
// or "deactivate-only" caller reads clearer than a generic "holder").
const holder = (code) => ({ _id: oid(), effective_permissions: [code] });
const editOnly = holder;
const deactivateOnly = holder;

function testsController() {
  return createTestsController({ createNotification: async () => {}, broadcastUserEvent: () => {} });
}

// --- testsController.updateTest ---

test('updateTest: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  stub(Test, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  let updateCalled = false;
  stub(Test, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false }); });
  const res = mockRes();
  await testsController().updateTest({
    params: { id: String(id) }, user: editOnly('CanEditTests'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateTests'] });
  assert.equal(updateCalled, false, 'the test must not be written when permission is denied');
});

test('updateTest: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  stub(Test, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  stub(Test, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, title: 'Old' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().updateTest({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateTests'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'test.deactivated');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

test('updateTest: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  stub(Test, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  stub(Test, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, title: 'New' }));
  const res = mockRes();
  await testsController().updateTest({
    params: { id: String(id) }, user: editOnly('CanEditTests'), body: { title: 'New', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, item A: the string "false" casts to the boolean `false` under
// Mongoose (every model declares `is_active: { type: Boolean }`), so an
// edit-only caller must not be able to deactivate by sending it.
test('updateTest: edit-only user sending is_active as the string "false" is denied, nothing saved', async () => {
  const id = oid();
  stub(Test, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  let updateCalled = false;
  stub(Test, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false }); });
  const res = mockRes();
  await testsController().updateTest({
    params: { id: String(id) }, user: editOnly('CanEditTests'), body: { is_active: 'false' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateTests'] });
  assert.equal(updateCalled, false, 'the test must not be written when permission is denied');
});

// Fix round 1, item D: the reverse of "edit-only touching is_active" — a
// deactivate-only caller touching another field alongside is_active.
test('updateTest: deactivate-only user changing is_active AND another field is denied, nothing saved', async () => {
  const id = oid();
  stub(Test, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  let updateCalled = false;
  stub(Test, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, title: 'New' }); });
  const res = mockRes();
  await testsController().updateTest({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateTests'), body: { is_active: false, title: 'New' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditTests'] });
  assert.equal(updateCalled, false, 'the test must not be written when permission is denied');
});

// --- testsController.updateQuestionBank ---

function questionDoc(fields) {
  return { toObject() { return { ...this, toObject: undefined }; }, save: async function save() { return this; }, ...fields };
}

test('updateQuestionBank: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: 'Q' });
  let saveCalled = false;
  existing.save = async function save() { saveCalled = true; return this; };
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestionBank({
    params: { id: String(id) }, user: editOnly('CanEditQuestionBank'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateQuestionBank'] });
  assert.equal(saveCalled, false, 'the question bank item must not be saved when permission is denied');
});

test('updateQuestionBank: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: 'Q' });
  stub(Question, 'findById', () => q(existing));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().updateQuestionBank({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateQuestionBank'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'question_bank.deactivated');
});

test('updateQuestionBank: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: 'Q' });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestionBank({
    params: { id: String(id) }, user: editOnly('CanEditQuestionBank'), body: { question_text: 'New Q', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Final review fix round 1, Important: Task 17 widened PATCH/DELETE
// question-bank routes to any(CanEdit.../CanDeactivate...), so a
// Deactivate-only actor (no CanViewQuestions) must not see the answer key
// (correct_answers/explanation/explanation_image_url) in the response —
// spec 5.2 reserves it for CanViewQuestions specifically.
test('updateQuestionBank (final review fix round 1, Important): a CanDeactivateQuestionBank-only actor does not receive the answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestionBank({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateQuestionBank'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.question.correct_answers, undefined);
  assert.equal(res.body.question.explanation, undefined);
  assert.equal(res.body.question.explanation_image_url, undefined);
});

test('updateQuestionBank (final review fix round 1, Important): an actor also holding CanViewQuestions receives the full answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestionBank({
    params: { id: String(id) },
    user: { _id: oid(), effective_permissions: ['CanDeactivateQuestionBank', 'CanViewQuestions'] },
    body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.question.correct_answers, ['1']);
  assert.equal(res.body.question.explanation, 'why');
  assert.equal(res.body.question.explanation_image_url, 'x.png');
});

// --- testsController.deleteQuestionBank ---

test('deleteQuestionBank (final review fix round 1, Important): a CanDeactivateQuestionBank-only actor does not receive the answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().deleteQuestionBank({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateQuestionBank'),
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.question.correct_answers, undefined);
  assert.equal(res.body.question.explanation, undefined);
  assert.equal(res.body.question.explanation_image_url, undefined);
});

test('deleteQuestionBank (final review fix round 1, Important): an actor also holding CanViewQuestions receives the full answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().deleteQuestionBank({
    params: { id: String(id) },
    user: { _id: oid(), effective_permissions: ['CanDeactivateQuestionBank', 'CanViewQuestions'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.question.correct_answers, ['1']);
  assert.equal(res.body.question.explanation, 'why');
  assert.equal(res.body.question.explanation_image_url, 'x.png');
});

// --- testsController.updateQuestion ---

test('updateQuestion: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: 'Q' });
  let saveCalled = false;
  existing.save = async function save() { saveCalled = true; return this; };
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestion({
    params: { id: String(id) }, user: editOnly('CanEditQuestions'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateQuestions'] });
  assert.equal(saveCalled, false, 'the question must not be saved when permission is denied');
});

test('updateQuestion: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: 'Q' });
  stub(Question, 'findById', () => q(existing));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().updateQuestion({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateQuestions'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'question.deactivated');
});

test('updateQuestion: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: 'Q' });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestion({
    params: { id: String(id) }, user: editOnly('CanEditQuestions'), body: { question_text: 'New Q', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Final review fix round 1, Important: same leak, plain (non-bank) questions.
test('updateQuestion (final review fix round 1, Important): a CanDeactivateQuestions-only actor does not receive the answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestion({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateQuestions'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.question.correct_answers, undefined);
  assert.equal(res.body.question.explanation, undefined);
  assert.equal(res.body.question.explanation_image_url, undefined);
});

test('updateQuestion (final review fix round 1, Important): an actor also holding CanViewQuestions receives the full answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().updateQuestion({
    params: { id: String(id) },
    user: { _id: oid(), effective_permissions: ['CanDeactivateQuestions', 'CanViewQuestions'] },
    body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.question.correct_answers, ['1']);
  assert.equal(res.body.question.explanation, 'why');
  assert.equal(res.body.question.explanation_image_url, 'x.png');
});

// --- testsController.deleteQuestion ---

test('deleteQuestion (final review fix round 1, Important): a CanDeactivateQuestions-only actor does not receive the answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().deleteQuestion({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateQuestions'),
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.question.correct_answers, undefined);
  assert.equal(res.body.question.explanation, undefined);
  assert.equal(res.body.question.explanation_image_url, undefined);
});

test('deleteQuestion (final review fix round 1, Important): an actor also holding CanViewQuestions receives the full answer key', async () => {
  const id = oid();
  const existing = questionDoc({
    _id: id, is_active: true, test_id: null, question_text: 'Q',
    correct_answers: ['1'], explanation: 'why', explanation_image_url: 'x.png',
  });
  stub(Question, 'findById', () => q(existing));
  const res = mockRes();
  await testsController().deleteQuestion({
    params: { id: String(id) },
    user: { _id: oid(), effective_permissions: ['CanDeactivateQuestions', 'CanViewQuestions'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.question.correct_answers, ['1']);
  assert.equal(res.body.question.explanation, 'why');
  assert.equal(res.body.question.explanation_image_url, 'x.png');
});

// --- classesController.updateClass ---

function classesController() {
  return createClassesController({ createNotification: async () => {} });
}

test('updateClass: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  stub(LiveClass, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  let updateCalled = false;
  stub(LiveClass, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false }); });
  const res = mockRes();
  await classesController().updateClass({
    params: { id: String(id) }, user: editOnly('CanEditClasses'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateClasses'] });
  assert.equal(updateCalled, false, 'the class must not be written when permission is denied');
});

test('updateClass: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  stub(LiveClass, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  stub(LiveClass, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, title: 'Old' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await classesController().updateClass({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateClasses'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'class.deactivated');
});

test('updateClass: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  stub(LiveClass, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  stub(LiveClass, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, title: 'New' }));
  const res = mockRes();
  await classesController().updateClass({
    params: { id: String(id) }, user: editOnly('CanEditClasses'), body: { title: 'New', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, item D: the reverse — a deactivate-only caller touching
// another field alongside is_active.
test('updateClass: deactivate-only user changing is_active AND another field is denied, nothing saved', async () => {
  const id = oid();
  stub(LiveClass, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  let updateCalled = false;
  stub(LiveClass, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, title: 'New' }); });
  const res = mockRes();
  await classesController().updateClass({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateClasses'), body: { is_active: false, title: 'New' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditClasses'] });
  assert.equal(updateCalled, false, 'the class must not be written when permission is denied');
});

// --- videosController.updateVideo ---

function videosController() {
  return createVideosController();
}

test('updateVideo: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  stub(Video, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  let updateCalled = false;
  stub(Video, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false }); });
  const res = mockRes();
  await videosController().updateVideo({
    params: { id: String(id) }, user: editOnly('CanEditVideos'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateVideos'] });
  assert.equal(updateCalled, false, 'the video must not be written when permission is denied');
});

test('updateVideo: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  stub(Video, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  stub(Video, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, title: 'Old' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await videosController().updateVideo({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateVideos'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'video.deactivated');
});

test('updateVideo: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  stub(Video, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  stub(Video, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, title: 'New' }));
  const res = mockRes();
  await videosController().updateVideo({
    params: { id: String(id) }, user: editOnly('CanEditVideos'), body: { title: 'New', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, item D: the reverse — a deactivate-only caller touching
// another field alongside is_active.
test('updateVideo: deactivate-only user changing is_active AND another field is denied, nothing saved', async () => {
  const id = oid();
  stub(Video, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  let updateCalled = false;
  stub(Video, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, title: 'New' }); });
  const res = mockRes();
  await videosController().updateVideo({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateVideos'), body: { is_active: false, title: 'New' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditVideos'] });
  assert.equal(updateCalled, false, 'the video must not be written when permission is denied');
});

// --- couponsController.updateCoupon ---

function couponsController() {
  return createCouponsController();
}

test('updateCoupon: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  stub(Coupon, 'findById', () => q({ _id: id, is_active: true, code: 'OLD' }));
  let updateCalled = false;
  stub(Coupon, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false }); });
  const res = mockRes();
  await couponsController().updateCoupon({
    params: { id: String(id) }, user: editOnly('CanEditCoupons'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateCoupons'] });
  assert.equal(updateCalled, false, 'the coupon must not be written when permission is denied');
});

test('updateCoupon: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  stub(Coupon, 'findById', () => q({ _id: id, is_active: true, code: 'OLD' }));
  stub(Coupon, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, code: 'OLD' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await couponsController().updateCoupon({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateCoupons'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'coupon.deactivated');
});

test('updateCoupon: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  stub(Coupon, 'findById', () => q({ _id: id, is_active: true, code: 'OLD' }));
  stub(Coupon, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, code: 'NEW' }));
  const res = mockRes();
  await couponsController().updateCoupon({
    params: { id: String(id) }, user: editOnly('CanEditCoupons'), body: { code: 'NEW', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, item D: the reverse — a deactivate-only caller touching
// another field alongside is_active.
test('updateCoupon: deactivate-only user changing is_active AND another field is denied, nothing saved', async () => {
  const id = oid();
  stub(Coupon, 'findById', () => q({ _id: id, is_active: true, code: 'OLD' }));
  let updateCalled = false;
  stub(Coupon, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, code: 'NEW' }); });
  const res = mockRes();
  await couponsController().updateCoupon({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateCoupons'), body: { is_active: false, code: 'NEW' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditCoupons'] });
  assert.equal(updateCalled, false, 'the coupon must not be written when permission is denied');
});

// --- subscriptionsController.updatePlan ---

function subsController() {
  return createSubscriptionsController({
    createNotification: async () => {},
    getPlansCache: () => null,
    setPlansCache: () => {},
    clearPlansCache: () => {},
  });
}

test('updatePlan: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, is_active: true, name: 'Old' }));
  let updateCalled = false;
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false }); });
  const res = mockRes();
  await subsController().updatePlan({
    params: { id: String(id) }, user: editOnly('CanEditSubscriptionPlans'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateSubscriptionPlans'] });
  assert.equal(updateCalled, false, 'the plan must not be written when permission is denied');
});

test('updatePlan: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, is_active: true, name: 'Old' }));
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, name: 'Old' }));
  const res = mockRes();
  await subsController().updatePlan({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateSubscriptionPlans'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('updatePlan: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, is_active: true, name: 'Old' }));
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, name: 'New' }));
  const res = mockRes();
  await subsController().updatePlan({
    params: { id: String(id) }, user: editOnly('CanEditSubscriptionPlans'), body: { name: 'New', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, item D: the reverse — a deactivate-only caller touching
// another field alongside is_active.
test('updatePlan: deactivate-only user changing is_active AND another field is denied, nothing saved', async () => {
  const id = oid();
  stub(SubscriptionPlan, 'findById', () => q({ _id: id, is_active: true, name: 'Old' }));
  let updateCalled = false;
  stub(SubscriptionPlan, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, name: 'New' }); });
  const res = mockRes();
  await subsController().updatePlan({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateSubscriptionPlans'), body: { is_active: false, name: 'New' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditSubscriptionPlans'] });
  assert.equal(updateCalled, false, 'the plan must not be written when permission is denied');
});

// --- usersController.updateUser ---

function usersController() {
  return createUsersController();
}

test('updateUser: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, full_name: 'Old' }));
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, toObject() { return this; } }); });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: editOnly('CanEditUsers'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateUsers'] });
  assert.equal(updateCalled, false, 'the user must not be written when permission is denied');
});

test('updateUser: deactivate-only user sending only is_active succeeds', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, full_name: 'Old' }));
  stub(User, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, full_name: 'Old', toObject() { return this; } }));
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateUsers'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('updateUser: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, full_name: 'Old' }));
  stub(User, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, full_name: 'New', toObject() { return this; } }));
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: editOnly('CanEditUsers'), body: { full_name: 'New', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, item D: the reverse of the "edit-only touching is_active" case
// — a deactivate-only caller touching another field alongside is_active.
test('updateUser: deactivate-only user changing is_active AND another field is denied, nothing saved', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, full_name: 'Old' }));
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, full_name: 'New', toObject() { return this; } }); });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateUsers'), body: { is_active: false, full_name: 'New' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditUsers'] });
  assert.equal(updateCalled, false, 'the user must not be written when permission is denied');
});

// Fix round 1, item B: reactivating a user mirrors deleteUser's own
// admin_status flip (active -> inactive on deactivate), server-side, so a
// Deactivate-only caller can reactivate an admin by sending is_active alone.
test('updateUser: deactivate-only user reactivating an inactive admin succeeds and the server sets admin_status back to active', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: false, admin_status: 'inactive', full_name: 'Old' }));
  let written = null;
  stub(User, 'findByIdAndUpdate', (updateId, updateOps) => {
    written = updateOps.$set;
    return q({ _id: id, is_active: true, admin_status: 'active', toObject() { return this; } });
  });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateUsers'), body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(written.admin_status, 'active', 'the server must flip admin_status back to active on reactivation');
});

test('updateUser: deactivate-only user reactivating an inactive admin by sending admin_status explicitly is still refused', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: false, admin_status: 'inactive', full_name: 'Old' }));
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: true, admin_status: 'active' }); });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateUsers'), body: { is_active: true, admin_status: 'active' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditUsers'] });
  assert.equal(updateCalled, false, 'the user must not be written when permission is denied');
});

test('updateUser: reactivating a user whose admin_status is already active writes no admin_status', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: false, admin_status: 'active', full_name: 'Old' }));
  let written = null;
  stub(User, 'findByIdAndUpdate', (updateId, updateOps) => {
    written = updateOps.$set;
    return q({ _id: id, is_active: true, admin_status: 'active', toObject() { return this; } });
  });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateUsers'), body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'admin_status'), false, 'admin_status must not be written when it was not inactive');
});

// --- rolesController.updateRole ---

function rolesController() {
  return createRolesController();
}

test('updateRole: edit-only user changing is_active is denied, nothing saved', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, is_active: true, name: 'old' }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false }); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: editOnly('CanEditRoles'), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanDeactivateRoles'] });
  assert.equal(updateCalled, false, 'the role must not be written when permission is denied');
});

test('updateRole: deactivate-only user sending only is_active succeeds (Roles page Reactivate button)', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, is_active: false, name: 'old' }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, name: 'old' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateRoles'), body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // Addendum A: roles have no "reactivated" action — this is role.updated.
  assert.equal(saved.action, 'role.updated');
  assert.deepEqual(saved.after, { is_active: true });
});

test('updateRole: edit-only user saving a full form with unchanged is_active succeeds', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, is_active: true, name: 'old' }));
  // Task 10 (spec 6.5): a name change now checks for a collision and, once
  // saved, cascades the rename to every user holding the old name.
  stub(Role, 'findOne', () => q(null));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, name: 'new' }));
  stub(User, 'updateMany', async () => ({ acknowledged: true }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: editOnly('CanEditRoles'), body: { name: 'new', is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, item D: the reverse — a deactivate-only caller touching
// another field alongside is_active.
test('updateRole: deactivate-only user changing is_active AND another field is denied, nothing saved', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, is_active: true, name: 'old' }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, is_active: false, name: 'new' }); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: deactivateOnly('CanDeactivateRoles'), body: { is_active: false, name: 'new' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditRoles'] });
  assert.equal(updateCalled, false, 'the role must not be written when permission is denied');
});
