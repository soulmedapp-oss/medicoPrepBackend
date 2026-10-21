require('dotenv').config();
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const Lease = require('../src/models/WorkerLease');
const TestAttempt = require('../src/models/TestAttempt');
const { finalizeExpiredAttempts } = require('../src/services/examAttemptService');
const { reconcileCompletionEffectsBulk } = require('../src/services/completionEffectsWorker');
const { logger } = require('../src/lib/logger');
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, maxPoolSize: 20 });
  while (!stopping) {
    const owner = randomUUID();
    let claimed = false;
    try {
      try {
        await Lease.findOneAndUpdate({ _id: 'exam-maintenance', expires_at: { $lte: new Date() } },
          { $set: { owner, expires_at: new Date(Date.now() + 60_000) } }, { upsert: true });
        claimed = true;
      } catch (err) { if (err.code !== 11000) throw err; }
      if (claimed) {
        const result = await finalizeExpiredAttempts({ limit: 1000, concurrency: 16, budgetMs: 20_000 });
        const effects = await reconcileCompletionEffectsBulk();
        const oldest = await TestAttempt.findOne({ status: 'in_progress', exam_protocol: 1, deadline_at: { $lte: new Date() } })
          .sort({ deadline_at: 1 }).select('deadline_at').lean();
        const overdue_oldest_seconds = oldest ? Math.max(0, (Date.now() - new Date(oldest.deadline_at).getTime()) / 1000) : 0;
        logger.info({ ...result, ...effects, overdue_oldest_seconds }, 'Exam maintenance batch');
        if (result.failures.length) logger.error({ failures: result.failures }, 'Exam maintenance failed');
      }
    } catch (err) { logger.error({ err }, 'Exam maintenance failed'); }
    finally {
      if (claimed) await Lease.updateOne({ _id: 'exam-maintenance', owner }, { $set: { expires_at: new Date(0) } });
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await mongoose.disconnect();
})().catch((err) => { logger.error({ err }, 'Exam maintenance startup failed'); process.exitCode = 1; });
