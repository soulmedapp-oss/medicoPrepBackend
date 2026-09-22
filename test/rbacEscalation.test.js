// Pure no-escalation decisions (spec 6.4 / brief addendum B). No database
// access: controllers gather the facts (actor's effective permissions,
// whether the actor is an admin, the role documents behind the roles being
// newly added, whether the request adds/removes the admin role) and call
// these. Each returns null (allowed) or the list of permission codes the
// actor is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { missingForRoleGrant, missingForRolePermissions } = require('../src/rbac/escalation');
const { ALL_CODES } = require('../src/rbac/permissions');

test('missingForRoleGrant: an admin actor is never blocked, no matter what is being granted', () => {
  assert.equal(missingForRoleGrant({
    actorPermissions: [], actorIsAdmin: true,
    addedRoleDocs: [{ name: 'teacher', permissions: ['CanEditTests'] }],
    addsOrRemovesAdmin: true,
  }), null);
});

// Fix round 1, Finding 13: this test's title said "regardless of held codes"
// but the actor was missing exactly one code, so it only proved the
// COVERAGE reading (which Finding 9 showed was wrong) — it could not catch a
// non-admin holding literally every code. Renamed to describe what it
// actually checks; the missing full-coverage case is added right below.
test('missingForRoleGrant: adding/removing the admin role while missing one code is refused (a coverage case, not the identity rule tested below)', () => {
  const missing = missingForRoleGrant({
    actorPermissions: ALL_CODES.filter((c) => c !== 'CanEditTests'), actorIsAdmin: false,
    addedRoleDocs: [], addsOrRemovesAdmin: true,
  });
  assert.notEqual(missing, null);
});

// Fix round 1, Finding 9 (CRITICAL): spec 6.4 rule 2 says "requires the actor
// to be an admin" — identity, not permission coverage. A non-admin holding
// EVERY code must still be refused, and the refusal must be distinguishable
// from a normal missing-codes list (the controller answers a different 403
// body for this case).
test('missingForRoleGrant: adding/removing the admin role is refused for a non-admin actor even when they hold every single permission code', () => {
  const missing = missingForRoleGrant({
    actorPermissions: [...ALL_CODES], actorIsAdmin: false,
    addedRoleDocs: [], addsOrRemovesAdmin: true,
  });
  assert.notEqual(missing, null, 'full permission coverage must not substitute for actually being an admin');
  assert.equal(missing.adminOnly, true, 'must be tellable apart from a plain missing-codes array');
});

// Fix round 1, Finding 11: defence in depth — the pure function must refuse
// on its own if an `admin` role doc ever appears in addedRoleDocs, even if
// the caller forgot to set addsOrRemovesAdmin.
test('missingForRoleGrant: refuses when an admin role doc appears in addedRoleDocs, even with addsOrRemovesAdmin false', () => {
  const missing = missingForRoleGrant({
    actorPermissions: [], actorIsAdmin: false,
    addedRoleDocs: [{ name: 'admin', permissions: [] }],
    addsOrRemovesAdmin: false,
  });
  assert.equal(missing.adminOnly, true);
});

// Fix round 1, Finding 10: a role's permission list must be filtered to
// KNOWN codes, the way the rest of the system resolves a role — a stale code
// left over from before Task 10's validation must not permanently brick a
// legitimate grant.
test('missingForRoleGrant: an unknown/stale code on a role doc is ignored, not demanded', () => {
  const result = missingForRoleGrant({
    actorPermissions: ['CanAssignUserRoles', 'CanViewTests'], actorIsAdmin: false,
    addedRoleDocs: [{ name: 'legacy', permissions: ['CanViewTests', 'CanReadEverything'] }],
    addsOrRemovesAdmin: false,
  });
  assert.equal(result, null, 'CanReadEverything is not a real code and must not be demanded');
});

test('missingForRoleGrant: a non-admin can grant a role whose permissions are entirely within their own', () => {
  const result = missingForRoleGrant({
    actorPermissions: ['CanAssignUserRoles', 'CanViewTests'], actorIsAdmin: false,
    addedRoleDocs: [{ name: 'reviewer', permissions: ['CanViewTests'] }],
    addsOrRemovesAdmin: false,
  });
  assert.equal(result, null);
});

test('missingForRoleGrant: a non-admin cannot grant a role that carries a permission they lack', () => {
  const result = missingForRoleGrant({
    actorPermissions: ['CanAssignUserRoles', 'CanViewTests'], actorIsAdmin: false,
    addedRoleDocs: [{ name: 'editor', permissions: ['CanViewTests', 'CanEditTests'] }],
    addsOrRemovesAdmin: false,
  });
  assert.deepEqual(result, ['CanEditTests']);
});

test('missingForRoleGrant: no roles added is always allowed', () => {
  assert.equal(missingForRoleGrant({
    actorPermissions: [], actorIsAdmin: false, addedRoleDocs: [], addsOrRemovesAdmin: false,
  }), null);
});

test('missingForRolePermissions: adding no permissions is always allowed', () => {
  assert.equal(missingForRolePermissions({ actorPermissions: [], addedCodes: [] }), null);
});

test('missingForRolePermissions: a non-admin can add a permission they already hold', () => {
  assert.equal(missingForRolePermissions({ actorPermissions: ['CanViewTests'], addedCodes: ['CanViewTests'] }), null);
});

test('missingForRolePermissions: a non-admin cannot add a permission they do not hold', () => {
  assert.deepEqual(
    missingForRolePermissions({ actorPermissions: ['CanViewTests'], addedCodes: ['CanViewTests', 'CanEditTests'] }),
    ['CanEditTests']
  );
});
