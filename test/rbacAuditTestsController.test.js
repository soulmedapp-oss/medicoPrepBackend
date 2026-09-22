// Task 11: audit coverage for testsController.js handlers that had no
// controller-level tests at all before this task — deleteTest, deleteQuestion,
// deleteQuestionBank, bulkDeleteQuestions, bulkActivateQuestions — plus the
// PATCH reactivate direction (is_active false -> true) for updateTest,
// updateQuestionBank and updateQuestion, which test/rbacUpdateDeactivate.test.js
// only exercises going the other way. Style: test/rbacUpdateDeactivate.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Test = require('../src/models/Test');
const Question = require('../src/models/Question');
const AuditLog = require('../src/models/AuditLog');

const { createTestsController } = require('../src/controllers/testsController');
const { ALL_CODES } = require('../src/rbac/permissions');

const oid = () => new mongoose.Types.ObjectId();

function q(value) {
  const chain = {
    sort: () => chain,
    select: () => chain,
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
});
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

const admin = () => ({ _id: oid(), effective_permissions: [...ALL_CODES], role_names: ['admin'] });

function testsController() {
  return createTestsController({ createNotification: async () => {}, broadcastUserEvent: () => {} });
}

function testDoc(fields) {
  return { toObject() { const { save, toObject: _t, ...rest } = this; return rest; }, save: async function save() { return this; }, ...fields };
}

function questionDoc(fields) {
  return { toObject() { return { ...this, toObject: undefined }; }, save: async function save() { return this; }, ...fields };
}

// --- deleteTest ---

test('deleteTest: a successful deactivation writes test.deactivated with target_* only', async () => {
  const id = oid();
  const existing = testDoc({ _id: id, is_active: true, is_published: true, title: 'Anatomy' });
  stub(Test, 'findById', () => q(existing));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().deleteTest({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'test.deactivated');
  assert.equal(saved.target_type, 'test');
  assert.equal(saved.target_label, 'Anatomy');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

test('deleteTest: a not-found test writes nothing to the audit log', async () => {
  const id = oid();
  stub(Test, 'findById', () => q(null));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await testsController().deleteTest({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false, 'nothing must be written when the test does not exist');
});

// --- updateTest reactivation ---

test('updateTest: reactivating (is_active false -> true) writes test.reactivated', async () => {
  const id = oid();
  stub(Test, 'findById', () => q({ _id: id, is_active: false, title: 'Anatomy' }));
  stub(Test, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, title: 'Anatomy' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().updateTest({
    params: { id: String(id) }, user: admin(), body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'test.reactivated');
});

test('updateTest: a content-only edit (is_active unchanged) writes nothing (content edits are not audited)', async () => {
  const id = oid();
  stub(Test, 'findById', () => q({ _id: id, is_active: true, title: 'Old' }));
  stub(Test, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, title: 'New' }));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await testsController().updateTest({
    params: { id: String(id) }, user: admin(), body: { title: 'New' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(auditCalled, false, 'a PATCH that does not change is_active writes no entry (addendum A)');
});

// --- deleteQuestionBank ---

test('deleteQuestionBank: a successful deactivation writes question_bank.deactivated', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: 'Q1' });
  stub(Question, 'findById', () => q(existing));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().deleteQuestionBank({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'question_bank.deactivated');
  assert.equal(saved.target_type, 'question_bank');
});

test('deleteQuestionBank: not found writes nothing to the audit log', async () => {
  const id = oid();
  stub(Question, 'findById', () => q(null));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await testsController().deleteQuestionBank({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});

test('updateQuestionBank: reactivating writes question_bank.reactivated', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: false, test_id: null, question_text: 'Q1' });
  stub(Question, 'findById', () => q(existing));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().updateQuestionBank({
    params: { id: String(id) }, user: admin(), body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'question_bank.reactivated');
});

// Fix round 1, Minor 2: question_text is validated up to 4000 chars but
// target_label has no maxlength of its own — must be truncated before it
// reaches recordAudit.
test('deleteQuestionBank: a long question_text is truncated to ~120 chars in target_label', async () => {
  const id = oid();
  const longText = 'Q'.repeat(500);
  const existing = questionDoc({ _id: id, is_active: true, test_id: null, question_text: longText });
  stub(Question, 'findById', () => q(existing));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().deleteQuestionBank({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved.target_label.length < longText.length, 'the label must be truncated, not the full 500-char question_text');
  assert.ok(saved.target_label.length <= 140, `expected roughly 120 chars plus the truncation marker, got ${saved.target_label.length}`);
});

// --- deleteQuestion ---

test('deleteQuestion: a successful deactivation writes question.deactivated', async () => {
  const id = oid();
  const testId = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: testId, question_text: 'Q1' });
  stub(Question, 'findById', () => q(existing));
  stub(Test, 'findByIdAndUpdate', () => q({}));
  stub(Question, 'countDocuments', async () => 1);
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().deleteQuestion({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'question.deactivated');
});

// Fix round 1, Minor 1: the audit call must sit immediately after the write
// that actually deactivates, before any LATER step that can throw — so a
// throw in that later step (updateTestQuestionCount, here forced via
// Question.countDocuments) still leaves an audit entry for the deactivation
// that DID happen, instead of losing it.
test('deleteQuestion: the audit entry survives even when a LATER step (updateTestQuestionCount) throws', async () => {
  const id = oid();
  const testId = oid();
  const existing = questionDoc({ _id: id, is_active: true, test_id: testId, question_text: 'Q1' });
  stub(Question, 'findById', () => q(existing));
  stub(Question, 'countDocuments', async () => { throw new Error('boom'); });
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().deleteQuestion({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.ok(saved, 'the audit entry for the deactivation that DID happen must survive a later throw');
  assert.equal(saved.action, 'question.deactivated');
});

test('deleteQuestion: not found writes nothing to the audit log', async () => {
  const id = oid();
  stub(Question, 'findById', () => q(null));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await testsController().deleteQuestion({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});

// Fix round 1, Minor 5: the reactivate direction was covered for test /
// question_bank / plan but not for updateQuestion.
test('updateQuestion: reactivating writes question.reactivated', async () => {
  const id = oid();
  const existing = questionDoc({ _id: id, is_active: false, test_id: null, question_text: 'Q1' });
  stub(Question, 'findById', () => q(existing));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().updateQuestion({
    params: { id: String(id) }, user: admin(), body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'question.reactivated');
});

// --- bulkDeleteQuestions / bulkActivateQuestions ---

test('bulkDeleteQuestions: a successful bulk deactivation writes ONE question.deactivated entry with target_label "<n> questions" and after: { ids }', async () => {
  const ids = [oid(), oid(), oid()];
  stub(Question, 'find', () => ({ select: () => q(ids.map((id) => ({ _id: id, test_id: null }))) }));
  stub(Question, 'updateMany', async () => ({ acknowledged: true }));
  let saved;
  let callCount = 0;
  stub(AuditLog, 'create', async (doc) => { callCount += 1; saved = doc; });
  const res = mockRes();
  await testsController().bulkDeleteQuestions({ user: admin(), body: { question_ids: ids.map(String) } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(callCount, 1, 'exactly one audit entry for the whole bulk operation');
  assert.equal(saved.action, 'question.deactivated');
  assert.equal(saved.target_label, '3 questions');
  assert.deepEqual(saved.after, { ids: ids.map(String) });
});

// Fix round 1, Minor 1: same ordering fix, bulk path — the audit call must
// sit right after the deactivating `updateMany`, before the per-test
// `updateTestQuestionCount` loop that can throw.
test('bulkDeleteQuestions: the audit entry survives even when a LATER step (updateTestQuestionCount) throws', async () => {
  const testId = oid();
  const ids = [oid(), oid()];
  stub(Question, 'find', () => ({ select: () => q(ids.map((id) => ({ _id: id, test_id: testId }))) }));
  stub(Question, 'updateMany', async () => ({ acknowledged: true }));
  stub(Question, 'countDocuments', async () => { throw new Error('boom'); });
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().bulkDeleteQuestions({ user: admin(), body: { question_ids: ids.map(String) } }, res);
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.ok(saved, 'the audit entry for the bulk deactivation that DID happen must survive a later throw');
  assert.equal(saved.action, 'question.deactivated');
});

test('bulkDeleteQuestions: no matching questions (404) writes nothing to the audit log', async () => {
  stub(Question, 'find', () => ({ select: () => q([]) }));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await testsController().bulkDeleteQuestions({ user: admin(), body: { question_ids: [String(oid())] } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});

test('bulkActivateQuestions: a successful bulk reactivation writes ONE question.reactivated entry', async () => {
  const ids = [oid(), oid()];
  stub(Question, 'find', () => ({ select: () => q(ids.map((id) => ({ _id: id, test_id: null }))) }));
  stub(Question, 'updateMany', async () => ({ acknowledged: true }));
  let saved;
  let callCount = 0;
  stub(AuditLog, 'create', async (doc) => { callCount += 1; saved = doc; });
  const res = mockRes();
  await testsController().bulkActivateQuestions({ user: admin(), body: { question_ids: ids.map(String) } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(callCount, 1);
  assert.equal(saved.action, 'question.reactivated');
  assert.equal(saved.target_label, '2 questions');
  assert.deepEqual(saved.after, { ids: ids.map(String) });
});

test('bulkActivateQuestions: the audit entry survives even when a LATER step (updateTestQuestionCount) throws', async () => {
  const testId = oid();
  const ids = [oid(), oid()];
  stub(Question, 'find', () => ({ select: () => q(ids.map((id) => ({ _id: id, test_id: testId }))) }));
  stub(Question, 'updateMany', async () => ({ acknowledged: true }));
  stub(Question, 'countDocuments', async () => { throw new Error('boom'); });
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await testsController().bulkActivateQuestions({ user: admin(), body: { question_ids: ids.map(String) } }, res);
  assert.equal(res.statusCode, 500, JSON.stringify(res.body));
  assert.ok(saved, 'the audit entry for the bulk reactivation that DID happen must survive a later throw');
  assert.equal(saved.action, 'question.reactivated');
});

test('bulkActivateQuestions: no matching questions (404) writes nothing to the audit log', async () => {
  stub(Question, 'find', () => ({ select: () => q([]) }));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await testsController().bulkActivateQuestions({ user: admin(), body: { question_ids: [String(oid())] } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});
