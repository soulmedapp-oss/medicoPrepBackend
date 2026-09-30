const test = require('node:test');
const assert = require('node:assert/strict');
const { PERMISSIONS, PERMISSION_CODES, ALL_CODES, isKnownPermission, codesForResource } = require('../src/rbac/permissions');

test('every permission has code, label, description and resource', () => {
  for (const p of PERMISSIONS) {
    assert.match(p.code, /^Can[A-Z][A-Za-z]+$/, p.code);
    assert.ok(p.label && p.description && p.resource, p.code);
  }
});

test('codes are unique', () => {
  assert.equal(PERMISSION_CODES.size, PERMISSIONS.length);
  assert.deepEqual([...PERMISSION_CODES].sort(), [...ALL_CODES].sort());
});

// Every delete in the app is soft, with one deliberate exception: a
// deactivated lecture may be permanently removed from Bunny and the
// database. Any second CanDelete* code needs the same justification.
test('CanDeleteVideos is the only hard-delete permission', () => {
  assert.deepEqual(ALL_CODES.filter((c) => c.startsWith('CanDelete')), ['CanDeleteVideos']);
});

test('Questions has the five documented permissions', () => {
  assert.deepEqual(codesForResource('Questions').sort(), [
    'CanAddQuestions', 'CanBulkUploadQuestions', 'CanDeactivateQuestions', 'CanEditQuestions', 'CanViewQuestions',
  ]);
});

test('isKnownPermission', () => {
  assert.equal(isKnownPermission('CanEditQuestions'), true);
  assert.equal(isKnownPermission('CanEditQuestons'), false);
  assert.equal(isKnownPermission('manage_questions'), false);
});

test('student page permissions exist', () => {
  for (const code of ['CanAccessDashboard', 'CanAccessTests', 'CanAccessLiveClasses', 'CanAccessVideos',
    'CanAccessDoubts', 'CanAccessProgress', 'CanAccessSubscription', 'CanAccessPayments',
    'CanAccessFeedback', 'CanAccessCommunity', 'CanUseAiTutor']) {
    assert.equal(isKnownPermission(code), true, code);
  }
});
