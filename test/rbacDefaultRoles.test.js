// Fix round 1, item B (controller-found defect, not Task 8's — role seeding
// from an earlier task): ensureDefaultRoles used $addToSet on every server
// start, silently re-adding every default permission to student/teacher/
// content_writer even after an admin unticked one on the Roles page. Seeding
// must be INSERT-ONLY. defaultRoleUpserts() is the pure part, testable
// without loading the app or a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultRoleUpserts } = require('../src/rbac/defaultRoles');
const { DEFAULT_ROLE_PERMISSIONS } = require('../src/rbac/legacyMap');

test('defaultRoleUpserts: exactly the four default role names', () => {
  const upserts = defaultRoleUpserts();
  assert.deepEqual(upserts.map((u) => u.filter.name).sort(), ['admin', 'content_writer', 'student', 'teacher']);
});

test('defaultRoleUpserts: every update is insert-only ($setOnInsert has permissions/description/is_active; no $addToSet, no top-level $set)', () => {
  defaultRoleUpserts().forEach(({ filter, update }) => {
    assert.ok(update.$setOnInsert, `${filter.name} has $setOnInsert`);
    assert.deepEqual(update.$setOnInsert.permissions, DEFAULT_ROLE_PERMISSIONS[filter.name], `${filter.name} $setOnInsert.permissions matches DEFAULT_ROLE_PERMISSIONS`);
    assert.equal(typeof update.$setOnInsert.description, 'string', `${filter.name} $setOnInsert has a description`);
    assert.equal(update.$setOnInsert.is_active, true, `${filter.name} $setOnInsert.is_active is true`);
    assert.equal(update.$addToSet, undefined, `${filter.name} has no $addToSet (that re-adds permissions on every start)`);
    assert.equal(update.$set, undefined, `${filter.name} has no top-level $set`);
  });
});

test('defaultRoleUpserts: student and admin are seeded is_system on insert', () => {
  const upserts = defaultRoleUpserts();
  const student = upserts.find((u) => u.filter.name === 'student');
  const admin = upserts.find((u) => u.filter.name === 'admin');
  const teacher = upserts.find((u) => u.filter.name === 'teacher');
  assert.equal(student.update.$setOnInsert.is_system, true);
  assert.equal(admin.update.$setOnInsert.is_system, true);
  assert.notEqual(teacher.update.$setOnInsert.is_system, true);
});
