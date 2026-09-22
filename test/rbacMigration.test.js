// Task 12: one-time migration from legacy role/user permission data to the
// new RBAC catalogue. Pure planning logic lives in src/rbac/migrationPlan.js
// so it is testable without a database.
//
// Addendum (controller, 2026-09-21) corrected two defects in the original
// brief before this was implemented:
//  A. planRoleMigration must NOT union DEFAULT_ROLE_PERMISSIONS on every run
//     (seeding is insert-only for the same reason: an admin's edits on the
//     Roles page must survive a re-run). A default role is topped up only
//     when it has never been migrated (no stored permission is a catalogue
//     code), or when `forceTopUp: true` (--reset-defaults) is passed.
//  B. Role names are identifiers and must be normalised (lower-cased/
//     trimmed) for permissions to resolve at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planRoleMigration, planUserMigration, customRoleName } = require('../src/rbac/migrationPlan');
const { codesForResource } = require('../src/rbac/permissions');

// ---- Brief's original tests (re-verified against live legacyMap.js and kept as-is) ----

test('teacher role: old strings mapped, class/video/student-page access topped up', () => {
  const plan = planRoleMigration({ name: 'teacher', permissions: ['manage_tests', 'manage_questions'] });
  // CanHostAnyClass is deliberately NOT part of the teacher defaults (spec section 2).
  ['CanEditTests', 'CanEditQuestions', 'CanViewTests', ...codesForResource('Classes').filter((c) => c !== 'CanHostAnyClass'),
    ...codesForResource('Videos'), 'CanAccessTests', 'CanUseAiTutor', 'CanAccessTeacherRequests']
    .forEach((code) => assert.ok(plan.permissions.includes(code), code));
  assert.equal(plan.permissions.includes('CanHostAnyClass'), false);
  assert.equal(plan.permissions.some((c) => c.startsWith('manage_')), false);
});

test('a role holding a mix of old and new codes ends with only new codes', () => {
  const plan = planRoleMigration({ name: 'reviewer', permissions: ['CanViewQuestions', 'manage_feedback'] });
  assert.deepEqual(plan.permissions.sort(), ['CanEditFeedback', 'CanViewAllFeedback', 'CanViewQuestions'].sort());
});

test('running the role plan on its own output changes nothing', () => {
  const first = planRoleMigration({ name: 'teacher', permissions: ['manage_tests'] });
  assert.equal(planRoleMigration({ name: 'teacher', permissions: first.permissions }), null);
  assert.equal(planRoleMigration({ name: 'reviewer', permissions: ['CanViewQuestions'] }), null);
});

test('custom roles are not topped up with defaults', () => {
  const plan = planRoleMigration({ name: 'finance', permissions: ['manage_payments'] });
  assert.deepEqual(plan.permissions, ['CanViewAllPayments']);
});

test('user roles are filled from role and is_teacher', () => {
  const plan = planUserMigration({ role: 'student', is_teacher: true, roles: [], permissions: [] });
  assert.deepEqual(plan.roles.sort(), ['student', 'teacher']);
  assert.equal(plan.role, 'teacher');
  assert.equal(plan.is_teacher, true);
  assert.equal(plan.customRole, null);
});

test('per-user permissions become a deterministic custom role', () => {
  const plan = planUserMigration({ role: 'student', roles: ['student'], permissions: ['manage_coupons'] });
  assert.ok(plan.customRole.name.startsWith('custom_'));
  assert.deepEqual(plan.customRole.permissions.sort(), codesForResource('Coupons').sort());
  assert.ok(plan.roles.includes(plan.customRole.name));
  assert.equal(plan.clearPermissions, true);
  assert.equal(customRoleName(['b', 'a']), customRoleName(['a', 'b']));
});

test('admins with per-user permissions just get them cleared', () => {
  const plan = planUserMigration({ role: 'admin', roles: ['admin'], permissions: ['manage_feedback'] });
  assert.equal(plan.customRole, null);
  assert.equal(plan.clearPermissions, true);
  assert.deepEqual(plan.roles, ['admin']);
});

test('an already-migrated user needs no change', () => {
  assert.equal(planUserMigration({ role: 'teacher', is_teacher: true, roles: ['teacher'], permissions: [] }), null);
});

// ---- Fix round 1, C1: a custom_<hash> role name must never land in `role` ----
// primaryRole (resolvePermissions.js) has no ranking entry for custom_* names
// and falls through to "first non-student name", which used to return the
// hash straight into the legacy `role` field -- silently stripping
// student-only access (isStudentUser/connectionsController key off
// role === 'student') for every non-admin user with a legacy per-user
// `permissions` array.
test('a student with per-user permissions keeps role: "student", not the generated custom_<hash>', () => {
  const plan = planUserMigration({ role: 'student', roles: ['student'], permissions: ['manage_coupons'] });
  assert.equal(plan.role, 'student');
  assert.ok(plan.customRole.name.startsWith('custom_'));
  assert.ok(plan.roles.includes(plan.customRole.name));
});

test('an orphaned/typo role name does not get overwritten with a custom_<hash> either (inherent to primaryRole, unchanged by the C1 fix)', () => {
  const plan = planUserMigration({ role: 'student', roles: ['tacher'], permissions: [] });
  // No per-user permissions here, so there is no custom role in play at all --
  // this only documents that primaryRole's existing ranking (not something
  // this task is asked to redesign) can still surface an orphaned name.
  assert.equal(plan.customRole, null);
  assert.equal(plan.role, 'tacher');
});

// ---- Addendum A: default-role top-up only when never migrated ----

test('a default role holding some catalogue codes but missing a default is left alone (admin edit respected)', () => {
  const plan = planRoleMigration({ name: 'teacher', permissions: ['CanViewTests'] });
  assert.equal(plan, null);
});

test('forceTopUp overrides the "already migrated" guard', () => {
  const plan = planRoleMigration({ name: 'teacher', permissions: ['CanViewTests'] }, { forceTopUp: true });
  assert.notEqual(plan, null);
  assert.ok(plan.permissions.length > 1);
  ['CanEditTests', 'CanAccessTeacherRequests'].forEach((code) => assert.ok(plan.permissions.includes(code), code));
});

test('a default role with no permissions at all has never been migrated and is topped up', () => {
  const plan = planRoleMigration({ name: 'teacher', permissions: [] });
  assert.notEqual(plan, null);
  assert.ok(plan.permissions.includes('CanAccessTeacherRequests'));
});

test('a non-default role whose only strings are unknown legacy junk ends up empty', () => {
  const plan = planRoleMigration({ name: 'mystery', permissions: ['nope'] });
  assert.notEqual(plan, null);
  assert.deepEqual(plan.permissions, []);
});

test('admin role always ends with no permissions, even when forced', () => {
  const plan = planRoleMigration({ name: 'admin', permissions: ['manage_roles'] }, { forceTopUp: true });
  assert.notEqual(plan, null);
  assert.deepEqual(plan.permissions, []);
});

// ---- Addendum B: role names are identifiers ----

test('a raw-cased role name is normalised and renameFrom records the original', () => {
  const plan = planRoleMigration({ name: 'Teacher', permissions: ['manage_tests'] });
  assert.equal(plan.name, 'teacher');
  assert.equal(plan.renameFrom, 'Teacher');
});

test('an already-normalised name with no permission change records renameFrom: null', () => {
  const plan = planRoleMigration({ name: 'reviewer', permissions: ['CanViewQuestions', 'manage_feedback'] });
  assert.equal(plan.renameFrom, null);
});

test('a rename-only change (permissions already migrated) still produces a plan, not null', () => {
  const plan = planRoleMigration({ name: 'Reviewer', permissions: ['CanViewQuestions'] });
  assert.notEqual(plan, null);
  assert.equal(plan.name, 'reviewer');
  assert.deepEqual(plan.permissions, ['CanViewQuestions']);
  assert.equal(plan.renameFrom, 'Reviewer');
});

test('a user holding a raw-cased role name is rewritten to the normalised form', () => {
  const plan = planUserMigration({ role: 'Teacher', roles: ['Teacher'], is_teacher: true, permissions: [] });
  assert.notEqual(plan, null);
  assert.deepEqual(plan.roles, ['teacher']);
});

// ---- Addendum C/D: scripts/migrateRbac.js run(), proven with fake models ----
// No real database anywhere here: Role/User are plain objects recording
// calls, and the User "cursor" is a fake async generator, exactly as the
// addendum asks for.
const { run, parseArgs } = require('../scripts/migrateRbac');

// ---- Fix round 1, I5: an unrecognised CLI flag must throw, not be
// silently ignored - a typo'd --dryrun used to run a full LIVE migration.
// parseArgs is pure (no connection, no I/O) specifically so this property
// is testable without running the script. ----
test('parseArgs accepts the two known flags in any combination', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, forceTopUp: false });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, forceTopUp: false });
  assert.deepEqual(parseArgs(['--reset-defaults']), { dryRun: false, forceTopUp: true });
  assert.deepEqual(parseArgs(['--dry-run', '--reset-defaults']), { dryRun: true, forceTopUp: true });
});

test('parseArgs throws on an unknown/typo\'d flag instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['--dryrun']), /Unknown argument/);
  assert.throws(() => parseArgs(['--dry_run']), /Unknown argument/);
  assert.throws(() => parseArgs(['-n']), /Unknown argument/);
  assert.throws(() => parseArgs(['--dry-run', '--bogus']), /Unknown argument/);
});

function makeSpyModels({ roles = [], users = [] } = {}) {
  const calls = [];
  const spy = (label) => async (...args) => { calls.push({ label, args }); return {}; };
  const Role = {
    find: () => ({ lean: async () => roles }),
    updateOne: spy('Role.updateOne'),
    updateMany: spy('Role.updateMany'),
    bulkWrite: spy('Role.bulkWrite'),
    create: spy('Role.create'),
    save: spy('Role.save'),
    findOneAndUpdate: spy('Role.findOneAndUpdate'),
  };
  const User = {
    find: () => ({ cursor: () => (async function* userCursor() { for (const u of users) yield u; })() }),
    updateOne: spy('User.updateOne'),
    updateMany: spy('User.updateMany'),
    create: spy('User.create'),
    save: spy('User.save'),
    findOneAndUpdate: spy('User.findOneAndUpdate'),
    // Not a write - used only to count affected users for a collision
    // WARNING (fix round 1, I1). Real answer computed from the `users`
    // fixture rather than recorded as a spy call.
    countDocuments: async (filter) => users.filter((u) => {
      const or = filter.$or || [];
      return or.some((clause) => (clause.role !== undefined && u.role === clause.role) || (clause.roles !== undefined && (u.roles || []).includes(clause.roles)));
    }).length,
  };
  return { Role, User, calls };
}

test('dry-run calls no write method (including syncPermissions) while still printing the change lines', async () => {
  const roles = [{ _id: 'r1', name: 'teacher', permissions: ['manage_tests'], is_system: false, is_active: true }];
  const users = [{ _id: 'u1', email: 'a@b.c', role: 'student', roles: [], permissions: ['manage_coupons'], is_teacher: false }];
  const { Role, User, calls } = makeSpyModels({ roles, users });
  const lines = [];
  let syncCalled = false;
  const summary = await run({
    dryRun: true,
    models: { Role, User },
    syncPermissions: async () => { syncCalled = true; },
    countActiveAdmins: async () => 1,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(calls, []);
  assert.equal(syncCalled, false);
  // Fix round 1, M4: `l.includes('ROLE teacher')` also matched the
  // unconditional top-up-reason line ("ROLE teacher: top-up never
  // migrated") printed regardless of whether anything actually changes, so
  // deleting the real per-role change line would not have failed this
  // test. Anchor on the "-> N permissions" change line specifically.
  assert.ok(lines.some((l) => /^ROLE teacher: \d+ -> \d+ permissions/.test(l)), 'the per-role change line (not just the top-up-reason line) is printed');
  assert.ok(lines.some((l) => l.includes('USER a@b.c')));
  assert.ok(lines.some((l) => l.includes('Missing default roles')));
  assert.ok(lines.some((l) => l.includes('Active admins: 1')));
  assert.equal(summary.rolesChanged, 1);
  assert.equal(summary.usersChanged, 1);
  assert.equal(summary.customRolesCreated, 1);
});

test('a real run performs the expected writes and the summary counts match', async () => {
  const roles = [{ _id: 'r1', name: 'teacher', permissions: ['manage_tests'], is_system: false, is_active: true }];
  const users = [{ _id: 'u1', email: 'a@b.c', role: 'student', roles: [], permissions: ['manage_coupons'], is_teacher: false }];
  const { Role, User, calls } = makeSpyModels({ roles, users });
  const lines = [];
  let syncCalled = false;
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => { syncCalled = true; },
    countActiveAdmins: async () => 1,
    log: (line) => lines.push(line),
  });
  assert.equal(syncCalled, true);
  assert.ok(calls.some((c) => c.label === 'Role.bulkWrite'), 'ensures the missing default roles');
  const teacherUpdate = calls.find((c) => c.label === 'Role.updateOne' && c.args[0]._id === 'r1');
  assert.ok(teacherUpdate, 'teacher role permissions are written');
  assert.ok(teacherUpdate.args[1].$set.permissions.length > 1);
  const customRoleWrite = calls.find((c) => c.label === 'Role.updateOne' && c.args[0].name && c.args[0].name.startsWith('custom_'));
  assert.ok(customRoleWrite, 'the per-user custom role is upserted');
  assert.equal(customRoleWrite.args[1].$set.description, 'Migrated per-user permissions');
  assert.deepEqual(customRoleWrite.args[2], { upsert: true });
  const userUpdate = calls.find((c) => c.label === 'User.updateOne' && c.args[0]._id === 'u1');
  assert.ok(userUpdate, 'the user document is written');
  assert.deepEqual(userUpdate.args[1].$set.permissions, []);
  assert.equal(summary.rolesChanged, 1);
  assert.equal(summary.usersChanged, 1);
  assert.equal(summary.customRolesCreated, 1);
});

// ---- Fix round 1, C2: ensureDefaultRoles must not insert a duplicate
// default role for one that is merely unnormalised (and about to be
// renamed), and it must never quietly rename a role into a reserved
// admin/student name. ----
test('a legacy role needing normalisation does not make ensureDefaultRoles insert a duplicate, and the rename lands in one write', async () => {
  const roles = [{ _id: 'r1', name: 'Teacher ', permissions: ['manage_tests'], is_system: false, is_active: true }];
  const { Role, User, calls } = makeSpyModels({ roles, users: [] });
  const lines = [];
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: (line) => lines.push(line),
  });
  const bulkWriteCall = calls.find((c) => c.label === 'Role.bulkWrite');
  assert.ok(bulkWriteCall, 'ensureDefaultRoles still fills the genuinely missing defaults (admin/student/content_writer)');
  const upsertedNames = bulkWriteCall.args[0].map((op) => op.updateOne.filter.name);
  assert.equal(upsertedNames.includes('teacher'), false, 'must not insert a duplicate teacher role - "Teacher " already covers that slot');
  assert.equal(lines.some((l) => l.startsWith('WARNING')), false, 'no collision - nothing else is named teacher yet');
  const renameWrite = calls.find((c) => c.label === 'Role.updateOne' && c.args[0]._id === 'r1');
  assert.ok(renameWrite, 'the legacy role is renamed and migrated in a single write');
  assert.equal(renameWrite.args[1].$set.name, 'teacher');
  assert.ok(renameWrite.args[1].$set.permissions.length > 1);
  assert.equal(summary.rolesChanged, 1);
});

test('a role that would normalise to the reserved name "admin" is refused, not silently renamed', async () => {
  const roles = [{ _id: 'r1', name: 'Admin', permissions: ['manage_roles'], is_system: false, is_active: true }];
  const { Role, User, calls } = makeSpyModels({ roles, users: [] });
  const lines = [];
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: (line) => lines.push(line),
  });
  assert.equal(calls.some((c) => c.label === 'Role.updateOne' && c.args[0]._id === 'r1'), false, 'the legacy "Admin" role is never renamed into the reserved name');
  assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('Admin') && l.includes('admin')));
  // A genuine canonical admin role must still be seeded - the legacy dupe
  // being refused must not be mistaken for "admin already exists".
  const bulkWriteCall = calls.find((c) => c.label === 'Role.bulkWrite');
  const upsertedNames = bulkWriteCall.args[0].map((op) => op.updateOne.filter.name);
  assert.ok(upsertedNames.includes('admin'), 'the real admin role must still be seeded');
  assert.equal(summary.rolesChanged, 0);
});

test('a role needing rename is skipped with a warning when the normalised name already exists, naming how many users are affected (I1)', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = require('../src/rbac/legacyMap');
  const roles = [
    { _id: 'r1', name: 'Teacher', permissions: ['manage_tests'], is_system: false, is_active: true },
    { _id: 'r2', name: 'teacher', permissions: ['CanViewTests'], is_system: false, is_active: true },
    { _id: 'r3', name: 'admin', permissions: [], is_system: true, is_active: true },
    { _id: 'r4', name: 'student', permissions: DEFAULT_ROLE_PERMISSIONS.student, is_system: true, is_active: true },
    { _id: 'r5', name: 'content_writer', permissions: DEFAULT_ROLE_PERMISSIONS.content_writer, is_system: false, is_active: true },
  ];
  const users = [
    { _id: 'u1', email: 'x@y.z', role: 'Teacher', roles: [], permissions: [] },
    { _id: 'u2', email: 'w@y.z', role: 'student', roles: ['Teacher'], permissions: [] },
  ];
  const { Role, User, calls } = makeSpyModels({ roles, users });
  const lines = [];
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: (line) => lines.push(line),
  });
  assert.ok(lines.some((l) => l === 'WARNING role "Teacher": cannot normalise, "teacher" already exists (2 users affected — review by hand before running again)'));
  assert.equal(calls.some((c) => c.label === 'Role.updateOne' && c.args[0]._id === 'r1'), false);
  assert.equal(summary.rolesChanged, 0);
});

// ---- Fix round 1, I2: the is_system backfill had zero coverage - deleting
// the two lines that implement it left the suite green. ----
test('a role named "Student" (capital S) is renamed, migrated and backfilled with is_system in ONE write', async () => {
  const roles = [{ _id: 'r6', name: 'Student', permissions: ['view_tests'], is_system: false, is_active: true }];
  const { Role, User, calls } = makeSpyModels({ roles, users: [] });
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: () => {},
  });
  const write = calls.find((c) => c.label === 'Role.updateOne' && c.args[0]._id === 'r6');
  assert.ok(write, 'the Student role is written');
  const { DEFAULT_ROLE_PERMISSIONS } = require('../src/rbac/legacyMap');
  const set = write.args[1].$set;
  assert.equal(set.name, 'student');
  assert.deepEqual([...set.permissions].sort(), [...DEFAULT_ROLE_PERMISSIONS.student].sort());
  assert.equal(set.is_system, true);
  assert.deepEqual(Object.keys(set).sort(), ['is_system', 'name', 'permissions'], 'rename + permissions + is_system are all in the SAME $set - one write');
  assert.equal(summary.rolesChanged, 1);
});

// ---- Fix round 1, I3: unknownRoleNames must be computed against ACTIVE
// roles only (addendum D bullet 2), not every role regardless of status. ----
test('a deactivated role is reported as granting nothing, even though a role document with that name exists', async () => {
  const roles = [{ _id: 'r1', name: 'retired_staff', permissions: ['CanViewQuestions'], is_system: false, is_active: false }];
  const users = [{ _id: 'u1', email: 'a@b.c', role: 'retired_staff', roles: ['retired_staff'], permissions: [] }];
  const { Role, User } = makeSpyModels({ roles, users });
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: () => {},
  });
  assert.ok(summary.unknownRoleNames.includes('retired_staff'), 'a deactivated role grants nothing and must be flagged, even though the document exists');
});

test('an active role is never flagged as unknown', async () => {
  const roles = [{ _id: 'r1', name: 'reviewer', permissions: ['CanViewQuestions'], is_system: false, is_active: true }];
  const users = [{ _id: 'u1', email: 'a@b.c', role: 'reviewer', roles: ['reviewer'], permissions: [] }];
  const { Role, User } = makeSpyModels({ roles, users });
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: () => {},
  });
  assert.equal(summary.unknownRoleNames.includes('reviewer'), false);
});

// ---- Fix round 1, M5: roles inserted by ensureDefaultRoles were invisible
// in the real-run summary. ----
test('a real run reports the default roles it had to create', async () => {
  const { Role, User } = makeSpyModels({ roles: [], users: [] });
  const lines = [];
  await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: (line) => lines.push(line),
  });
  assert.ok(lines.some((l) => l === 'Created 4 missing default role(s): admin, student, teacher, content_writer'));
});

// ---- Fix round 1, M2: admins with a stale `permissions` array should not
// be listed under "cleared only" (they deliberately get no custom role for
// an unrelated reason - they already hold ALL_CODES). ----
test('an admin with a stale permissions array is cleared but not listed as "cleared only"', async () => {
  const users = [{ _id: 'u1', email: 'admin@b.c', role: 'admin', roles: ['admin'], permissions: ['manage_feedback'] }];
  const { Role, User } = makeSpyModels({ roles: [], users });
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: () => {},
  });
  assert.equal(summary.clearedOnlyEmails.includes('admin@b.c'), false);
});

// ---- Fix round 1, M3: the custom-role upsert must fire once per unique
// permission set, not once per holder. ----
test('two users sharing a permission set only trigger one custom-role write', async () => {
  const users = [
    { _id: 'u1', email: 'a@b.c', role: 'student', roles: ['student'], permissions: ['manage_coupons'] },
    { _id: 'u2', email: 'b@b.c', role: 'student', roles: ['student'], permissions: ['manage_coupons'] },
  ];
  const { Role, User, calls } = makeSpyModels({ roles: [], users });
  const summary = await run({
    dryRun: false,
    models: { Role, User },
    syncPermissions: async () => {},
    countActiveAdmins: async () => 1,
    log: () => {},
  });
  const customRoleWrites = calls.filter((c) => c.label === 'Role.updateOne' && c.args[0].name && c.args[0].name.startsWith('custom_'));
  assert.equal(customRoleWrites.length, 1, 'only one write for the shared custom role, not one per holder');
  assert.equal(summary.customRolesCreated, 1);
});
