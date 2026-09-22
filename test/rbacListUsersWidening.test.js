// Controller-level tests (Task 10, addendum D) for GET /users: the "may see
// all users and full records" decision widens from `can(user, 'CanViewUsers')`
// to `canAny(user, ['CanViewUsers', 'CanAssignUserRoles'])`, since the User
// Roles page (guarded by CanAssignUserRoles alone) needs the full user list
// to assign roles to. A caller with neither still only gets the public
// teacher directory, and the 403 for asking for another role stays exactly
// `{ error: 'Permission denied', required: ['CanViewUsers'] }` (unchanged —
// see test/rbacWidenedViews.test.js line ~92 for the pre-existing version of
// that assertion, kept green by this change).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../src/models/User');
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

function usersController() { return createUsersController(); }

test('GET /users: a caller holding only CanAssignUserRoles (no CanViewUsers) gets the full directory (unscoped filter, full sanitized shape), not just teachers', async () => {
  let filterUsed = null;
  stub(User, 'find', (filter) => {
    filterUsed = filter;
    return q([
      { _id: oid(), full_name: 'Student One', role: 'student', is_active: true, passwordHash: 'x', toObject() { return this; } },
    ]);
  });
  const res = mockRes();
  await usersController().listUsers({
    query: {}, user: { _id: oid(), effective_permissions: ['CanAssignUserRoles'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(filterUsed, {}, 'not scoped to the teacher-only directory');
  // `is_active` is present on the FULL (sanitizeUser) shape and absent from
  // the public (sanitizePublicUser) shape — the one field that actually
  // distinguishes the two, since both include full_name and exclude
  // passwordHash.
  assert.equal(res.body.users[0].is_active, true, 'the FULL record, not the public teacher-directory shape');
});

test('GET /users: a caller holding neither CanViewUsers nor CanAssignUserRoles still only gets the public teacher directory', async () => {
  let filterUsed = null;
  stub(User, 'find', (filter) => { filterUsed = filter; return q([]); });
  const res = mockRes();
  await usersController().listUsers({
    query: {}, user: { _id: oid(), effective_permissions: [] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(filterUsed.$or, 'scoped to the teacher directory');
});

test('GET /users: a caller holding neither code asking for role=admin is still the standard 403 naming only CanViewUsers', async () => {
  const res = mockRes();
  await usersController().listUsers({
    query: { role: 'admin' }, user: { _id: oid(), effective_permissions: [] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanViewUsers'] });
});
