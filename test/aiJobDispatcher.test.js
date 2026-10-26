const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchOne, dispatchDueJobs } = require('../src/services/aiJobDispatcher');
const id = '0123456789abcdef01234567';
const stateMachineArn = 'arn:aws:states:ap-south-1:986518320302:stateMachine:soulmed-prod-cost-worker';
function collection(record) {
  return { writes: [], async findOneAndUpdate() { return record; },
    async updateOne(filter, change) { this.writes.push(change); return { matchedCount: 1 }; } };
}
test('rejects any unrelated state machine before touching the database', async () => {
  let touched = false;
  await assert.rejects(dispatchOne({ collection: { findOneAndUpdate() { touched = true; } },
    source: 'jobs', id, stateMachineArn: stateMachineArn.replace('cost-worker', 'production') }), /Unexpected/);
  assert.equal(touched, false);
});
test('does not launch a task when the database lease is unavailable', async () => {
  const result = await dispatchOne({ collection: collection(null), source: 'jobs', id, stateMachineArn,
    client: { send() { throw new Error('must not call AWS'); } } });
  assert.equal(result, 'skipped');
});
test('a lost start response reuses the persisted execution name and exact input', async () => {
  const row = { _id: id, dispatch_execution_name: 'jobs-stable-name' };
  const calls = [];
  const client = { async send(command, options) {
    assert.ok(options.abortSignal);
    calls.push(command);
    if (command.constructor.name === 'DescribeExecutionCommand') throw Object.assign(new Error(), { name: 'ExecutionDoesNotExist' });
    return { executionArn: 'started' };
  } };
  const result = await dispatchOne({ collection: collection(row), source: 'jobs', id, stateMachineArn, client });
  assert.equal(result, 'started');
  assert.equal(calls[1].input.name, row.dispatch_execution_name);
  assert.deepEqual(JSON.parse(calls[1].input.input), { source: 'jobs', job_id: id });
});
test('an existing running execution prevents a duplicate start', async () => {
  let sends = 0;
  const result = await dispatchOne({ collection: collection({ dispatch_execution_name: 'active' }), source: 'imported', id, stateMachineArn,
    client: { async send() { sends++; return { status: 'RUNNING' }; } } });
  assert.equal(result, 'running'); assert.equal(sends, 1);
});
test('global concurrency stays at one even when other jobs are queued', async () => {
  const control = collection({ active_execution_arn: 'active' });
  const result = await dispatchDueJobs({ database: { collection(name) {
    assert.equal(name, 'ai_dispatch_control'); return control;
  } }, stateMachineArn, client: { async send() { return { status: 'RUNNING' }; } } });
  assert.equal(result.running, 1); assert.equal(result.started, 0);
  assert.ok(control.writes.some(w => w.$unset?.owner === ''));
});
