// Pure, dependency-free grading logic for test attempts. The server is the only
// authority on score/percentage; clients submit selected options only.
//
// Scoring rules (ported from the former client-side calculateScore in TakeTest.jsx):
//   - A question is correct only when the selected option set equals the
//     correct_answers set exactly (order-insensitive, no partial credit for
//     multi-select).
//   - Correct: +marks (marks falsy/0 => 1, as before).
//   - Wrong (at least one option selected): -negative_marks.
//   - Unanswered: 0. (The legacy client also applied negative marks to blank
//     answers; that was a bug and is intentionally not replicated.)
//   - Total score is floored at 0; total_marks = sum of marks of graded questions.

const MAX_OPTIONS_PER_ANSWER = 20;
const MAX_OPTION_ID_LENGTH = 64;

function questionMarks(question) {
  return Number(question?.marks) || 1;
}

function questionNegativeMarks(question) {
  const value = Number(question?.negative_marks) || 0;
  return value > 0 ? value : 0;
}

function sanitizeSelection(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const id = String(raw).trim().slice(0, MAX_OPTION_ID_LENGTH);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_OPTIONS_PER_ANSWER) break;
  }
  return out;
}

/**
 * Accepts either the legacy array form `[{ question_id, selected_options }]`
 * or a map `{ [questionId]: [optionId, ...] }` and returns a sanitized map.
 * Any client-provided is_correct / marks_obtained is discarded.
 */
function normalizeSubmittedAnswers(input) {
  const result = {};
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry || typeof entry !== 'object') continue;
      const id = entry.question_id;
      if (id === null || id === undefined || id === '') continue;
      result[String(id)] = sanitizeSelection(entry.selected_options);
    }
    return result;
  }
  if (input && typeof input === 'object') {
    for (const [id, selection] of Object.entries(input)) {
      if (!id) continue;
      result[id] = sanitizeSelection(selection);
    }
  }
  return result;
}

function isAnswerCorrect(selected, correctAnswers) {
  const picked = new Set((selected || []).map(String));
  const correct = new Set((correctAnswers || []).map(String));
  if (picked.size !== (selected || []).length) return false; // duplicates
  if (picked.size === 0 || picked.size !== correct.size) return false;
  for (const id of picked) {
    if (!correct.has(id)) return false;
  }
  return true;
}

/**
 * @param {Array} questions  Question docs (need _id|id, correct_answers, marks, negative_marks)
 * @param {Object} answerMap  Output of normalizeSubmittedAnswers
 * @returns {{ score, total_marks, percentage, answered_count, correct_count, answers }}
 */
function gradeAttempt(questions, answerMap = {}) {
  const answers = [];
  let rawScore = 0;
  let totalMarks = 0;
  let answeredCount = 0;
  let correctCount = 0;

  for (const question of questions || []) {
    const questionId = question._id ?? question.id;
    const selected = sanitizeSelection(answerMap[String(questionId)]);
    const marks = questionMarks(question);
    totalMarks += marks;

    let isCorrect = false;
    let marksObtained = 0;
    if (selected.length > 0) {
      answeredCount += 1;
      isCorrect = isAnswerCorrect(selected, question.correct_answers);
      marksObtained = isCorrect ? marks : -questionNegativeMarks(question);
      if (marksObtained === 0) marksObtained = 0; // normalize -0
      if (isCorrect) correctCount += 1;
    }
    rawScore += marksObtained;

    answers.push({
      question_id: questionId,
      selected_options: selected,
      is_correct: isCorrect,
      marks_obtained: marksObtained,
    });
  }

  const score = Math.max(0, rawScore);
  const percentage = totalMarks > 0 ? (score / totalMarks) * 100 : 0;
  return {
    score,
    total_marks: totalMarks,
    percentage,
    answered_count: answeredCount,
    correct_count: correctCount,
    answers,
  };
}

module.exports = {
  gradeAttempt,
  normalizeSubmittedAnswers,
  isAnswerCorrect,
  sanitizeSelection,
};
