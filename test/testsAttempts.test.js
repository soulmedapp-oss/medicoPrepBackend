// Controller-level tests for attempt completion / review, with Mongoose model
// statics stubbed in-process (no database needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Test = require('../src/models/Test');
const Question = require('../src/models/Question');
const TestAttempt = require('../src/models/TestAttempt');
const User = require('../src/models/User');
const { createTestsController } = require('../src/controllers/testsController');

const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub.
function q(value) {
  const chain = {
    sort: () => chain,
    select: () => chain,
    skip: () => chain,
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

function setup({ attempt, questions, student }) {
  const calls = { findOneAndUpdate: [], enqueue: [], broadcast: [], userStats: 0, testCount: 0 };
  let stored = { ...attempt };
  stub(TestAttempt, 'findById', () => q(stored));
  stub(TestAttempt, 'findOneAndUpdate', (filter, update) => {
    calls.findOneAndUpdate.push({ filter, update });
    if (stored.status === 'completed') return q(null);
    stored = { ...stored, ...update.$set };
    return q(stored);
  });
  stub(TestAttempt, 'countDocuments', () => { calls.testCount += 1; return q(1); });
  stub(TestAttempt, 'aggregate', async () => [{ _id: null, count: 1, avg: 50 }]);
  stub(Test, 'findByIdAndUpdate', () => q(null));
  stub(User, 'findByIdAndUpdate', () => { calls.userStats += 1; return q(null); });
  stub(User, 'findById', () => q(student));
  stub(Question, 'find', () => q(questions));
  const controller = createTestsController({
    createNotification: async () => {},
    broadcastUserEvent: (evt) => calls.broadcast.push(evt),
    enqueueTutorSession: async (id) => calls.enqueue.push(String(id)),
  });
  return { controller, calls, getStored: () => stored };
}

function fixture() {
  const userId = oid();
  const student = {
    _id: userId, role: 'student', subscription_plan: 'free', email: 's@x.com',
    effective_permissions: ['CanAccessTests'],
  };
  const q1 = { _id: oid(), correct_answers: ['1'], marks: 4, negative_marks: 1, explanation: 'why' };
  const q2 = { _id: oid(), correct_answers: ['2', '3'], marks: 4, negative_marks: 1 };
  const attempt = {
    _id: oid(), test_id: oid(), user_id: userId, user_email: 's@x.com',
    status: 'in_progress', started_at: new Date(Date.now() - 60_000), answers: [],
  };
  return { student, q1, q2, attempt };
}

test('completion is graded server-side and ignores client score fields', async () => {
  const { student, q1, q2, attempt } = fixture();
  const { controller, calls } = setup({ attempt, questions: [q1, q2], student });
  const res = mockRes();
  await controller.updateAttempt({
    params: { id: String(attempt._id) },
    userId: String(student._id),
    user: student,
    body: {
      status: 'completed',
      answers: [
        { question_id: String(q1._id), selected_options: ['1'] },
        { question_id: String(q2._id), selected_options: ['2'] },
      ],
      score: 999, percentage: 100, total_marks: 1, completed_at: '2000-01-01',
      time_taken_seconds: 30,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  const set = calls.findOneAndUpdate[0].update.$set;
  assert.equal(set.score, 3); // +4 correct, -1 wrong
  assert.equal(set.total_marks, 8);
  assert.equal(set.percentage, 37.5);
  assert.equal(set.status, 'completed');
  assert.ok(set.completed_at instanceof Date && set.completed_at.getFullYear() > 2000);
  assert.deepEqual(calls.findOneAndUpdate[0].filter.status, { $ne: 'completed' });
  assert.equal(res.body.attempt.score, 3);
  // Answer key is returned with the completion response.
  assert.deepEqual(res.body.questions[0].correct_answers, ['1']);
});

test('completion side effects run exactly once (wasCompleted regression)', async () => {
  const { student, q1, attempt } = fixture();
  const { controller, calls } = setup({ attempt, questions: [q1], student });
  const req = {
    params: { id: String(attempt._id) }, userId: String(student._id), user: student,
    body: { status: 'completed', answers: { [String(q1._id)]: ['1'] } },
  };
  await controller.updateAttempt(req, mockRes());
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.broadcast.length, 1);
  assert.equal(calls.userStats, 1);
  assert.equal(calls.testCount, 1);

  const second = mockRes();
  await controller.updateAttempt(req, second);
  assert.equal(second.statusCode, 409);
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.broadcast.length, 1);
});

test('completed attempts cannot be modified', async () => {
  const { student, q1, attempt } = fixture();
  const { controller, calls } = setup({ attempt: { ...attempt, status: 'completed' }, questions: [q1], student });
  const res = mockRes();
  await controller.updateAttempt({
    params: { id: String(attempt._id) }, userId: String(student._id), user: student,
    body: { answers: [], status: 'in_progress' },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(calls.findOneAndUpdate.length, 0);
});

test('other users cannot update an attempt', async () => {
  const { student, q1, attempt } = fixture();
  const other = { _id: oid(), role: 'student', effective_permissions: [] };
  const { controller } = setup({ attempt, questions: [q1], student });
  const res = mockRes();
  await controller.updateAttempt({
    params: { id: String(attempt._id) }, userId: String(other._id), user: other,
    body: { status: 'completed' },
  }, res);
  assert.equal(res.statusCode, 403);
});

test('a user with CanViewAllAttempts cannot update another user\'s in-progress attempt (owner only)', async () => {
  const { student, q1, attempt } = fixture();
  const reviewer = { _id: oid(), role: 'admin', effective_permissions: ['CanViewAllAttempts'] };
  const { controller } = setup({ attempt, questions: [q1], student });
  const res = mockRes();
  await controller.updateAttempt({
    params: { id: String(attempt._id) }, userId: String(reviewer._id), user: reviewer,
    body: { status: 'completed' },
  }, res);
  assert.equal(res.statusCode, 403);
});

test('invalid status is rejected', async () => {
  const { student, q1, attempt } = fixture();
  const { controller } = setup({ attempt, questions: [q1], student });
  const res = mockRes();
  await controller.updateAttempt({
    params: { id: String(attempt._id) }, userId: String(student._id), user: student,
    body: { status: 'graded' },
  }, res);
  assert.equal(res.statusCode, 400);
});

test('students do not receive the answer key from listTestQuestions', async () => {
  const { student, q1 } = fixture();
  setup({ attempt: {}, questions: [{ ...q1, explanation_image_url: 'x.png', media: [{ role: 'explanation' }, { role: 'stem' }] }], student });
  stub(Test, 'findById', () => q({ _id: oid(), is_published: true, is_active: true }));
  const controller = createTestsController({ createNotification: async () => {}, broadcastUserEvent: () => {} });
  const res = mockRes();
  await controller.listTestQuestions({ params: { id: String(oid()) }, userId: String(student._id), user: student }, res);
  assert.equal(res.statusCode, 200);
  const [question] = res.body.questions;
  assert.equal(question.correct_answers, undefined);
  assert.equal(question.explanation, undefined);
  assert.equal(question.explanation_image_url, undefined);
  assert.deepEqual(question.media, [{ role: 'stem' }]);
});

test('review is only available for a completed attempt owned by the caller', async () => {
  const { student, q1, attempt } = fixture();
  const completed = { ...attempt, status: 'completed', answers: [{ question_id: q1._id, selected_options: ['1'] }] };
  const { controller } = setup({ attempt: completed, questions: [q1], student });

  const ok = mockRes();
  await controller.getAttemptReview({ params: { id: String(attempt._id) }, userId: String(student._id), user: student }, ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.questions[0].correct_answers, ['1']);

  const stranger = { _id: oid(), role: 'student', effective_permissions: [] };
  const denied = mockRes();
  await controller.getAttemptReview({ params: { id: String(attempt._id) }, userId: String(stranger._id), user: stranger }, denied);
  assert.equal(denied.statusCode, 403);
});

test('a user with CanViewAllAttempts can read another user\'s review; a user without it gets 403', async () => {
  const { student, q1, attempt } = fixture();
  const completed = { ...attempt, status: 'completed', answers: [{ question_id: q1._id, selected_options: ['1'] }] };
  const { controller } = setup({ attempt: completed, questions: [q1], student });

  const reviewer = { _id: oid(), role: 'admin', effective_permissions: ['CanViewAllAttempts'] };
  const allowed = mockRes();
  await controller.getAttemptReview({ params: { id: String(attempt._id) }, userId: String(reviewer._id), user: reviewer }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.body.questions[0].correct_answers, ['1']);

  const teacherWithoutPermission = { _id: oid(), role: 'teacher', effective_permissions: [] };
  const denied = mockRes();
  await controller.getAttemptReview(
    { params: { id: String(attempt._id) }, userId: String(teacherWithoutPermission._id), user: teacherWithoutPermission },
    denied
  );
  assert.equal(denied.statusCode, 403);
});

test('review of an in-progress attempt is refused', async () => {
  const { student, q1, attempt } = fixture();
  const { controller } = setup({ attempt, questions: [q1], student });
  const res = mockRes();
  await controller.getAttemptReview({ params: { id: String(attempt._id) }, userId: String(student._id), user: student }, res);
  assert.equal(res.statusCode, 409);
});
