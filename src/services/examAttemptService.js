const crypto = require('crypto');
const ExamPaper = require('../models/ExamPaper');
const TestAttempt = require('../models/TestAttempt');
const Test = require('../models/Test');
const User = require('../models/User');
const { gradeAttempt, normalizeSubmittedAnswers } = require('./gradingService');

function deadlineFor(test, startedAt) {
  const minutes = Number(test.duration_minutes ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Invalid exam duration');
  const durationEnd = startedAt.getTime() + minutes * 60_000;
  const closing = test.available_until ? new Date(test.available_until).getTime() : Infinity;
  if (Number.isNaN(closing)) throw new Error('Invalid exam closing time');
  return new Date(Math.min(durationEnd, closing));
}

function expired(attempt, now = new Date()) {
  return Boolean(attempt.deadline_at && new Date(attempt.deadline_at).getTime() <= now.getTime());
}

function publicAttempt(attempt) {
  return { ...attempt, server_time: new Date().toISOString() };
}

async function snapshotPaper(testId, questions) {
  const id = crypto.createHash('sha256').update(JSON.stringify({ testId: String(testId), questions })).digest('hex');
  // Concurrent starts share the same immutable document.
  try {
    await ExamPaper.updateOne({ _id: id }, { $setOnInsert: { test_id: testId, questions } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  return id;
}

async function paperQuestions(attempt) {
  const paper = await ExamPaper.findById(attempt.paper_id).lean();
  if (!paper) throw new Error('Exam paper snapshot is unavailable');
  return paper.questions;
}

// Browser-independent completion. A concurrent save/completion wins through CAS;
// the next sweep retries if our read was stale. Never accept new answers here.
async function finalizeExpiredAttempts({ limit = 100, now = new Date(), budgetMs = 10_000, concurrency = 1 } = {}) {
  const stopAt = Date.now() + budgetMs;
  const pending = await TestAttempt.find({
    exam_protocol: 1, status: 'in_progress', deadline_at: { $lte: now },
    $or: [{ finalize_next_run_at: { $exists: false } }, { finalize_next_run_at: null }, { finalize_next_run_at: { $lte: now } }],
  }).sort({ deadline_at: 1 }).limit(limit).lean();
  let completed = 0;
  const failures = [];
  const papers = new Map();
  let next = 0;
  const processOne = async (attempt) => {
    try {
      if (!papers.has(attempt.paper_id)) papers.set(attempt.paper_id, paperQuestions(attempt));
      const questions = await papers.get(attempt.paper_id);
      const graded = gradeAttempt(questions, normalizeSubmittedAnswers(attempt.answers));
      const saved = await TestAttempt.findOneAndUpdate({
        _id: attempt._id, status: 'in_progress', answer_version: attempt.answer_version,
      }, { $set: {
        ...graded, status: 'completed', completed_at: attempt.deadline_at,
        completion_effects_pending: true,
        time_taken_seconds: Math.max(0, Math.floor((new Date(attempt.deadline_at) - new Date(attempt.started_at)) / 1000)),
      }, $inc: { answer_version: 1 } }, { new: true }).lean();
      if (saved) completed += 1;
    } catch (err) {
      failures.push({ attemptId: String(attempt._id), error: err.message });
      // A damaged snapshot must not occupy the head of every sweep forever.
      await TestAttempt.updateOne({ _id: attempt._id, status: 'in_progress', answer_version: attempt.answer_version },
        { $set: { finalize_next_run_at: new Date(Date.now() + 5 * 60_000), finalize_error: 'Grading data unavailable; operator repair required' } });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(32, concurrency)) }, async () => {
    while (next < pending.length && Date.now() < stopAt) await processOne(pending[next++]);
  }));
  return { checked: pending.length, completed, failures };
}

async function reconcileCompletionEffects({ limit = 500, budgetMs = 10_000 } = {}) {
  const stopAt = Date.now() + budgetMs;
  const pending = await TestAttempt.find({ status: 'completed', completion_effects_pending: true })
    .sort({ completed_at: 1 }).limit(limit).select('_id test_id user_id').lean();
  if (!pending.length) return { processed: 0 };
  // Recompute once per distinct test/user in a batch. Replays are safe and do
  // not double-increment counters. A periodic pass repairs concurrent reads.
  const byTest = pending.reduce((groups, a) => {
    const key = String(a.test_id);
    groups.set(key, [...(groups.get(key) || []), a]);
    return groups;
  }, new Map());
  let processed = 0;
  for (const attempts of byTest.values()) {
    if (Date.now() >= stopAt) break;
    const testId = attempts[0].test_id;
    const count = await TestAttempt.countDocuments({ test_id: testId, status: 'completed' });
    await Test.updateOne({ _id: testId }, { $max: { attempt_count: count } });
    const users = [...new Map(attempts.map(a => [String(a.user_id), a.user_id])).values()];
    for (const userId of users) {
      if (Date.now() >= stopAt) return { processed };
      const [stats] = await TestAttempt.aggregate([
        { $match: { user_id: userId, status: 'completed' } },
        { $group: { _id: null, count: { $sum: 1 }, average: { $avg: '$percentage' } } },
      ]);
      const total = stats?.count || 0;
      await User.updateOne({ _id: userId, $or: [{ tests_taken: { $lte: total } }, { tests_taken: { $exists: false } }] },
        { $set: { tests_taken: total, average_score: stats?.average || 0 } });
      const ids = attempts.filter(a => String(a.user_id) === String(userId)).map(a => a._id);
      await TestAttempt.updateMany({ _id: { $in: ids }, completion_effects_pending: true },
        { $set: { completion_effects_pending: false } });
      processed += ids.length;
    }
  }
  return { processed };
}

module.exports = { deadlineFor, expired, publicAttempt, snapshotPaper, paperQuestions, finalizeExpiredAttempts, reconcileCompletionEffects };
