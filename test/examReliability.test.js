const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Test = require('../src/models/Test');
const Question = require('../src/models/Question');
const TestAttempt = require('../src/models/TestAttempt');
const ExamPaper = require('../src/models/ExamPaper');
const User = require('../src/models/User');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');
const { createTestsController } = require('../src/controllers/testsController');
const service = require('../src/services/examAttemptService');

const oid = () => new mongoose.Types.ObjectId();
const q = value => {
  const chain = { sort: () => chain, select: () => chain, limit: () => chain, lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return chain;
};
const originals = [];
function stub(object, key, fn) { originals.push([object, key, object[key]]); object[key] = fn; }
test.afterEach(() => { while (originals.length) { const [object, key, fn] = originals.pop(); object[key] = fn; } invalidateEntitlementPlans(); });
const res = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
function fixture() {
  const user = { _id: oid(), email: 'student@example.test', effective_permissions: ['CanAccessTests'], subscription_plan: 'free' };
  const paper = [{ _id: oid(), question_text: 'Frozen question', options: [{ id: 'a', text: 'A' }], correct_answers: ['a'], explanation: 'Private key', marks: 4 }];
  const exam = { _id: oid(), duration_minutes: 60, is_active: true, is_published: true, required_plan: 'free', is_free: true };
  const attempt = { _id: oid(), user_id: user._id, user_email: user.email, test_id: exam._id, status: 'in_progress',
    exam_protocol: 1, answer_version: 3, paper_id: 'paper', started_at: new Date(Date.now() - 60_000), deadline_at: new Date(Date.now() + 60_000),
    answers: [{ question_id: paper[0]._id, selected_options: ['a'] }] };
  stub(SubscriptionPlan, 'find', () => q([{ plan_name: 'free', tier: 0, is_active: true }]));
  stub(Test, 'findById', () => q(exam));
  stub(ExamPaper, 'findById', () => q({ _id: 'paper', questions: paper }));
  stub(TestAttempt, 'findById', () => q(attempt));
  // Completion effects use the protocol outbox rather than real database calls.
  const controller = createTestsController({});
  const request = body => ({ params: { id: String(attempt._id) }, userId: String(user._id), user, body });
  return { user, paper, exam, attempt, controller, request };
}

test('deadline is limited by duration and closing window', () => {
  const start = new Date('2026-10-10T10:00:00Z');
  assert.equal(service.deadlineFor({ duration_minutes: 60 }, start).toISOString(), '2026-10-10T11:00:00.000Z');
  assert.equal(service.deadlineFor({ duration_minutes: 60, available_until: '2026-10-10T10:30:00Z' }, start).toISOString(), '2026-10-10T10:30:00.000Z');
  assert.throws(() => service.deadlineFor({ duration_minutes: -1 }, start));
});

test('resume returns the same attempt and frozen student paper without answer keys', async () => {
  const f = fixture();
  stub(TestAttempt, 'findOne', () => q(f.attempt));
  stub(Question, 'find', () => { throw new Error('Resume must not query edited questions'); });
  const response = res();
  await f.controller.createAttempt({ params: { id: String(f.exam._id) }, user: f.user }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(String(response.body.attempt._id), String(f.attempt._id));
  assert.equal(response.body.questions[0].correct_answers, undefined);
  assert.equal(response.body.questions[0].explanation, undefined);
  assert.equal(response.body.questions[0].question_text, 'Frozen question');
  assert.ok(response.body.attempt.server_time);
});

test('start uses an atomic upsert and shares a paper snapshot', async () => {
  const f = fixture();
  let captured;
  stub(TestAttempt, 'findOne', () => q(null));
  stub(Question, 'find', () => q(f.paper));
  stub(ExamPaper, 'updateOne', async (filter, update, options) => {
    assert.equal(filter._id.length, 64);
    assert.equal(options.upsert, true);
    assert.equal(update.$setOnInsert.questions, f.paper);
  });
  stub(TestAttempt, 'findOneAndUpdate', (filter, update, options) => {
    captured = { filter, update, options };
    return q({ _id: oid(), ...update.$setOnInsert });
  });
  const response = res();
  await f.controller.createAttempt({ params: { id: String(f.exam._id) }, user: f.user }, response);
  assert.equal(response.statusCode, 201);
  assert.equal(captured.options.upsert, true);
  assert.equal(captured.filter.user_id, f.user._id);
  assert.equal(captured.update.$setOnInsert.answer_version, 0);
  assert.ok(captured.update.$setOnInsert.deadline_at > new Date());
});

test('stale answer versions cannot write', async () => {
  const f = fixture();
  stub(TestAttempt, 'findOneAndUpdate', () => { throw new Error('Stale save must not write'); });
  const response = res();
  await f.controller.updateAttempt(f.request({ answer_version: 2, answers: {} }), response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'ANSWER_VERSION_CONFLICT');
});

test('answer deltas preserve acknowledged answers and allow explicit clearing', async () => {
  const f = fixture();
  const other = oid();
  f.attempt.answers = [{ question_id: other, selected_options: ['b'] }, { question_id: f.paper[0]._id, selected_options: ['a'] }];
  let written;
  stub(TestAttempt, 'findOneAndUpdate', (filter, update) => {
    written = update.$set.answers;
    return q({ ...f.attempt, answers: written, answer_version: 4 });
  });
  const response = res();
  await f.controller.updateAttempt(f.request({ answer_version: 3, answers_delta: { [String(f.paper[0]._id)]: [] } }), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(written.find((a) => String(a.question_id) === String(other)).selected_options, ['b']);
  assert.deepEqual(written.find((a) => String(a.question_id) === String(f.paper[0]._id)).selected_options, []);
});

test('damaged exam snapshots back off so later overdue attempts can progress', async () => {
  const f = fixture();
  f.attempt.deadline_at = new Date(Date.now() - 1000);
  stub(TestAttempt, 'find', () => q([f.attempt]));
  stub(ExamPaper, 'findById', () => q(null));
  let update;
  stub(TestAttempt, 'updateOne', async (filter, value) => { update = value; });
  const result = await service.finalizeExpiredAttempts();
  assert.equal(result.failures.length, 1);
  assert.equal(result.completed, 0);
  assert.ok(update.$set.finalize_next_run_at > new Date());
});

test('accepted saves condition on version and deadline, then increment version', async () => {
  const f = fixture();
  let updateCall;
  stub(TestAttempt, 'findOneAndUpdate', (filter, update) => {
    updateCall = { filter, update }; return q({ ...f.attempt, ...update.$set, answer_version: 4 });
  });
  const response = res();
  await f.controller.updateAttempt(f.request({ answer_version: 3, answers: { [f.paper[0]._id]: [] } }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(updateCall.filter.answer_version, 3);
  assert.ok(updateCall.filter.deadline_at.$gt instanceof Date);
  assert.equal(updateCall.update.$inc.answer_version, 1);
  assert.deepEqual(updateCall.update.$set.answers[0].selected_options, []);
});

test('an expired save cannot replace acknowledged answers', async () => {
  const f = fixture(); f.attempt.deadline_at = new Date(Date.now() - 1000);
  stub(TestAttempt, 'findOneAndUpdate', () => { throw new Error('Expired save must not write'); });
  const response = res();
  await f.controller.updateAttempt(f.request({ answer_version: 3, answers: {} }), response);
  assert.equal(response.body.code, 'ATTEMPT_EXPIRED');
});

test('expired completion grades saved answers and ignores the late answer sheet', async () => {
  const f = fixture(); f.attempt.deadline_at = new Date(Date.now() - 1000);
  let updateCall;
  stub(TestAttempt, 'findOneAndUpdate', (filter, update) => {
    updateCall = { filter, update }; return q({ ...f.attempt, ...update.$set });
  });
  const response = res();
  await f.controller.updateAttempt(f.request({ status: 'completed', answers: {} }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(updateCall.update.$set.score, 4);
  assert.equal(updateCall.update.$set.completed_at, f.attempt.deadline_at);
  assert.equal(updateCall.update.$set.completion_effects_pending, true);
});

test('owner-only read never exposes the paper key', async () => {
  const f = fixture();
  const response = res();
  await f.controller.getAttempt({ ...f.request({}), userId: String(oid()) }, response);
  assert.equal(response.statusCode, 403);
});

test('expired sweep completes saved work with a version guard', async () => {
  const f = fixture(); f.attempt.deadline_at = new Date(Date.now() - 1000);
  stub(TestAttempt, 'find', () => q([f.attempt]));
  stub(TestAttempt, 'findOneAndUpdate', (filter, update) => {
    assert.equal(filter.answer_version, 3);
    assert.equal(update.$set.score, 4);
    return q({ ...f.attempt, ...update.$set });
  });
  const result = await service.finalizeExpiredAttempts();
  assert.equal(result.completed, 1);
  assert.deepEqual(result.failures, []);
});

test('a lost compare-and-set cannot overwrite a concurrent save', async () => {
  const f = fixture();
  stub(TestAttempt, 'findOneAndUpdate', () => q(null));
  const response = res();
  await f.controller.updateAttempt(f.request({ answer_version: 3, answers: {} }), response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'ATTEMPT_CHANGED');
});

test('a closed exam remains readable only to its existing participants', async () => {
  const f = fixture(); f.exam.available_until = new Date(Date.now() - 1000);
  stub(TestAttempt, 'findOne', () => q({ _id: f.attempt._id }));
  const allowed = res();
  await f.controller.getTest({ params: { id: String(f.exam._id) }, user: f.user }, allowed);
  assert.equal(allowed.statusCode, 200);
  stub(TestAttempt, 'findOne', () => q(null));
  const refused = res();
  await f.controller.getTest({ params: { id: String(f.exam._id) }, user: f.user }, refused);
  assert.equal(refused.statusCode, 404);
});

test('expired sweeps leave concurrently changed attempts for a later retry', async () => {
  const f = fixture();
  f.attempt.deadline_at = new Date(Date.now() - 1000);
  stub(TestAttempt, 'find', () => q([f.attempt]));
  stub(TestAttempt, 'findOneAndUpdate', () => q(null));
  assert.equal((await service.finalizeExpiredAttempts()).completed, 0);
});

test('failed completion effects remain pending and replay without double increments', async () => {
  const f = fixture();
  stub(TestAttempt, 'find', () => q([f.attempt, { ...f.attempt, _id: oid() }]));
  let counts = 0;
  let acknowledged = 0;
  stub(TestAttempt, 'countDocuments', async () => { counts++; return 2; });
  stub(TestAttempt, 'aggregate', async () => [{ count: 2, average: 75 }]);
  stub(Test, 'updateOne', async (filter, update) => { assert.deepEqual(update, { $max: { attempt_count: 2 } }); });
  stub(User, 'updateOne', async () => { throw new Error('temporary database failure'); });
  stub(TestAttempt, 'updateMany', async () => { acknowledged++; });
  await assert.rejects(service.reconcileCompletionEffects(), /temporary database failure/);
  assert.equal(acknowledged, 0);
  stub(User, 'updateOne', async (filter, update) => { assert.equal(update.$set.average_score, 75); });
  assert.equal((await service.reconcileCompletionEffects()).processed, 2);
  assert.equal(acknowledged, 1);
  assert.equal(counts, 2, 'one shared test count per batch, including a safe retry');
});
