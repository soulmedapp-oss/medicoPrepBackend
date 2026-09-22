const test = require('node:test');
const assert = require('node:assert/strict');
const {
  gradeAttempt,
  normalizeSubmittedAnswers,
  isAnswerCorrect,
} = require('../src/services/gradingService');

const q = (id, correct, extra = {}) => ({
  _id: id,
  question_type: correct.length > 1 ? 'multiple_choice' : 'single_choice',
  correct_answers: correct,
  marks: 1,
  negative_marks: 0,
  ...extra,
});

test('correct single-choice answer earns the question marks', () => {
  const result = gradeAttempt([q('a', ['2'], { marks: 4 })], { a: ['2'] });
  assert.equal(result.score, 4);
  assert.equal(result.total_marks, 4);
  assert.equal(result.percentage, 100);
  assert.deepEqual(result.answers, [
    { question_id: 'a', selected_options: ['2'], is_correct: true, marks_obtained: 4 },
  ]);
});

test('wrong answer earns minus negative_marks', () => {
  const result = gradeAttempt(
    [q('a', ['1'], { marks: 4, negative_marks: 1 }), q('b', ['3'], { marks: 4, negative_marks: 1 })],
    { a: ['1'], b: ['2'] }
  );
  assert.equal(result.answers[1].is_correct, false);
  assert.equal(result.answers[1].marks_obtained, -1);
  assert.equal(result.score, 3);
  assert.equal(result.total_marks, 8);
  assert.equal(result.percentage, 37.5);
});

test('unanswered question scores zero (no negative marking)', () => {
  const result = gradeAttempt([q('a', ['1'], { negative_marks: 1 })], {});
  assert.equal(result.answers[0].is_correct, false);
  assert.equal(result.answers[0].marks_obtained, 0);
  assert.deepEqual(result.answers[0].selected_options, []);
  assert.equal(result.score, 0);
  assert.equal(result.answered_count, 0);
});

test('multi-select requires the exact set (order-insensitive, no partial credit)', () => {
  const questions = [q('a', ['1', '3'], { marks: 2 }), q('b', ['1', '3'], { marks: 2 }), q('c', ['1', '3'], { marks: 2 })];
  const result = gradeAttempt(questions, { a: ['3', '1'], b: ['1'], c: ['1', '3', '4'] });
  assert.deepEqual(result.answers.map((a) => a.is_correct), [true, false, false]);
  assert.equal(result.score, 2);
});

test('duplicate selections cannot fake a multi-select match', () => {
  assert.equal(isAnswerCorrect(['1', '1'], ['1', '2']), false);
  const result = gradeAttempt([q('a', ['1', '2'])], { a: ['1', '1'] });
  assert.equal(result.answers[0].is_correct, false);
  assert.deepEqual(result.answers[0].selected_options, ['1']);
});

test('total score is floored at zero', () => {
  const result = gradeAttempt(
    [q('a', ['1'], { negative_marks: 2 }), q('b', ['1'], { negative_marks: 2 })],
    { a: ['2'], b: ['2'] }
  );
  assert.equal(result.score, 0);
  assert.equal(result.percentage, 0);
});

test('missing/zero marks default to 1 (matches legacy client scoring)', () => {
  const result = gradeAttempt([q('a', ['1'], { marks: 0 }), q('b', ['1'], { marks: undefined })], { a: ['1'], b: ['1'] });
  assert.equal(result.total_marks, 2);
  assert.equal(result.score, 2);
});

test('no questions gives 0% rather than NaN', () => {
  const result = gradeAttempt([], {});
  assert.equal(result.total_marks, 0);
  assert.equal(result.percentage, 0);
});

test('answers for questions not in the test are ignored', () => {
  const result = gradeAttempt([q('a', ['1'])], { a: ['1'], zzz: ['1'] });
  assert.equal(result.answers.length, 1);
  assert.equal(result.score, 1);
});

test('normalizeSubmittedAnswers accepts array and map forms and sanitizes values', () => {
  assert.deepEqual(
    normalizeSubmittedAnswers([
      { question_id: 'a', selected_options: ['1', 2, null, '1'], is_correct: true, marks_obtained: 99 },
      { question_id: 'b' },
      { selected_options: ['1'] },
      null,
    ]),
    { a: ['1', '2'], b: [] }
  );
  assert.deepEqual(normalizeSubmittedAnswers({ a: ['3'], b: 'x' }), { a: ['3'], b: [] });
  assert.deepEqual(normalizeSubmittedAnswers(undefined), {});
  assert.deepEqual(normalizeSubmittedAnswers('nope'), {});
});

test('client-supplied is_correct / marks_obtained are ignored by grading', () => {
  const answers = normalizeSubmittedAnswers([
    { question_id: 'a', selected_options: ['2'], is_correct: true, marks_obtained: 100 },
  ]);
  const result = gradeAttempt([q('a', ['1'], { negative_marks: 1 })], answers);
  assert.equal(result.answers[0].is_correct, false);
  assert.equal(result.score, 0);
});

test('question ids may be ObjectId-like objects', () => {
  const oid = { toString: () => '507f1f77bcf86cd799439011' };
  const result = gradeAttempt([q(oid, ['1'])], { '507f1f77bcf86cd799439011': ['1'] });
  assert.equal(result.score, 1);
  assert.equal(result.answers[0].question_id, oid);
});
