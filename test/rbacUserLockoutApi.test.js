// Controller-level tests (Task 10) for lock-out on every user-deactivation
// path (spec 6.3 rules 3-4, addendum A: DELETE /users/:id and PATCH
// /users/:id with is_active:false), plus the addendum J fix (updateUser must
// check permissions against what is actually WRITTEN, not the raw body).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');

const { createUsersController } = require('../src/controllers/usersController');

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
// Task 11: recordAudit is now wired into updateUser/deleteUser. Default it to
// a silent no-op so pre-existing tests don't hit the real model.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

function usersController() { return createUsersController(); }

function targetUserDoc(fields) {
  const doc = {
    _id: oid(), roles: [], role: 'student', is_teacher: false, is_active: true, admin_status: 'active',
    toObject() { const { save, toObject: _t, ...rest } = this; return rest; },
    async save() { return this; },
    ...fields,
  };
  return doc;
}

const deactivator = (extra) => ({ _id: oid(), effective_permissions: ['CanDeactivateUsers'], ...extra });
const editor = (extra) => ({ _id: oid(), effective_permissions: ['CanEditUsers'], ...extra });

// --- DELETE /users/:id (addendum A) ---

test('deleteUser: the last active admin cannot be deactivated, 409, nothing saved', async () => {
  const target = targetUserDoc({ roles: ['admin'], role: 'admin' });
  stub(User, 'findById', async () => target);
  stub(User, 'countDocuments', async () => 1);
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().deleteUser({ params: { id: String(target._id) }, user: deactivator() }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /last active admin/i);
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

test('deleteUser: a caller cannot deactivate their own account, 409, nothing saved', async () => {
  const actor = deactivator();
  const target = targetUserDoc({ _id: actor._id, roles: ['teacher'], role: 'teacher' });
  stub(User, 'findById', async () => target);
  stub(User, 'countDocuments', async () => 5);
  let saved = false;
  target.save = async function save() { saved = true; return this; };
  const res = mockRes();
  await usersController().deleteUser({ params: { id: String(target._id) }, user: actor }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /own account/i);
  assert.equal(saved, false, 'nothing must be saved on a refusal');
});

test('deleteUser: deactivating a non-admin, non-self user succeeds', async () => {
  const target = targetUserDoc({ roles: ['teacher'], role: 'teacher' });
  stub(User, 'findById', async () => target);
  stub(User, 'countDocuments', async () => 5);
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await usersController().deleteUser({ params: { id: String(target._id) }, user: deactivator() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(target.is_active, false);
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'user.deactivated');
  assert.equal(saved.target_type, 'user');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

// --- PATCH /users/:id with is_active:false (addendum A) ---

test('updateUser: deactivating the last active admin through PATCH is refused 409, nothing saved', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, roles: ['admin'], role: 'admin', full_name: 'X' }));
  stub(User, 'countDocuments', async () => 1);
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivator(), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /last active admin/i);
  assert.equal(updateCalled, false, 'nothing must be written on a refusal');
});

test('updateUser: a caller cannot deactivate their own account through PATCH, 409, nothing saved', async () => {
  const id = oid();
  const actor = deactivator({ _id: id });
  stub(User, 'findById', () => q({ _id: id, is_active: true, roles: ['teacher'], role: 'teacher', full_name: 'X' }));
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: actor, body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /own account/i);
  assert.equal(updateCalled, false, 'nothing must be written on a refusal');
});

test('updateUser: deactivating a non-admin, non-self user through PATCH succeeds', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, roles: ['teacher'], role: 'teacher', full_name: 'X' }));
  stub(User, 'countDocuments', async () => 5);
  stub(User, 'findByIdAndUpdate', () => q({ _id: id, is_active: false, full_name: 'X', toObject() { return this; } }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivator(), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'user.deactivated');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

// --- addendum J: check what is WRITTEN, not the raw body ---

test('updateUser (J): a Deactivate-only caller sending { is_active: false, role: "admin" } is allowed, and nothing with a `role` key is written', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, roles: ['teacher'], role: 'teacher', full_name: 'X' }));
  stub(User, 'countDocuments', async () => 5);
  let written = null;
  stub(User, 'findByIdAndUpdate', (updateId, updateOps) => { written = updateOps.$set; return q({ _id: id, is_active: false, toObject() { return this; } }); });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivator(), body: { is_active: false, role: 'admin' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'role'), false, 'the role key must be dropped, never written');
});

test('updateUser (J): a Deactivate-only caller sending { is_active: false, password: "newpassword" } is still refused (password IS actually written), nothing saved', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, roles: ['teacher'], role: 'teacher', full_name: 'X' }));
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivator(), body: { is_active: false, password: 'newpassword' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditUsers'] });
  assert.equal(updateCalled, false, 'nothing must be written when permission is denied');
});

// --- audit log (Task 11) ---

test('updateUser: an ordinary field edit writes user.updated with before/after limited to the changed field', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, full_name: 'Old', roles: [] }));
  stub(User, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, full_name: 'New', toObject() { return this; } }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: editor(), body: { full_name: 'New' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'user.updated');
  assert.deepEqual(saved.before, { full_name: 'Old' });
  assert.deepEqual(saved.after, { full_name: 'New' });
});

test('updateUser: a password change writes user.updated with after: { password_changed: true }, never the password itself', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, full_name: 'X', roles: [] }));
  stub(User, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, full_name: 'X', toObject() { return this; } }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: editor(), body: { password: 'newpassword' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'user.updated');
  assert.equal(saved.after.password_changed, true);
  assert.equal(JSON.stringify(saved).toLowerCase().includes('newpassword'), false, 'the password value must never reach the audit log');
});

test('updateUser: a refused update writes nothing to the audit log', async () => {
  const id = oid();
  stub(User, 'findById', () => q({ _id: id, is_active: true, full_name: 'X', roles: ['teacher'], role: 'teacher' }));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await usersController().updateUser({
    params: { id: String(id) }, user: deactivator(), body: { is_active: false, password: 'newpassword' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});
