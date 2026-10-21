const TestAttempt = require('../models/TestAttempt');
const Test = require('../models/Test');
const User = require('../models/User');

async function reconcileCompletionEffectsBulk({ limit = 1000 } = {}) {
  const pending = await TestAttempt.find({ status: 'completed', completion_effects_pending: true })
    .sort({ completed_at: 1 }).limit(limit).select('_id test_id user_id').lean();
  if (!pending.length) return { effects_processed: 0 };
  const userIds = [...new Map(pending.map((a) => [String(a.user_id), a.user_id])).values()];
  const testIds = [...new Map(pending.map((a) => [String(a.test_id), a.test_id])).values()];
  const [users, tests] = await Promise.all([
    TestAttempt.aggregate([
      { $match: { user_id: { $in: userIds }, status: 'completed' } },
      { $group: { _id: '$user_id', count: { $sum: 1 }, average: { $avg: '$percentage' } } },
    ]).option({ maxTimeMS: 20_000 }),
    TestAttempt.aggregate([
      { $match: { test_id: { $in: testIds }, status: 'completed' } },
      { $group: { _id: '$test_id', count: { $sum: 1 } } },
    ]).option({ maxTimeMS: 20_000 }),
  ]);
  if (tests.length) await Test.bulkWrite(tests.map((row) => ({ updateOne: {
    filter: { _id: row._id }, update: { $max: { attempt_count: row.count } },
  } })), { ordered: false });
  if (users.length) await User.bulkWrite(users.map((row) => ({ updateOne: {
    filter: { _id: row._id, $or: [{ tests_taken: { $lte: row.count } }, { tests_taken: { $exists: false } }] },
    update: { $set: { tests_taken: row.count, average_score: row.average || 0 } },
  } })), { ordered: false });
  // Only acknowledge after BOTH writes succeed. Replays recompute rather than increment.
  await TestAttempt.updateMany({ _id: { $in: pending.map((a) => a._id) }, completion_effects_pending: true },
    { $set: { completion_effects_pending: false } });
  return { effects_processed: pending.length };
}
module.exports = { reconcileCompletionEffectsBulk };
