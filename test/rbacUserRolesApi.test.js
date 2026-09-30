// Controller-level tests (Task 10) for PUT /users/:id/roles: role-name
// validation, no-privilege-escalation (spec 6.4 rules 1 and 2, addendum B.1/
// B.2), and lock-out (spec 6.3 rules 3-5) on the same route (addendum A).
// Style: test/rbacUpdateDeactivate.test.js / test/rbacRolesApi.test.js.
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
// Task 11: recordAudit is now wired into setUserRoles. Default it to a
// silent no-op so pre-existing tests don't hit the real model.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

const admin = () => ({ _id: oid(), effective_permissions: [...ALL_CODES], role_names: ['admin'] });
const holder = (codes) => ({ _id: oid(), effective_permissions: codes, role_names: [] });

function usersController() { return createUsersController(); }

function targetUserDoc(fields) {
  const doc = {
    _id: oid(), roles: [], role: 'student', is_teacher: false, is_active: true,
    toObject() { const { save, toObject: _t, ...rest } = this; return rest; },
    async save() { return this; },
    ...fields,
  };
  return doc;
}

test('setUserRoles: an unknown role name is rejected 400, nothing saved', async () => {
  const target = targetUserDoc({ roles: ['teacher'] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: [] }]));
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: admin(), body: { roles: ['teacher', 'ghost'] },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Unknown or inactive role(s): ghost' });
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

// Fix round 1, Test gap (b) named in the review: every other stub ignores its
// filter argument, so nothing proves an INACTIVE role name is actually
// rejected by the is_active:true filter in the real Role.find query — as
// opposed to happening to be absent from a hand-picked stub list. This stub
// simulates a real query against a small "database" and only returns docs
// that satisfy BOTH the $in and the is_active filter.
test('setUserRoles (fix round 1, gap b): a role that EXISTS but is INACTIVE is rejected 400, via a Role.find stub that honours the is_active filter', async () => {
  const target = targetUserDoc({ roles: [] });
  stub(User, 'findById', async () => target);
  const database = [
    { name: 'teacher', is_active: true, permissions: [] },
    { name: 'ghost', is_active: false, permissions: [] },
  ];
  stub(Role, 'find', (query) => {
    const names = query.name.$in;
    const matches = database.filter((doc) => names.includes(doc.name) && doc.is_active === query.is_active);
    return q(matches);
  });
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: admin(), body: { roles: ['teacher', 'ghost'] },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Unknown or inactive role(s): ghost' });
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

test('setUserRoles: success sets roles, primary role and is_teacher, and responds with effective_permissions', async () => {
  const target = targetUserDoc({ roles: ['student'] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([
    { name: 'teacher', is_active: true, permissions: [] },
    { name: 'reviewer', is_active: true, permissions: ['CanViewTests'] },
  ]));
  stub(User, 'countDocuments', async () => 3);
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: admin(), body: { roles: ['teacher', 'reviewer'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(target.roles, ['teacher', 'reviewer']);
  assert.equal(target.role, 'teacher');
  assert.equal(target.is_teacher, true);
  // Fix round 1, Finding 14: assert the VALUE, not just the type — the stub
  // feeds Role.find the same docs for the validation query and the
  // loadPermissions() resolution, so the real resolved value is derivable.
  assert.deepEqual(res.body.user.effective_permissions, ['CanViewTests'], 'response carries effective_permissions (F: via loadPermissions)');
  // Task 11: user.roles_changed with before/after both { roles }.
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'user.roles_changed');
  assert.deepEqual(saved.before, { roles: ['student'] });
  assert.deepEqual(saved.after, { roles: ['teacher', 'reviewer'] });
});

test('setUserRoles: a refused change (unknown role) writes nothing to the audit log', async () => {
  const target = targetUserDoc({ roles: ['teacher'] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: [] }]));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: admin(), body: { roles: ['teacher', 'ghost'] },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});

test('setUserRoles: empty roles list falls back to student', async () => {
  const target = targetUserDoc({ roles: ['teacher'], role: 'teacher' });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([]));
  stub(User, 'countDocuments', async () => 3);
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: admin(), body: { roles: [] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(target.roles, ['student']);
  assert.equal(target.role, 'student');
});

test('setUserRoles: removing the last active admin is refused 409, nothing saved', async () => {
  const target = targetUserDoc({ roles: ['admin'], role: 'admin' });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: [] }]));
  stub(User, 'countDocuments', async () => 1);
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: admin(), body: { roles: ['teacher'] },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /last active admin/i);
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

// --- Escalation (B.1, B.2) ---

test('setUserRoles escalation: a non-admin holding CanAssignUserRoles + CanViewTests can grant a role containing only CanViewTests', async () => {
  const target = targetUserDoc({ roles: [] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'reviewer', is_active: true, permissions: ['CanViewTests'] }]));
  stub(User, 'countDocuments', async () => 3);
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: holder(['CanAssignUserRoles', 'CanViewTests']), body: { roles: ['reviewer'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('setUserRoles escalation: a non-admin holding CanAssignUserRoles + CanViewTests cannot grant a role containing CanEditTests, nothing saved', async () => {
  const target = targetUserDoc({ roles: [] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'editor', is_active: true, permissions: ['CanViewTests', 'CanEditTests'] }]));
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: holder(['CanAssignUserRoles', 'CanViewTests']), body: { roles: ['editor'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.required, ['CanEditTests']);
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

test('setUserRoles escalation: a non-admin holding CanAssignUserRoles + CanViewTests cannot add the admin role, nothing saved', async () => {
  const target = targetUserDoc({ roles: [] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'admin', is_active: true, is_system: true, permissions: [] }]));
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) },
    user: holder(['CanAssignUserRoles', 'CanViewTests']),
    body: { roles: ['admin'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

test('setUserRoles escalation: a non-admin holding CanAssignUserRoles + CanViewTests cannot remove the admin role from someone else, nothing saved', async () => {
  const target = targetUserDoc({ roles: ['admin'], role: 'admin' });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: [] }]));
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) },
    user: holder(['CanAssignUserRoles', 'CanViewTests']),
    body: { roles: ['teacher'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

// Fix round 1, Finding 9 (CRITICAL): a non-admin whose stubbed role carries
// EVERY permission code must still be refused adding/removing admin —
// identity, not coverage (spec 6.4 rule 2).
test('setUserRoles escalation (fix round 1, Finding 9): a non-admin holding EVERY permission code cannot add the admin role to themselves, nothing saved', async () => {
  const actor = holder([...ALL_CODES]);
  const target = targetUserDoc({ _id: actor._id, roles: [] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'admin', is_active: true, is_system: true, permissions: [] }]));
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: actor, body: { roles: ['admin'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Only an admin can add or remove the admin role.', required: [] });
  assert.equal(saved, false, 'full permission coverage must not substitute for actually being an admin');
});

test('setUserRoles escalation (fix round 1, Finding 9): a non-admin holding EVERY permission code cannot add the admin role to someone else, nothing saved', async () => {
  const target = targetUserDoc({ roles: [] });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'admin', is_active: true, is_system: true, permissions: [] }]));
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: holder([...ALL_CODES]), body: { roles: ['admin'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Only an admin can add or remove the admin role.', required: [] });
  assert.equal(saved, false);
});

test('setUserRoles escalation (fix round 1, Finding 9): a non-admin holding EVERY permission code cannot remove the admin role from someone else, nothing saved', async () => {
  const target = targetUserDoc({ roles: ['admin'], role: 'admin' });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: [] }]));
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: holder([...ALL_CODES]), body: { roles: ['teacher'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Only an admin can add or remove the admin role.', required: [] });
  assert.equal(saved, false);
});

test('setUserRoles escalation: an admin can grant or remove the admin role, and any permission combination', async () => {
  const target = targetUserDoc({ roles: ['admin'], role: 'admin' });
  stub(User, 'findById', async () => target);
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: [] }]));
  stub(User, 'countDocuments', async () => 3);
  const res = mockRes();
  await usersController().setUserRoles({
    params: { id: String(target._id) }, user: admin(), body: { roles: ['teacher'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});
