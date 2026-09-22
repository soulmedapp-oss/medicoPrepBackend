// test/rbacLockout.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRoleDeactivation, checkRoleRename, checkUserRolesChange, checkUserDeactivation, isSystemRole } = require('../src/rbac/lockout');

test('system roles cannot be deactivated or renamed', () => {
  assert.equal(checkRoleDeactivation({ role: { name: 'admin', is_system: true }, assignedActiveUsers: 0 }).ok, false);
  assert.equal(checkRoleDeactivation({ role: { name: 'student', is_system: true }, assignedActiveUsers: 0 }).ok, false);
  assert.equal(checkRoleRename({ role: { name: 'admin', is_system: true }, newName: 'root' }).ok, false);
  assert.equal(checkRoleRename({ role: { name: 'admin', is_system: true }, newName: 'admin' }).ok, true);
  assert.equal(checkRoleRename({ role: { name: 'reviewer' }, newName: 'qa' }).ok, true);
});

test('a role still assigned to active users cannot be deactivated', () => {
  const blocked = checkRoleDeactivation({ role: { name: 'reviewer' }, assignedActiveUsers: 2 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /2 active user/);
  assert.equal(checkRoleDeactivation({ role: { name: 'reviewer' }, assignedActiveUsers: 0 }).ok, true);
});

test('the last active admin cannot lose the admin role', () => {
  const target = { _id: 'u1', roles: ['admin'] };
  assert.equal(checkUserRolesChange({ actorId: 'u2', targetUser: target, newRoleNames: ['teacher'], activeAdminCount: 1 }).ok, false);
  assert.equal(checkUserRolesChange({ actorId: 'u2', targetUser: target, newRoleNames: ['teacher'], activeAdminCount: 2 }).ok, true);
});

test('a user cannot remove their own admin role', () => {
  const result = checkUserRolesChange({ actorId: 'u1', targetUser: { _id: 'u1', roles: ['admin'] }, newRoleNames: ['teacher'], activeAdminCount: 5 });
  assert.equal(result.ok, false);
  assert.match(result.message, /your own admin/i);
});

test('legacy admins (role field only) are protected too', () => {
  assert.equal(checkUserRolesChange({ actorId: 'u2', targetUser: { _id: 'u1', role: 'admin', roles: [] }, newRoleNames: ['student'], activeAdminCount: 1 }).ok, false);
});

test('empty role list falls back to student; names are normalised and de-duplicated', () => {
  assert.deepEqual(checkUserRolesChange({ actorId: 'a', targetUser: { _id: 'b', roles: ['teacher'] }, newRoleNames: [], activeAdminCount: 3 }).roles, ['student']);
  assert.deepEqual(checkUserRolesChange({ actorId: 'a', targetUser: { _id: 'b', roles: [] }, newRoleNames: [' Teacher ', 'teacher'], activeAdminCount: 3 }).roles, ['teacher']);
});

test('the last active admin cannot be deactivated, and nobody deactivates themselves', () => {
  assert.equal(checkUserDeactivation({ actorId: 'u2', targetUser: { _id: 'u1', roles: ['admin'] }, activeAdminCount: 1 }).ok, false);
  assert.equal(checkUserDeactivation({ actorId: 'u1', targetUser: { _id: 'u1', roles: ['teacher'] }, activeAdminCount: 3 }).ok, false);
  assert.equal(checkUserDeactivation({ actorId: 'u2', targetUser: { _id: 'u1', roles: ['teacher'] }, activeAdminCount: 1 }).ok, true);
});

// Pre-review correction: a role is a system role by NAME (admin/student) as
// well as by its `is_system` flag — defence in depth for a document whose
// flag is missing or was tampered with before this fix.
test('isSystemRole: true for admin/student by name even when is_system is false or absent, regardless of case/whitespace', () => {
  assert.equal(isSystemRole({ name: 'admin' }), true);
  assert.equal(isSystemRole({ name: 'admin', is_system: false }), true);
  assert.equal(isSystemRole({ name: '  Admin  ' }), true);
  assert.equal(isSystemRole({ name: 'student' }), true);
  assert.equal(isSystemRole({ name: 'student', is_system: false }), true);
  assert.equal(isSystemRole({ name: 'reviewer' }), false);
  assert.equal(isSystemRole({ name: 'reviewer', is_system: true }), true);
});

test('checkRoleRename: refuses a role named admin (or student) whose is_system is false or absent', () => {
  assert.equal(checkRoleRename({ role: { name: 'admin', is_system: false }, newName: 'root' }).ok, false);
  assert.equal(checkRoleRename({ role: { name: 'admin' }, newName: 'root' }).ok, false);
  assert.equal(checkRoleRename({ role: { name: 'student', is_system: false }, newName: 'pupil' }).ok, false);
  assert.equal(checkRoleRename({ role: { name: 'student' }, newName: 'pupil' }).ok, false);
});

test('checkRoleDeactivation: refuses a role named admin (or student) whose is_system is false or absent', () => {
  assert.equal(checkRoleDeactivation({ role: { name: 'admin', is_system: false }, assignedActiveUsers: 0 }).ok, false);
  assert.equal(checkRoleDeactivation({ role: { name: 'admin' }, assignedActiveUsers: 0 }).ok, false);
  assert.equal(checkRoleDeactivation({ role: { name: 'student', is_system: false }, assignedActiveUsers: 0 }).ok, false);
  assert.equal(checkRoleDeactivation({ role: { name: 'student' }, assignedActiveUsers: 0 }).ok, false);
});
