// Controller-level tests (Task 10) for the roles/users/permissions endpoints:
// permission-code validation, role name normalization + rename cascade (spec
// 6.5), lock-out rules on every deactivation path (spec 6.3, addendum A), and
// no-privilege-escalation (spec 6.4, addendum B). Style: test/testsAttempts.test.js
// / test/rbacUpdateDeactivate.test.js (stubbed Mongoose statics, allow AND
// deny, assertions on what was written and that NOTHING was written on a
// refusal).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Role = require('../src/models/Role');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');

const { createRolesController } = require('../src/controllers/rolesController');
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
// Task 11, addendum D: recordAudit is now wired into every write handler
// below. Default it to a silent no-op so every EXISTING test in this file
// (which doesn't know about auditing) doesn't hit the real model and print
// "Failed to write audit log entry" — tests that care override this stub
// themselves to capture what was written.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

const holder = (codes, extra = {}) => ({ _id: oid(), effective_permissions: codes, role_names: [], ...extra });
// A real admin's effective_permissions is ALL_CODES (resolvePermissions.js
// returns every code for the admin role), which is what production's
// loadPermissions() actually puts on req.user.
const admin = () => ({ _id: oid(), effective_permissions: [...ALL_CODES], role_names: ['admin'] });

function rolesController() { return createRolesController(); }

// ============================= rolesController =============================

// --- createRole ---

test('createRole: unknown permission code is rejected with a 400 naming it', async () => {
  const res = mockRes();
  let created = false;
  stub(Role, 'create', async () => { created = true; return {}; });
  await rolesController().createRole({
    user: admin(),
    body: { name: 'Reviewer', permissions: ['CanViewTests', 'nope'] },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Unknown permission code(s): nope' });
  assert.equal(created, false, 'nothing must be written on a refusal');
});

// Fix round 1, Finding 6: the 2..40 length check must run on the TRIMMED
// value — `" a "` is 3 characters untrimmed but a 1-character name once
// trimmed, and that is what actually gets stored.
test('createRole (fix round 1, Finding 6): a name that is too short once trimmed is rejected 400, nothing written', async () => {
  let created = false;
  stub(Role, 'create', async () => { created = true; return {}; });
  const res = mockRes();
  await rolesController().createRole({ user: admin(), body: { name: ' a ', permissions: [] } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'name must be between 2 and 40 characters' });
  assert.equal(created, false, 'nothing must be written on a refusal');
});

test('createRole: name is stored trimmed and lower-cased (spec 6.5)', async () => {
  const res = mockRes();
  let written = null;
  stub(Role, 'create', async (doc) => { written = doc; return { ...doc, _id: oid() }; });
  await rolesController().createRole({
    user: admin(),
    body: { name: '  Class Manager  ', permissions: [] },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(written.name, 'class manager');
});

// Fix round 1, Finding 7: reserved names — checked explicitly so the defence
// does not depend on the admin/student Role document existing in the DB.
test('createRole (fix round 1, Finding 7): creating a role named "admin" (any case/whitespace) is refused 409, nothing written', async () => {
  let created = false;
  stub(Role, 'create', async () => { created = true; return {}; });
  const res = mockRes();
  await rolesController().createRole({ user: admin(), body: { name: '  Admin  ', permissions: [] } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /reserved role name/);
  assert.equal(created, false, 'nothing must be written on a refusal');
});

test('createRole (fix round 1, Finding 7): creating a role named "student" is refused 409, nothing written', async () => {
  let created = false;
  stub(Role, 'create', async () => { created = true; return {}; });
  const res = mockRes();
  await rolesController().createRole({ user: admin(), body: { name: 'STUDENT', permissions: [] } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /reserved role name/);
  assert.equal(created, false, 'nothing must be written on a refusal');
});

test('createRole escalation (B.3): a non-admin holding CanAddRoles + CanViewTests can create a role with only CanViewTests', async () => {
  const res = mockRes();
  let written = null;
  stub(Role, 'create', async (doc) => { written = doc; return { ...doc, _id: oid() }; });
  await rolesController().createRole({
    user: holder(['CanAddRoles', 'CanViewTests']),
    body: { name: 'reviewer', permissions: ['CanViewTests'] },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(written);
});

test('createRole escalation (B.3): a non-admin holding CanAddRoles + CanViewTests cannot create a role with CanEditTests, nothing written', async () => {
  const res = mockRes();
  let created = false;
  stub(Role, 'create', async () => { created = true; return {}; });
  await rolesController().createRole({
    user: holder(['CanAddRoles', 'CanViewTests']),
    body: { name: 'editor', permissions: ['CanViewTests', 'CanEditTests'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.length > 0, true);
  assert.deepEqual(res.body.required, ['CanEditTests']);
  assert.equal(created, false, 'nothing must be written on a refusal');
});

test('createRole: an admin can create a role with any permissions', async () => {
  const res = mockRes();
  stub(Role, 'create', async (doc) => ({ ...doc, _id: oid() }));
  await rolesController().createRole({
    user: admin(),
    body: { name: 'super', permissions: ['CanEditTests', 'CanDeactivateTests'] },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

// Pre-review correction, item (d): createRole only ever writes name,
// description, permissions — a client-supplied `is_system` (or any other
// field) must never reach Role.create.
test('createRole (pre-review correction): a client-supplied is_system is never written; a new role is always active and non-system', async () => {
  const res = mockRes();
  let written = null;
  stub(Role, 'create', async (doc) => { written = doc; return { ...doc, _id: oid() }; });
  await rolesController().createRole({
    user: admin(),
    body: { name: 'super', is_system: true, permissions: [] },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'is_system'), false, 'is_system must not be client-writable');
});

// --- updateRole ---

// Fix round 1, Finding 6: same TRIMMED-length bug on the update path.
test('updateRole (fix round 1, Finding 6): a name that is too short once trimmed is rejected 400, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { name: ' a ' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'name must be between 2 and 40 characters' });
  assert.equal(updateCalled, false, 'nothing must be written on a refusal');
});

test('updateRole: renaming the admin role is refused with 409, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'admin', is_system: true, permissions: [], is_active: true }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, name: 'root' }); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { name: 'root' },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /built in/);
  assert.equal(updateCalled, false, 'nothing must be written when the rename is refused');
});

test('updateRole: renaming to a name already used by another role is a 409, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(Role, 'findOne', () => q({ _id: oid(), name: 'editor' }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: id, name: 'editor' }); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { name: 'Editor' },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(updateCalled, false, 'nothing must be written when the name collides');
});

// Fix round 1, Finding 7: renaming a NON-system role TO a reserved name must
// be refused even if the admin/student Role document is somehow missing —
// so the check must not rely on the collision query finding it.
test('updateRole (fix round 1, Finding 7): renaming an ordinary role to "admin" is refused 409, nothing written, even if no admin Role document exists to collide with', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(Role, 'findOne', () => q(null)); // simulates no admin document to collide with
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  let updateManyCalled = false;
  stub(User, 'updateMany', async () => { updateManyCalled = true; return { acknowledged: true }; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { name: 'Admin' },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /reserved role name/);
  assert.equal(updateCalled, false, 'nothing must be written on a refusal');
  assert.equal(updateManyCalled, false, 'no cascade when the rename itself is refused');
});

test('updateRole (fix round 1, Finding 7): renaming a role to its OWN current reserved name is still allowed (a no-op rename)', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'admin', is_system: true, permissions: [], is_active: true }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'admin', description: 'updated' }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { name: 'admin', description: 'updated' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('updateRole: a successful rename cascades to every user holding the old role name', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(Role, 'findOne', () => q(null));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'qa' }));
  const updateManyCalls = [];
  stub(User, 'updateMany', async (filter, update, options) => { updateManyCalls.push({ filter, update, options }); return { acknowledged: true }; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { name: '  QA  ' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(updateManyCalls.length, 2, 'both the roles array and the primary role field are cascaded');
  const rolesCascade = updateManyCalls.find((c) => c.filter.roles === 'reviewer');
  const primaryCascade = updateManyCalls.find((c) => c.filter.role === 'reviewer');
  assert.ok(rolesCascade, 'updates users whose roles array holds the old name');
  assert.ok(primaryCascade, 'updates users whose primary role field holds the old name');
});

// Pre-review correction: THE HOLE — updateRole wrote the raw body, so a
// CanEditRoles (non-admin) holder could send `is_system:false` on the admin
// role (escalation only gates ADDED permissions, so this passed) and then
// rename it in a second request (checkRoleRename now saw is_system:false and
// let it through), and the rename cascade would strip `admin` off every
// admin user. Items (b) and (c) below prove both halves are closed: the flag
// is never written, and even a role whose is_system happens to be false is
// still protected by name (isSystemRole's defence in depth, see rbacLockout).

// Fix round 1, Finding 8: a PATCH whose only key is non-whitelisted (so the
// filtered `updates` is empty) used to answer 200 with an empty write —
// technically harmless (nothing was written) but told the caller their
// change succeeded when it did not. Updated from the pre-review correction's
// original version (which asserted 200) to assert the new 400, per the fix
// brief's explicit instruction to update this test and say so in the report.
test('updateRole (pre-review correction b / fix round 1, Finding 8): a non-admin CanEditRoles holder sending only is_system:false gets 400 "nothing to update", and nothing is written', async () => {
  const id = oid();
  const stored = { _id: id, name: 'admin', is_system: true, permissions: [], is_active: true };
  stub(Role, 'findById', () => q(stored));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles']), body: { is_system: false },
  }, res);
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'Nothing to update. Editable fields: name, description, permissions, is_active.' });
  assert.equal(updateCalled, false, 'is_system must never reach the write, and an empty write must not happen at all');
});

test('updateRole (fix round 1, Finding 8): an empty body gets 400 "nothing to update", nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: oid(), name: 'reviewer', permissions: [], is_active: true }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({ params: { id: String(id) }, user: admin(), body: {} }, res);
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'Nothing to update. Editable fields: name, description, permissions, is_active.' });
  assert.equal(updateCalled, false);
});

test('updateRole (pre-review correction c): renaming the admin role is still refused 409 even if is_system is already false on the stored document, and no cascade runs', async () => {
  const id = oid();
  // Simulates a document whose flag is missing/false (untouched by this
  // request) — isSystemRole's name-based fallback must still catch it.
  stub(Role, 'findById', () => q({ _id: id, name: 'admin', is_system: false, permissions: [], is_active: true }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  let updateManyCalled = false;
  stub(User, 'updateMany', async () => { updateManyCalled = true; return { acknowledged: true }; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles']), body: { name: 'renamed' },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(updateCalled, false, 'nothing must be written when the rename is refused');
  assert.equal(updateManyCalled, false, 'the rename cascade must never run when the rename itself is refused');
});

test('updateRole (pre-review correction e): a stray key is accepted alongside a legitimate field, and only the legitimate field is written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', is_system: false, permissions: [], is_active: true }));
  let written = null;
  stub(Role, 'findByIdAndUpdate', (roleId, update) => { written = update.$set; return q({ _id: id, name: 'reviewer', description: 'd' }); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { description: 'd', foo: 1 },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(written.description, 'd');
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'foo'), false, 'an unrecognized key must never be written');
});

test('updateRole escalation (B.3): a non-admin holding CanEditRoles + CanViewTests can add CanViewTests to a role', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'reviewer', permissions: ['CanViewTests'] }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles', 'CanViewTests']), body: { permissions: ['CanViewTests'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('updateRole escalation (B.3): a non-admin holding CanEditRoles + CanViewTests cannot add CanEditTests, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: ['CanViewTests'], is_active: true }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles', 'CanViewTests']), body: { permissions: ['CanViewTests', 'CanEditTests'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.required, ['CanEditTests']);
  assert.equal(updateCalled, false, 'nothing must be written on a refusal');
});

test('updateRole escalation (B.3): removing permissions is always allowed, even ones the actor does not hold', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: ['CanViewTests', 'CanEditTests'], is_active: true }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'reviewer', permissions: [] }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles']), body: { permissions: [] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, Finding 1 (Important): reactivating an INACTIVE role re-grants
// its whole permission list to every holder (an inactive role contributes
// nothing per resolvePermissions.js), so it must be gated by rule 3 just like
// adding those same codes directly — even though the body carries no
// `permissions` key at all.
test('updateRole (fix round 1, Finding 1): a non-admin can reactivate an inactive role whose stored permissions are within their own', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'auditor', permissions: ['CanViewTests'], is_active: false }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'auditor', permissions: ['CanViewTests'], is_active: true }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) },
    user: holder(['CanEditRoles', 'CanDeactivateRoles', 'CanViewTests']),
    body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('updateRole (fix round 1, Finding 1): a non-admin cannot reactivate an inactive role whose stored permissions they do not hold, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'auditor', permissions: ['CanEditSettings'], is_active: false }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) },
    user: holder(['CanEditRoles', 'CanDeactivateRoles', 'CanViewTests']),
    body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.required, ['CanEditSettings']);
  assert.equal(updateCalled, false, 'nothing must be written on a refusal');
});

test('updateRole (fix round 1, Finding 1): an admin can reactivate any inactive role', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'auditor', permissions: ['CanEditSettings'], is_active: false }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'auditor', permissions: ['CanEditSettings'], is_active: true }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Final review fix round 1, Critical: the reactivation escalation gate
// (`reactivates`) must fail CLOSED on a non-boolean is_active value.
// Mongoose still casts "true"/1/"1"/"yes" to the boolean `true` on write, so
// a CanDeactivateRoles-only actor (missingUpdatePermissions only demands
// CanDeactivateRoles for ANY value shape that touches is_active) must not be
// able to skip the no-escalation gate simply by sending a non-boolean value.
[['the string "true"', 'true'], ['the number 1', 1], ['the string "1"', '1'], ['the string "yes"', 'yes']].forEach(
  ([label, value]) => {
    test(`updateRole (final review fix round 1, Critical): a CanDeactivateRoles-only actor cannot reactivate via is_active: ${label} (non-boolean), nothing written`, async () => {
      const id = oid();
      stub(Role, 'findById', () => q({ _id: id, name: 'auditor', permissions: ['CanEditSettings'], is_active: false }));
      let updateCalled = false;
      stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
      const res = mockRes();
      await rolesController().updateRole({
        params: { id: String(id) },
        user: holder(['CanDeactivateRoles']),
        body: { is_active: value },
      }, res);
      assert.equal(res.statusCode, 403, JSON.stringify(res.body));
      assert.deepEqual(res.body.required, ['CanEditSettings']);
      assert.equal(updateCalled, false, 'nothing must be written on a refusal');
    });
  }
);

test('updateRole (final review fix round 1, Critical): a legitimate reactivation with the real boolean true still enforces the escalation gate', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'auditor', permissions: ['CanEditSettings'], is_active: false }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) },
    user: holder(['CanDeactivateRoles']),
    body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.deepEqual(res.body.required, ['CanEditSettings']);
  assert.equal(updateCalled, false, 'nothing must be written on a refusal');
});

test('updateRole (final review fix round 1, Critical): an admin can still reactivate with any value shape (e.g. the string "true")', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'auditor', permissions: ['CanEditSettings'], is_active: false }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'auditor', permissions: ['CanEditSettings'], is_active: true }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { is_active: 'true' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// Fix round 1, Test gap (a) named in the review: only deleteRole had a
// system-role-deactivation test; PATCH /roles/:id { is_active: false } on a
// SYSTEM role needs its own, since it's a different code path.
test('updateRole (fix round 1, gap a): deactivating a SYSTEM role via PATCH is refused 409, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'admin', is_system: true, permissions: [], is_active: true }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /built in/);
  assert.equal(updateCalled, false, 'nothing must be written when the role is a system role');
});

test('updateRole: deactivating (is_active:false) a role still assigned to 2 active users is a 409, nothing written (addendum A)', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(User, 'countDocuments', async () => 2);
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /2 active user/);
  assert.equal(updateCalled, false, 'nothing must be written when the role is still assigned');
});

test('updateRole: deactivating a role with 0 active users succeeds', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(User, 'countDocuments', async () => 0);
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'reviewer', is_active: false }));
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// --- deleteRole ---

test('deleteRole: a role with 2 active users cannot be deactivated, 409, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', is_active: true, is_system: false }));
  stub(User, 'countDocuments', async () => 2);
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().deleteRole({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /2 active user/);
  assert.equal(updateCalled, false, 'nothing must be written when the role is still assigned');
});

test('deleteRole: a role with 0 active users is deactivated', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', is_active: true, is_system: false }));
  stub(User, 'countDocuments', async () => 0);
  let written = null;
  stub(Role, 'findByIdAndUpdate', (roleId, update) => { written = update.$set; return q({ _id: id, name: 'reviewer', is_active: false }); });
  const res = mockRes();
  await rolesController().deleteRole({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(written.is_active, false);
});

test('deleteRole: a system role cannot be deactivated, 409, nothing written', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'admin', is_active: true, is_system: true }));
  let updateCalled = false;
  stub(Role, 'findByIdAndUpdate', () => { updateCalled = true; return q({}); });
  const res = mockRes();
  await rolesController().deleteRole({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(updateCalled, false);
});

// Fix round 1, Finding 5: both deactivation guards must use isSystemRole(existing)
// — not the raw `is_system` flag — so a role named admin/student with a
// false/missing flag skips the active-user count query too (both places
// already refuse via isSystemRole downstream; this proves the count query
// itself is skipped, not just the outcome).
test('deleteRole (fix round 1, Finding 5): a role named "admin" with is_system false never queries the active-user count', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'admin', is_active: true, is_system: false }));
  let countCalled = false;
  stub(User, 'countDocuments', async () => { countCalled = true; return 0; });
  const res = mockRes();
  await rolesController().deleteRole({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(countCalled, false, 'isSystemRole must short-circuit before the count query, regardless of the flag');
});

test('updateRole (fix round 1, Finding 5): deactivating a role named "student" with is_system false never queries the active-user count', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'student', is_active: true, is_system: false, permissions: [] }));
  let countCalled = false;
  stub(User, 'countDocuments', async () => { countCalled = true; return 0; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(countCalled, false, 'isSystemRole must short-circuit before the count query, regardless of the flag');
});

// --- audit log (Task 11) ---

test('createRole: a successful create writes role.created with after: { name, permissions }', async () => {
  let saved;
  stub(Role, 'create', async (doc) => ({ ...doc, _id: oid() }));
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().createRole({
    user: admin(),
    userId: 'admin-1',
    body: { name: 'reviewer', permissions: ['CanViewTests'] },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'role.created');
  assert.deepEqual(saved.after, { name: 'reviewer', permissions: ['CanViewTests'] });
});

test('createRole: a refused create (unknown permission code) writes nothing to the audit log', async () => {
  let auditCalled = false;
  stub(Role, 'create', async () => ({}));
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await rolesController().createRole({ user: admin(), body: { name: 'reviewer', permissions: ['nope'] } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});

test('updateRole: renaming a role writes role.updated with before/after limited to { name }', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(Role, 'findOne', () => q(null));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'qa', permissions: [], is_active: true }));
  stub(User, 'updateMany', async () => ({ acknowledged: true }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { name: '  QA  ' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'role.updated');
  assert.deepEqual(saved.before, { name: 'reviewer' });
  assert.deepEqual(saved.after, { name: 'qa' });
});

test('updateRole: changing permissions writes role.updated with before/after limited to { permissions }', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'reviewer', permissions: ['CanViewTests'], is_active: true }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles', 'CanViewTests']), body: { permissions: ['CanViewTests'] },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'role.updated');
  assert.deepEqual(saved.before, { permissions: [] });
  assert.deepEqual(saved.after, { permissions: ['CanViewTests'] });
});

test('updateRole: deactivating (is_active:false) writes role.deactivated with target_* only, no before/after', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: true }));
  stub(User, 'countDocuments', async () => 0);
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'reviewer', permissions: [], is_active: false }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: admin(), body: { is_active: false },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'role.deactivated');
  assert.equal(saved.target_type, 'role');
  assert.equal(saved.target_id, String(id));
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

// Addendum A: roles have no "reactivated" action — reactivating through
// PATCH is just another role.updated.
test('updateRole: reactivating (is_active:false -> true) writes role.updated, not a "reactivated" action', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'auditor', permissions: ['CanViewTests'], is_active: false }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'auditor', permissions: ['CanViewTests'], is_active: true }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) },
    user: holder(['CanEditRoles', 'CanDeactivateRoles', 'CanViewTests']),
    body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'role.updated');
  assert.deepEqual(saved.before, { is_active: false });
  assert.deepEqual(saved.after, { is_active: true });
});

test('updateRole: a refused update (escalation) writes nothing to the audit log', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', permissions: ['CanViewTests'], is_active: true }));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles', 'CanViewTests']), body: { permissions: ['CanViewTests', 'CanEditTests'] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});

// Fix round 1, Important 2: addendum A says any other successful PATCH
// /roles/:id (rename or reactivation aside) is role.updated too — the
// "content edits are not audited" carve-out is for the seven generic
// resources only. A description-only change writes an entry even though
// name/permissions/is_active (the only tracked before/after keys) are
// unchanged (addendum B constrains WHAT goes in before/after, not whether
// the entry exists).
test('updateRole: a description-only change still writes role.updated (addendum A), even though it changes none of the tracked before/after keys', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', description: 'old', permissions: [], is_active: true }));
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'reviewer', description: 'new', permissions: [], is_active: true }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().updateRole({
    params: { id: String(id) }, user: holder(['CanEditRoles']), body: { description: 'new' },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on every successful PATCH /roles/:id');
  assert.equal(saved.action, 'role.updated');
  assert.deepEqual(saved.before, {});
  assert.deepEqual(saved.after, {});
});

test('deleteRole: a successful deactivation writes role.deactivated with target_* only', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', is_active: true, is_system: false }));
  stub(User, 'countDocuments', async () => 0);
  stub(Role, 'findByIdAndUpdate', () => q({ _id: id, name: 'reviewer', is_active: false }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await rolesController().deleteRole({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'role.deactivated');
  assert.equal(saved.target_type, 'role');
  assert.equal(saved.target_label, 'reviewer');
});

test('deleteRole: a refused deactivation (still assigned) writes nothing to the audit log', async () => {
  const id = oid();
  stub(Role, 'findById', () => q({ _id: id, name: 'reviewer', is_active: true, is_system: false }));
  stub(User, 'countDocuments', async () => 2);
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await rolesController().deleteRole({ params: { id: String(id) }, user: admin() }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(auditCalled, false, 'nothing must be written on a refusal');
});

// --- listRoles ---

// Fix round 1, Finding 2: user_count must mean the same thing as the 409
// deactivation message — both must count a legacy `role`-only holder (empty
// `roles` array), or the UI shows 0 while DELETE /roles/:id refuses with
// "assigned to 1 active user(s)", an error the admin cannot act on.
test('listRoles (fix round 1, Finding 2): user_count matches the deactivation count, including legacy role-only holders', async () => {
  const r1 = oid(); const r2 = oid();
  stub(Role, 'find', () => q([
    { _id: r1, name: 'teacher', is_active: true },
    { _id: r2, name: 'reviewer', is_active: true },
  ]));
  stub(User, 'countDocuments', async (filter) => {
    const name = filter.$or[0].roles;
    return name === 'reviewer' ? 1 : 0;
  });
  const res = mockRes();
  await rolesController().listRoles({ query: {}, user: admin() }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const teacher = res.body.roles.find((r) => r.name === 'teacher');
  const reviewer = res.body.roles.find((r) => r.name === 'reviewer');
  assert.equal(teacher.user_count, 0);
  assert.equal(reviewer.user_count, 1, 'a legacy role-only holder must count, matching DELETE /roles/:id');
});
