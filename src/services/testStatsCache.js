const { randomUUID } = require('node:crypto');
const TestAttempt = require('../models/TestAttempt');
const Cache = require('../models/TestStatsCache');
const Lease = require('../models/WorkerLease');

function summarize(rows, total, top, totalMarks) {
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  const at = (position) => {
    let seen = 0;
    for (const row of rows) { seen += row.count; if (seen > position) return row._id; }
    return null;
  };
  return {
    total_attempts: total, scored_count: count,
    median_percentage: count ? (at(Math.floor((count - 1) / 2)) + at(Math.floor(count / 2))) / 2 : null,
    top_percentage: top?.percentage ?? null, top_score: top?.score ?? null,
    top_total_marks: top ? (top.total_marks ?? totalMarks ?? null) : null,
  };
}

async function getSharedStats(test) {
  const cached = await Cache.findById(test._id).lean();
  if (cached && Date.now() - new Date(cached.refreshed_at).getTime() < 60_000) return cached;
  const owner = randomUUID();
  const leaseId = `test-stats:${test._id}`;
  try {
    await Lease.findOneAndUpdate({ _id: leaseId, expires_at: { $lte: new Date() } }, {
      $set: { owner, expires_at: new Date(Date.now() + 120_000) },
    }, { upsert: true, new: true });
  } catch (err) { if (err.code === 11000) return cached; throw err; }
  try {
    const [result] = await TestAttempt.aggregate([
      { $match: { test_id: test._id, status: 'completed' } },
      { $facet: {
        total: [{ $count: 'count' }],
        distribution: [{ $match: { percentage: { $type: 'number' } } }, { $group: { _id: '$percentage', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
        top: [{ $match: { percentage: { $type: 'number' } } }, { $sort: { percentage: -1, score: -1 } }, { $limit: 1 }, { $project: { percentage: 1, score: 1, total_marks: 1 } }],
      } },
    ]).option({ maxTimeMS: 20_000 });
    const distribution = result?.distribution || [];
    const snapshot = { refreshed_at: new Date(), distribution,
      stats: summarize(distribution, result?.total?.[0]?.count || 0, result?.top?.[0], test.total_marks) };
    return await Cache.findOneAndUpdate({ _id: test._id }, { $set: snapshot }, { upsert: true, new: true }).lean();
  } finally { await Lease.updateOne({ _id: leaseId, owner }, { $set: { expires_at: new Date(0) } }); }
}

function personalize(snapshot, percentage) {
  const { scored_count: count, ...stats } = snapshot.stats;
  const valid = typeof percentage === 'number' && Number.isFinite(percentage) && count > 0;
  const below = valid ? snapshot.distribution.reduce((sum, row) => sum + (row._id < percentage ? row.count : 0), 0) : 0;
  return { ...stats, percentile: valid ? Math.round(below / count * 1000) / 10 : null,
    user_percentage: valid ? percentage : null, as_of: snapshot.refreshed_at };
}

module.exports = { getSharedStats, summarize, personalize };
