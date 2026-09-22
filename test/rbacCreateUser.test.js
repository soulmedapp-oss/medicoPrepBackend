// Controller-level tests (Task 10) for POST /users: `roles` replaces the old
// per-user `permissions` field (addendum E) and is subject to the same
// no-escalation gate as PUT /users/:id/roles, applied to a brand-new user
// with no existing roles (addendum B.4).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Role = require('../src/models/Role');
const AuditLog = require('../src/models/AuditLog');

const { createUsersController } = require('../src/controllers/usersController');
const { ALL_CODES } = require('../src/rbac/permissions');

const oid = () => new mongoose.Types.ObjectId();

function q(value) {
  const chain = {
    sort: () => chain,
    limit: () => chain,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

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
// Task 11: recordAudit is now wired into createUser. Default it to a silent
// no-op so pre-existing tests don't hit the real model.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

const admin = () => ({ _id: oid(), effective_permissions: [...ALL_CODES], role_names: ['admin'] });
const holder = (codes) => ({ _id: oid(), effective_permissions: codes, role_names: [] });

function usersController() { return createUsersController(); }

function baseBody(extra) {
  return { email: 'new@x.com', full_name: 'New Person', ...extra };
}

test('createUser: no roles given defaults to student', async () => {
  stub(User, 'findOne', () => q(null));
  let written = null;
  stub(User, 'create', async (doc) => { written = doc; return { ...doc, _id: oid(), toObject() { return { ...doc }; } }; });
  const res = mockRes();
  await usersController().createUser({ user: admin(), body: baseBody() }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(written.roles, ['student']);
  assert.equal(written.role, 'student');
  assert.equal(written.is_teacher, false);
});

test('createUser: explicit roles set role (primaryRole) and is_teacher', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: [] }]));
  let written = null;
  stub(User, 'create', async (doc) => { written = doc; return { ...doc, _id: oid(), toObject() { return { ...doc }; } }; });
  const res = mockRes();
  await usersController().createUser({ user: admin(), body: baseBody({ roles: ['teacher'] }) }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(written.roles, ['teacher']);
  assert.equal(written.role, 'teacher');
  assert.equal(written.is_teacher, true);
});

test('createUser: a permissions key in the body is ignored (E), nothing is written to it', async () => {
  stub(User, 'findOne', () => q(null));
  let written = null;
  stub(User, 'create', async (doc) => { written = doc; return { ...doc, _id: oid(), toObject() { return { ...doc }; } }; });
  const res = mockRes();
  await usersController().createUser({ user: admin(), body: baseBody({ permissions: ['CanEditTests'] }) }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'permissions'), false, 'permissions must not be set from the request body');
});

test('createUser: an unknown role name is rejected 400, nothing written', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([]));
  let created = false;
  stub(User, 'create', async () => { created = true; return {}; });
  const res = mockRes();
  await usersController().createUser({ user: admin(), body: baseBody({ roles: ['ghost'] }) }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Unknown or inactive role(s): ghost' });
  assert.equal(created, false, 'nothing must be written on a refusal');
});

// --- Escalation (B.4) ---

test('createUser escalation: a non-admin holding CanAddUsers + CanViewTests can create a user with a role containing only CanViewTests', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([{ name: 'reviewer', is_active: true, permissions: ['CanViewTests'] }]));
  stub(User, 'create', async (doc) => ({ ...doc, _id: oid(), toObject() { return { ...doc }; } }));
  const res = mockRes();
  await usersController().createUser({
    user: holder(['CanAddUsers', 'CanViewTests']), body: baseBody({ roles: ['reviewer'] }),
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

test('createUser escalation: a non-admin holding CanAddUsers + CanViewTests cannot create a user with a role containing CanEditTests, nothing written', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([{ name: 'editor', is_active: true, permissions: ['CanViewTests', 'CanEditTests'] }]));
  let created = false;
  stub(User, 'create', async () => { created = true; return {}; });
  const res = mockRes();
  await usersController().createUser({
    user: holder(['CanAddUsers', 'CanViewTests']), body: baseBody({ roles: ['editor'] }),
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.required, ['CanEditTests']);
  assert.equal(created, false, 'nothing must be written on a refusal');
});

test('createUser escalation: a non-admin holding CanAddUsers + CanViewTests cannot create an admin, nothing written', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([{ name: 'admin', is_active: true, is_system: true, permissions: [] }]));
  let created = false;
  stub(User, 'create', async () => { created = true; return {}; });
  const res = mockRes();
  await usersController().createUser({
    user: holder(['CanAddUsers', 'CanViewTests']), body: baseBody({ roles: ['admin'] }),
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(created, false, 'nothing must be written on a refusal');
});

// Fix round 1, Finding 9 (CRITICAL): a non-admin whose stubbed role carries
// EVERY permission code must still be refused creating an admin — identity,
// not coverage.
test('createUser escalation (fix round 1, Finding 9): a non-admin holding EVERY permission code cannot create an admin, nothing written', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([{ name: 'admin', is_active: true, is_system: true, permissions: [] }]));
  let created = false;
  stub(User, 'create', async () => { created = true; return {}; });
  const res = mockRes();
  await usersController().createUser({
    user: holder([...ALL_CODES]), body: baseBody({ roles: ['admin'] }),
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Only an admin can add or remove the admin role.', required: [] });
  assert.equal(created, false, 'full permission coverage must not substitute for actually being an admin');
});

test('createUser escalation: an admin can create a user with any role, including admin', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([{ name: 'admin', is_active: true, is_system: true, permissions: [] }]));
  stub(User, 'create', async (doc) => ({ ...doc, _id: oid(), toObject() { return { ...doc }; } }));
  const res = mockRes();
  await usersController().createUser({ user: admin(), body: baseBody({ roles: ['admin'] }) }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

// --- audit log (Task 11) ---

test('createUser: a successful create writes user.created with after: { email, full_name, roles }', async () => {
  stub(User, 'findOne', () => q(null));
  stub(User, 'create', async (doc) => ({ ...doc, _id: oid(), toObject() { return { ...doc }; } }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await usersController().createUser({ user: admin(), userId: 'admin-1', body: baseBody() }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'user.created');
  assert.deepEqual(saved.after, { email: 'new@x.com', full_name: 'New Person', roles: ['student'] });
});

test('createUser: a refused create (unknown role) writes nothing to the audit log', async () => {
  stub(User, 'findOne', () => q(null));
  stub(Role, 'find', () => q([]));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await usersController().createUser({ user: admin(), body: baseBody({ roles: ['ghost'] }) }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});
