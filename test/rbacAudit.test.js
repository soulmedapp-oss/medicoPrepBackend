// Task 11: the audit log utility (recordAudit + redact) and the
// GET /audit-log controller. Style: test/rbacRolesApi.test.js (stubbed
// Mongoose statics, mock req/res, allow AND deny, assert what was written).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../src/models/AuditLog');
const { recordAudit, redact, recordActiveStateChange, recordDeactivated } = require('../src/utils/audit');
const { createAuditLogController } = require('../src/controllers/auditLogController');

const oid = () => new mongoose.Types.ObjectId();

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

// ============================== recordAudit ==============================

test('recordAudit stores actor and entry', async () => {
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  await recordAudit({ userId: 'u1', user: { full_name: 'Asha', email: 'a@b.c' } },
    { action: 'role.updated', target_type: 'role', target_id: 'r1', target_label: 'teacher', before: { permissions: [] }, after: { permissions: ['CanViewTests'] } });
  assert.equal(saved.actor_id, 'u1');
  assert.equal(saved.actor_name, 'Asha');
  assert.equal(saved.action, 'role.updated');
  assert.deepEqual(saved.after, { permissions: ['CanViewTests'] });
});

test('recordAudit falls back to email when full_name is absent', async () => {
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  await recordAudit({ userId: 'u1', user: { email: 'a@b.c' } }, { action: 'x' });
  assert.equal(saved.actor_name, 'a@b.c');
});

test('recordAudit never throws when the database write fails', async () => {
  stub(AuditLog, 'create', async () => { throw new Error('db down'); });
  await assert.doesNotReject(recordAudit({ userId: 'u1' }, { action: 'x' }));
});

test('recordAudit never throws and never hangs when req is missing entirely', async () => {
  stub(AuditLog, 'create', async (doc) => doc);
  await assert.doesNotReject(recordAudit(undefined, { action: 'x' }));
});

test('the OpenAI key value is never written', async () => {
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  await recordAudit({ userId: 'u1' }, { action: 'settings.openai_key_changed', target_type: 'settings', before: { api_key: 'sk-secret' }, after: { api_key: 'sk-new' } });
  assert.equal(JSON.stringify(saved).includes('sk-'), false);
});

// ================= recordActiveStateChange / recordDeactivated =================
// Shared helper used by the nine PATCH-can-deactivate resources (addendum A).

test('recordActiveStateChange: is_active true -> false writes <resource>.deactivated, target_* only', async () => {
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  await recordActiveStateChange({ userId: 'u1' }, {
    resource: 'test', before: { is_active: true }, after: { _id: 'id1', is_active: false }, targetLabel: 'Anatomy',
  });
  assert.equal(saved.action, 'test.deactivated');
  assert.equal(saved.target_type, 'test');
  assert.equal(saved.target_id, 'id1');
  assert.equal(saved.target_label, 'Anatomy');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

test('recordActiveStateChange: is_active false -> true writes <resource>.reactivated', async () => {
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  await recordActiveStateChange({ userId: 'u1' }, {
    resource: 'video', before: { is_active: false }, after: { _id: 'id1', is_active: true }, targetLabel: 'Lecture 1',
  });
  assert.equal(saved.action, 'video.reactivated');
});

test('recordActiveStateChange: is_active unchanged writes nothing (content edits are not audited)', async () => {
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  await recordActiveStateChange({ userId: 'u1' }, {
    resource: 'coupon', before: { is_active: true }, after: { _id: 'id1', is_active: true }, targetLabel: 'SAVE10',
  });
  assert.equal(auditCalled, false);
});

test('recordDeactivated: always writes <resource>.deactivated with target_* only', async () => {
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  await recordDeactivated({ userId: 'u1' }, { resource: 'class', targetId: 'id1', targetLabel: 'Cardiology 101' });
  assert.equal(saved.action, 'class.deactivated');
  assert.equal(saved.target_type, 'class');
  assert.equal(saved.target_id, 'id1');
  assert.equal(saved.target_label, 'Cardiology 101');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

// ============================ redact (addendum C) ============================
// Pattern-based, not the brief's exact SECRET_KEYS set — must also catch this
// codebase's real secret-shaped keys.

test('redact: passwordHash is redacted (not in the brief\'s exact SECRET_KEYS set)', () => {
  assert.deepEqual(redact({ passwordHash: 'x' }), { passwordHash: '[redacted]' });
});

test('redact: openai_api_key is redacted', () => {
  assert.deepEqual(redact({ openai_api_key: 'sk-x' }), { openai_api_key: '[redacted]' });
});

test('redact: a nested resetToken is redacted', () => {
  assert.deepEqual(redact({ nested: { resetToken: 'x' } }), { nested: { resetToken: '[redacted]' } });
});

test('redact: zoom_start_url is redacted (start_url pattern)', () => {
  assert.deepEqual(redact({ zoom_start_url: 'https://zoom.example/start?x=y' }), { zoom_start_url: '[redacted]' });
});

test('redact: an array of objects with secret-shaped keys is redacted element-wise', () => {
  const out = redact([{ passwordHash: 'x' }, { safe: 'y', apiKey: 'z' }]);
  assert.deepEqual(out, [{ passwordHash: '[redacted]' }, { safe: 'y', apiKey: '[redacted]' }]);
});

// Fix round 1, Important 1: a Mongoose document/subdocument (or any class
// instance exposing `toObject`) found NESTED inside before/after must be
// walked and redacted by key, not returned verbatim — testsController.js
// already passes a live Mongoose doc as `after` into recordActiveStateChange.
test('redact: a nested value with a toObject() method (a Mongoose-doc shape) is walked and redacted', () => {
  const fakeMongooseDoc = {
    passwordHash: 'SEC1',
    toObject() { return { passwordHash: this.passwordHash, safe: 'ok' }; },
  };
  const out = redact({ doc: fakeMongooseDoc });
  assert.deepEqual(out, { doc: { passwordHash: '[redacted]', safe: 'ok' } });
});

test('redact: a top-level value with a toObject() method is walked and redacted', () => {
  const fakeMongooseDoc = {
    passwordHash: 'SEC1',
    toObject() { return { passwordHash: this.passwordHash }; },
  };
  assert.deepEqual(redact(fakeMongooseDoc), { passwordHash: '[redacted]' });
});

test('redact: a Date value survives unchanged (not turned into {})', () => {
  const date = new Date('2026-01-01T00:00:00.000Z');
  const out = redact({ created_date: date });
  assert.equal(out.created_date, date);
  assert.ok(out.created_date instanceof Date);
});

test('redact: an ObjectId-like value survives unchanged', () => {
  const id = oid();
  const out = redact({ target_id: id });
  assert.equal(out.target_id, id);
});

test('redact: password_changed is a deliberate boolean flag, not a secret — it survives even though its name contains "pass"', () => {
  assert.deepEqual(redact({ password_changed: true }), { password_changed: true });
});

test('redact: non-secret keys and nested plain objects pass through untouched', () => {
  assert.deepEqual(redact({ name: 'teacher', nested: { count: 3 } }), { name: 'teacher', nested: { count: 3 } });
});

// ========================= auditLogController.listAuditLog =========================

function controller() { return createAuditLogController(); }

test('listAuditLog: limit=5000 is capped to 200', async () => {
  let capturedLimit;
  stub(AuditLog, 'find', () => ({
    sort: () => ({
      skip: () => ({
        limit: (n) => { capturedLimit = n; return { lean: async () => [] }; },
      }),
    }),
  }));
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { limit: '5000' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(capturedLimit, 200);
  assert.equal(res.body.limit, 200);
});

test('listAuditLog: default limit is 50 and default page is 1 when not provided', async () => {
  stub(AuditLog, 'find', () => ({
    sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }),
  }));
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: {} }, res);
  assert.equal(res.body.limit, 50);
  assert.equal(res.body.page, 1);
});

test('listAuditLog: non-numeric limit/page fall back to the defaults', async () => {
  stub(AuditLog, 'find', () => ({
    sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }),
  }));
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { limit: 'abc', page: 'xyz' } }, res);
  assert.equal(res.body.limit, 50);
  assert.equal(res.body.page, 1);
});

// Fix round 1, Minor 6: `parseInt('5abc', 10)` is 5 — a PARTIAL number must
// still fall back to the default (addendum E: "non-numeric values fall back
// to the defaults"), not silently truncate to its leading digits.
test('listAuditLog: a partial-number limit like "5abc" falls back to the default (50), not its leading digits', async () => {
  stub(AuditLog, 'find', () => ({
    sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }),
  }));
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { limit: '5abc' } }, res);
  assert.equal(res.body.limit, 50);
});

// Fix round 1, Minor 4: limit/page floors, plus the computed skip.
test('listAuditLog: limit=0 floors to 1 (not the default), and page=0 floors to 1', async () => {
  let capturedLimit; let capturedSkip;
  stub(AuditLog, 'find', () => ({
    sort: () => ({
      skip: (n) => { capturedSkip = n; return { limit: (m) => { capturedLimit = m; return { lean: async () => [] }; } }; },
    }),
  }));
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { limit: '0', page: '0' } }, res);
  assert.equal(res.body.limit, 1);
  assert.equal(res.body.page, 1);
  assert.equal(capturedLimit, 1);
  assert.equal(capturedSkip, 0, 'skip = (page-1)*limit = (1-1)*1 = 0');
});

test('listAuditLog: page=3 with limit=10 computes skip=20', async () => {
  let capturedSkip;
  stub(AuditLog, 'find', () => ({
    sort: () => ({
      skip: (n) => { capturedSkip = n; return { limit: () => ({ lean: async () => [] }) }; },
    }),
  }));
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { limit: '10', page: '3' } }, res);
  assert.equal(capturedSkip, 20);
});

test('listAuditLog: from/to build a created_date range filter (plain from/to, not date-only)', async () => {
  let capturedFilter;
  stub(AuditLog, 'find', (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) };
  });
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-15T12:00:00.000Z' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(capturedFilter.created_date.$gte instanceof Date);
  assert.ok(capturedFilter.created_date.$lte instanceof Date);
  assert.equal(capturedFilter.created_date.$lt, undefined);
});

test('listAuditLog: a date-only `to` (from a date input) is inclusive of the whole day', async () => {
  let capturedFilter;
  stub(AuditLog, 'find', (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) };
  });
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { to: '2026-09-21' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(capturedFilter.created_date.$lte, undefined);
  assert.equal(capturedFilter.created_date.$lt.toISOString(), '2026-09-22T00:00:00.000Z');
});

test('listAuditLog: invalid dates are ignored, not a 500', async () => {
  stub(AuditLog, 'find', () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }));
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { from: 'not-a-date', to: 'also-not-a-date' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('listAuditLog: action must be a string — a query-object injection like action[$ne]=x is ignored', async () => {
  let capturedFilter;
  stub(AuditLog, 'find', (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) };
  });
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { action: { $ne: 'x' } } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(Object.prototype.hasOwnProperty.call(capturedFilter, 'action'), false);
});

test('listAuditLog: actor_id must be a valid ObjectId string — an invalid one is ignored', async () => {
  let capturedFilter;
  stub(AuditLog, 'find', (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) };
  });
  stub(AuditLog, 'countDocuments', async () => 0);
  const res = mockRes();
  await controller().listAuditLog({ query: { actor_id: 'not-an-id' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(Object.prototype.hasOwnProperty.call(capturedFilter, 'actor_id'), false);
});

test('listAuditLog: response shape is { entries, total, page, limit }', async () => {
  const entry = { _id: oid(), created_date: new Date(), actor_name: 'Asha', action: 'role.updated', target_type: 'role', target_label: 'teacher', before: null, after: { permissions: [] } };
  stub(AuditLog, 'find', () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [entry] }) }) }) }));
  stub(AuditLog, 'countDocuments', async () => 1);
  const res = mockRes();
  await controller().listAuditLog({ query: {} }, res);
  assert.deepEqual(res.body, { entries: [entry], total: 1, page: 1, limit: 50 });
});
