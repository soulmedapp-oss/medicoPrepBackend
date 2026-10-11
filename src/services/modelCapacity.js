const { randomUUID } = require('node:crypto');
const WorkerLease = require('../models/WorkerLease');
const RateLimitEntry = require('../models/RateLimitEntry');

function busy() { const err = new Error('AI service is busy. Please retry shortly.'); err.code = 'AI_BUSY'; return err; }
async function reserveBudget(key, amount, maximum, windowMs) {
  const start = Math.floor(Date.now() / windowMs) * windowMs;
  if (amount > maximum) throw busy();
  try {
    await RateLimitEntry.findOneAndUpdate({ _id: `model:${key}:${start}`, count: { $lte: maximum - amount } }, {
      $inc: { count: amount }, $setOnInsert: { expires_at: new Date(start + windowMs) },
    }, { upsert: true, maxTimeMS: 2000 });
  } catch (err) { if (err.code === 11000) throw busy(); throw err; }
}

async function withModelCapacity(request, invoke) {
  if (process.env.MODEL_CAPACITY_ENABLED !== 'true') return invoke(request);
  const owner = randomUUID();
  const slots = Math.max(1, Math.min(64, Number(process.env.OPENAI_GLOBAL_CONCURRENCY) || 8));
  let slot;
  for (let i = 0; i < slots; i += 1) {
    try {
      const key = `openai:${i}`;
      await WorkerLease.findOneAndUpdate({ _id: key, expires_at: { $lte: new Date() } },
        { $set: { owner, expires_at: new Date(Date.now() + 60_000) } }, { upsert: true });
      slot = key; break;
    } catch (err) { if (err.code !== 11000) throw err; }
  }
  if (!slot) throw busy();
  try {
    const estimated = Buffer.byteLength(JSON.stringify(request.messages || [])) + (request.max_tokens || 600);
    const model = request.model || 'default';
    await reserveBudget(`${model}:requests`, 1, Number(process.env.OPENAI_REQUESTS_PER_MINUTE) || 120, 60_000);
    await reserveBudget(`${model}:tokens`, estimated, Number(process.env.OPENAI_TOKENS_PER_MINUTE) || 100_000, 60_000);
    await reserveBudget('daily-tokens', estimated, Number(process.env.OPENAI_TOKENS_PER_DAY) || 2_000_000, 86_400_000);
    return await invoke(request);
  } finally { await WorkerLease.updateOne({ _id: slot, owner }, { $set: { expires_at: new Date(0) } }); }
}
module.exports = { withModelCapacity, reserveBudget };
