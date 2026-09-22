const test = require('node:test');
const assert = require('node:assert/strict');
const { LEGACY_PERMISSION_MAP, mapLegacyPermissions, DEFAULT_ROLE_PERMISSIONS } = require('../src/rbac/legacyMap');
const { isKnownPermission, codesForResource } = require('../src/rbac/permissions');

test('every mapped code exists in the catalogue', () => {
  Object.entries(LEGACY_PERMISSION_MAP).forEach(([old, codes]) => {
    assert.ok(codes.length > 0, old);
    codes.forEach((code) => assert.equal(isKnownPermission(code), true, `${old} -> ${code}`));
  });
});

test('manage_questions covers Questions, QuestionBank and Subjects except owners', () => {
  const mapped = LEGACY_PERMISSION_MAP.manage_questions;
  [...codesForResource('Questions'), ...codesForResource('QuestionBank'), 'CanAddSubjects', 'CanEditSubjects']
    .forEach((code) => assert.ok(mapped.includes(code), code));
  assert.equal(mapped.includes('CanManageSubjectOwners'), false);
});

test('every old string used in the codebase is mapped', () => {
  ['manage_questions', 'manage_tests', 'manage_classes', 'manage_videos', 'manage_students', 'manage_doubts',
    'manage_feedback', 'manage_roles', 'manage_subscriptions', 'manage_teacher_requests', 'manage_payments',
    'manage_coupons', 'view_analytics', 'view_dashboard', 'view_tests', 'view_live_classes', 'view_videos',
    'view_doubts', 'view_progress', 'view_subscription', 'view_payments', 'view_feedback', 'view_community',
  ].forEach((old) => assert.ok(Array.isArray(LEGACY_PERMISSION_MAP[old]), old));
});

test('mapLegacyPermissions handles mixed old/new/unknown input and is idempotent', () => {
  const once = mapLegacyPermissions(['view_tests', 'CanViewVideos', 'garbage', 'view_tests']);
  assert.deepEqual(once.sort(), ['CanAccessTests', 'CanViewVideos']);
  assert.deepEqual(mapLegacyPermissions(once).sort(), once.sort());
});

test('manage_questions also maps to CanViewTests, so content writers keep GET /tests/:id access', () => {
  // AdminQuestions.jsx calls GET /tests/:id; a manage_questions-only role must not
  // lose access to that route now that it requires CanAccessTests or CanViewTests.
  assert.ok(LEGACY_PERMISSION_MAP.manage_questions.includes('CanViewTests'));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.content_writer.includes('CanViewTests'));
});

test('default teacher keeps class/video management (except CanHostAnyClass); students get every CanAccess code', () => {
  codesForResource('Classes').concat(codesForResource('Videos'))
    .filter((code) => code !== 'CanHostAnyClass')
    .forEach((code) => assert.ok(DEFAULT_ROLE_PERMISSIONS.teacher.includes(code), code));
  codesForResource('StudentPages')
    .forEach((code) => assert.ok(DEFAULT_ROLE_PERMISSIONS.student.includes(code), code));
  assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.admin, []);
});

// Fix round 1, item A: the Zoom HOST link is the one exception to "no
// ownership rules" (spec section 2). CanHostAnyClass must not be handed out
// by the manage_classes legacy shim or the default teacher role — only admins
// (via ALL_CODES in resolvePermissions) get it by default.
test('CanHostAnyClass is a known permission but is withheld from manage_classes and the default teacher role', () => {
  assert.equal(isKnownPermission('CanHostAnyClass'), true);
  assert.equal(LEGACY_PERMISSION_MAP.manage_classes.includes('CanHostAnyClass'), false);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.teacher.includes('CanHostAnyClass'), false);
});

// Task 8 pre-review correction, item 2: createTeacherRequest used to gate on
// the literal role name 'teacher', blocking any custom teacher-like role.
// CanAccessTeacherRequests replaces it; withheld from the manage_teacher_requests
// legacy shim (same pattern as CanHostAnyClass/manage_classes) and granted to
// the default teacher role explicitly, never to student.
test('CanAccessTeacherRequests is a known permission, granted to teacher by default, withheld from student and from manage_teacher_requests', () => {
  assert.equal(isKnownPermission('CanAccessTeacherRequests'), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.teacher.includes('CanAccessTeacherRequests'), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.student.includes('CanAccessTeacherRequests'), false);
  assert.equal(LEGACY_PERMISSION_MAP.manage_teacher_requests.includes('CanAccessTeacherRequests'), false);
});

// Task 8 fix round 1, item A: isStudentUser(caller) was the hidden role check
// that kept community student-only; now that the three CALLER-side checks are
// deleted, CanAccessCommunity itself must be the thing keeping it
// students-only by default — teacher must NOT get it by default (an admin can
// tick it on for teachers explicitly), student must still get it.
test('CanAccessCommunity: granted to student by default, withheld from teacher by default', () => {
  assert.equal(DEFAULT_ROLE_PERMISSIONS.student.includes('CanAccessCommunity'), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.teacher.includes('CanAccessCommunity'), false);
});
