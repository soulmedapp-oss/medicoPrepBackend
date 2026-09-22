// Task 11: audit coverage for settingsController.js (updateOpenAiKeySetting).
// No prior controller-level test file exists for settingsController, so this
// is a new one, in the same stubbed-statics style as test/rbacRolesApi.test.js.
// Addendum B: settings audit entries carry NO before/after at all, or
// `after: { configured: true|false }` — the key value itself must never
// reach recordAudit (see test/rbacAudit.test.js for the redaction proof).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-encryption-key-32-chars-long';
const test = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../src/models/Settings');
const AuditLog = require('../src/models/AuditLog');
const { createSettingsController } = require('../src/controllers/settingsController');

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

function controller() { return createSettingsController(); }

test('updateOpenAiKeySetting: setting a key writes settings.openai_key_changed with after: { configured: true }, no before, no key value', async () => {
  stub(Settings, 'findOneAndUpdate', () => ({ lean: async () => ({ key: 'openai_api_key' }) }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await controller().updateOpenAiKeySetting({ userId: 'u1', user: { full_name: 'Asha' }, body: { api_key: 'sk-1234567890123456789012' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'settings.openai_key_changed');
  assert.deepEqual(saved.after, { configured: true });
  assert.equal(saved.before, null);
  assert.equal(JSON.stringify(saved).includes('sk-'), false, 'the key value must never reach the audit log');
});

test('updateOpenAiKeySetting: clearing the key writes settings.openai_key_changed with after: { configured: false }', async () => {
  stub(Settings, 'deleteOne', async () => ({ acknowledged: true }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await controller().updateOpenAiKeySetting({ userId: 'u1', user: { full_name: 'Asha' }, body: { api_key: '' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'settings.openai_key_changed');
  assert.deepEqual(saved.after, { configured: false });
});

test('updateOpenAiKeySetting: a too-short key is refused 400, nothing written to the audit log', async () => {
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await controller().updateOpenAiKeySetting({ userId: 'u1', body: { api_key: 'short' } }, res);
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});

test('updateOpenAiKeySetting: missing APP_ENCRYPTION_KEY is refused 400, nothing written to the audit log', async () => {
  const original = process.env.APP_ENCRYPTION_KEY;
  delete process.env.APP_ENCRYPTION_KEY;
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  try {
    await controller().updateOpenAiKeySetting({ userId: 'u1', body: { api_key: 'sk-1234567890123456789012' } }, res);
  } finally {
    process.env.APP_ENCRYPTION_KEY = original;
  }
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});
