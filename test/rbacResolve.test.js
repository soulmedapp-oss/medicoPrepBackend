const test = require('node:test');
const assert = require('node:assert/strict');
const { collectRoleNames, resolvePermissions, primaryRole } = require('../src/rbac/resolvePermissions');
const { can, canAny } = require('../src/rbac/can');
const { ALL_CODES } = require('../src/rbac/permissions');

const role = (name, permissions, is_active = true) => ({ name, permissions, is_active });

test('collectRoleNames merges roles, legacy role and is_teacher, normalised', () => {
  assert.deepEqual(
    collectRoleNames({ roles: [' Teacher ', 'content_writer'], role: 'TEACHER', is_teacher: true }).sort(),
    ['content_writer', 'teacher'],
  );
  assert.deepEqual(collectRoleNames({ role: 'student' }), ['student']);
  assert.deepEqual(collectRoleNames({ is_teacher: true }), ['teacher']);
  assert.deepEqual(collectRoleNames(null), []);
});

test('union of several active roles', () => {
  const perms = resolvePermissions({ roles: ['a', 'b'] }, [
    role('a', ['CanViewQuestions']), role('b', ['CanViewTests', 'CanViewQuestions']),
  ]);
  assert.deepEqual(perms.sort(), ['CanViewQuestions', 'CanViewTests']);
});

test('admin gets every permission, ignoring its role document', () => {
  const perms = resolvePermissions({ roles: ['admin'] }, [role('admin', [])]);
  assert.deepEqual(perms.sort(), [...ALL_CODES].sort());
});

test('inactive roles, missing roles and unknown codes contribute nothing', () => {
  const perms = resolvePermissions({ roles: ['a', 'gone', 'b'] }, [
    role('a', ['CanViewQuestions'], false), role('b', ['manage_questions', 'CanViewTests']),
  ]);
  assert.deepEqual(perms, ['CanViewTests']);
});

test('user with no usable roles resolves to an empty list, no throw', () => {
  assert.deepEqual(resolvePermissions({ roles: ['gone'] }, []), []);
  assert.deepEqual(resolvePermissions({}, []), []);
});

test('user.permissions (per-user grants) is ignored', () => {
  assert.deepEqual(resolvePermissions({ roles: [], permissions: ['CanEditQuestions'] }, []), []);
});

test('primaryRole ranking', () => {
  assert.equal(primaryRole(['student', 'teacher']), 'teacher');
  assert.equal(primaryRole(['reviewer', 'student']), 'reviewer');
  assert.equal(primaryRole(['content_writer', 'admin']), 'admin');
  assert.equal(primaryRole([]), 'student');
});

test('can / canAny read effective_permissions and tolerate missing data', () => {
  const user = { effective_permissions: ['CanViewTests'] };
  assert.equal(can(user, 'CanViewTests'), true);
  assert.equal(can(user, 'CanEditTests'), false);
  assert.equal(canAny(user, ['CanEditTests', 'CanViewTests']), true);
  assert.equal(can(null, 'CanViewTests'), false);
  assert.equal(can({}, 'CanViewTests'), false);
});
