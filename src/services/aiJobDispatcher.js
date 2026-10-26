// Durable dispatcher for finite AI tasks. It runs on the backend host, not
// inside App Runner. Database leases remain the authority for job processing.
const { randomUUID } = require('node:crypto');
const { StartExecutionCommand, DescribeExecutionCommand } = require('@aws-sdk/client-sfn');
const LEASE_MS = 120_000;
const LIVE_EXECUTIONS = new Set(['RUNNING', 'PENDING_REDRIVE']);
function dueFilter(source, now) {
  const work = source === 'imported'
    ? { status: { $in: ['queued', 'processing', 'publishing'] }, lease_until: { $lte: now } }
    : { $or: [{ status: 'queued' }, { status: 'running', lease_until: { $lt: now } }], attempts: { $lt: 3 } };
  return { $and: [work, { $or: [{ dispatch_lock_until: { $exists: false } }, { dispatch_lock_until: { $lte: now } }] }] };
}
function executionArn(machine, name) {
  return `${machine.replace(':stateMachine:', ':execution:')}:${name}`;
}
async function dispatchOne({ collection, source, id, client, stateMachineArn, now = new Date(), onStarting = async () => {} }) {
  if (!['jobs', 'imported'].includes(source) || !/^[a-f0-9]{24}$/.test(String(id))) throw new Error('Invalid AI job identity');
  if (!/^arn:aws:states:ap-south-1:986518320302:stateMachine:soulmed-prod-cost-[A-Za-z0-9_-]+$/.test(stateMachineArn)) throw new Error('Unexpected state machine');
  const owner = randomUUID();
  const record = await collection.findOneAndUpdate({ _id: id, ...dueFilter(source, now) },
    { $set: { dispatch_lock_owner: owner, dispatch_lock_until: new Date(now.getTime() + LEASE_MS) } }, { returnDocument: 'after' });
  if (!record) return 'skipped';
  const fence = { _id: id, dispatch_lock_owner: owner };
  let name = record.dispatch_execution_name;
  if (name) {
    try {
      const existing = await client.send(new DescribeExecutionCommand({ executionArn: executionArn(stateMachineArn, name) }), { abortSignal: AbortSignal.timeout(10_000) });
      if (LIVE_EXECUTIONS.has(existing.status)) { await onStarting(executionArn(stateMachineArn, name)); return 'running'; }
      // A completed execution may precede an operator retry or a stale DB lease.
      name = null;
    } catch (err) {
      if (err.name !== 'ExecutionDoesNotExist') throw err;
      // A previous StartExecution response may have been lost. Reuse the exact
      // name/input so a network retry cannot launch duplicate work.
    }
  }
  if (!name) {
    name = `${source}-${id}-${randomUUID().replaceAll('-', '')}`;
    await collection.updateOne(fence, { $set: { dispatch_execution_name: name } });
  }
  await onStarting(executionArn(stateMachineArn, name));
  const result = await client.send(new StartExecutionCommand({ stateMachineArn, name,
    input: JSON.stringify({ source, job_id: String(id) }) }), { abortSignal: AbortSignal.timeout(10_000) });
  await collection.updateOne(fence, { $set: { dispatch_execution_arn: result.executionArn, dispatched_at: now } });
  return 'started';
}
async function repairOutbox(database, now = new Date()) {
  let repaired = 0;
  for (const [name, type, who] of [['subject_documents', 'ingest', 'uploaded_by'], ['generation_jobs', 'generate', 'requested_by']]) {
    const candidates = await database.collection(name).find({ status: 'pending', created_at: { $lte: new Date(now.getTime() - 30_000) } }).limit(20).toArray();
    for (const doc of candidates) {
      const queue = database.collection('jobs');
      if (await queue.findOne({ ref_id: doc._id, type })) continue;
      try {
        await queue.insertOne({ type, status: 'queued', ref_id: doc._id, subject_id: doc.subject_id,
          subject_name: doc.subject_name, title: doc.file_name || doc.name || 'Recovered job',
          payload: {}, requested_by: doc[who], attempts: 0, claimed_by: null, lease_until: null,
          cost_usd: 0, progress: { stage: 'queued', pct: 0 }, error: null,
          created_at: now, updated_at: now, started_at: null, finished_at: null });
        repaired += 1;
      } catch (err) { if (err.code !== 11000) throw err; }
    }
  }
  return repaired;
}
async function dispatchDueJobs({ database, client, stateMachineArn, now = new Date() }) {
  const result = { started: 0, running: 0, skipped: 0, errors: 0, repaired: 0 };
  const control = database.collection('ai_dispatch_control');
  const owner = randomUUID();
  let lock;
  try {
    lock = await control.findOneAndUpdate({ _id: 'singleton', $or: [{ lease_until: { $lte: now } }, { lease_until: { $exists: false } }] },
      { $set: { owner, lease_until: new Date(now.getTime() + 300_000) } }, { upsert: true, returnDocument: 'after' });
  } catch (error) { if (error.code === 11000) return { ...result, skipped: 1 }; throw error; }
  if (!lock) return { ...result, skipped: 1 };
  const fence = { _id: 'singleton', owner };
  try {
    if (lock.active_execution_arn) {
      try {
        const active = await client.send(new DescribeExecutionCommand({ executionArn: lock.active_execution_arn }), { abortSignal: AbortSignal.timeout(10_000) });
        if (LIVE_EXECUTIONS.has(active.status)) return { ...result, running: 1 };
      } catch (error) {
        if (error.name !== 'ExecutionDoesNotExist') throw error;
        // Do not assume a just-started execution is missing during propagation.
        if (lock.active_at && now.getTime() - lock.active_at.getTime() < 120_000) return { ...result, skipped: 1 };
      }
      await control.updateOne(fence, { $unset: { active_execution_arn: '', active_at: '' } });
    }
    result.repaired = await repairOutbox(database, now);
    await database.collection('jobs').updateMany({ status: 'running', attempts: { $gte: 3 }, lease_until: { $lt: now } },
      { $set: { status: 'failed', error: 'Worker stopped after repeated attempts', finished_at: now, updated_at: now, lease_until: null } });
    const candidates = [];
    for (const [name, source] of [['jobs', 'jobs'], ['question_bank_imports', 'imported']]) {
      const collection = database.collection(name);
      const records = await collection.find(dueFilter(source, now)).sort({ created_at: 1 }).limit(1).toArray();
      if (records.length) candidates.push({ collection, source, record: records[0] });
    }
    candidates.sort((a,b) => new Date(a.record.created_at || 0) - new Date(b.record.created_at || 0));
    if (!candidates.length) return result;
    const { collection, source, record } = candidates[0];
    const status = await dispatchOne({ collection, source, id: record._id, client, stateMachineArn, now,
      onStarting: async arn => {
        const current = new Date();
        const saved = await control.updateOne({ ...fence, lease_until: { $gt: current } },
          { $set: { active_execution_arn: arn, active_at: current, lease_until: new Date(current.getTime() + 300_000) } });
        if (saved.matchedCount !== 1) throw new Error('Dispatcher leadership expired before start');
      } });
    result[status] += 1;
    return result;
  } finally {
    await control.updateOne(fence, { $set: { lease_until: new Date(0) }, $unset: { owner: '' } });
  }
}

module.exports = { dispatchOne, dispatchDueJobs, repairOutbox, dueFilter, executionArn };
