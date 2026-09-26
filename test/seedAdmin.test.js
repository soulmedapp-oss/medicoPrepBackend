const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, planAdminSeed, adminRoleFields } = require('../src/utils/seedAdmin');

test('parseArgs: email is required and normalised', () => {
  assert.equal(parseArgs([]).error, '--email is required');
  const ok = parseArgs(['--email', ' Admin@Example.COM ', '--name', 'A']);
  assert.equal(ok.email, 'admin@example.com');
  assert.equal(ok.name, 'A');
  assert.equal(ok.force, false);
});

test('parseArgs: rejects a malformed email, a short password, a missing value and an unknown flag', () => {
  assert.match(parseArgs(['--email', 'nope']).error, /Not an email/);
  assert.match(parseArgs(['--email', 'a@b.co', '--password', 'short']).error, /at least 8/);
  assert.match(parseArgs(['--email']).error, /needs a value/);
  assert.match(parseArgs(['--email', '--force']).error, /needs a value/);
  assert.match(parseArgs(['--email', 'a@b.co', '--bogus']).error, /Unknown argument/);
});

test('parseArgs: --force and an explicit password are accepted', () => {
  const out = parseArgs(['--email', 'a@b.co', '--password', 'longenough', '--force']);
  assert.equal(out.password, 'longenough');
  assert.equal(out.force, true);
});

test('planAdminSeed: empty database -> create', () => {
  assert.deepEqual(planAdminSeed({ existingUser: null, otherAdminCount: 0, force: false }), { action: 'create' });
});

test('planAdminSeed: existing student -> promote; existing admin -> noop', () => {
  assert.deepEqual(
    planAdminSeed({ existingUser: { role: 'student', roles: ['student'] }, otherAdminCount: 0, force: false }),
    { action: 'promote' }
  );
  assert.equal(planAdminSeed({ existingUser: { roles: ['admin'] }, otherAdminCount: 0, force: false }).action, 'noop');
  assert.equal(planAdminSeed({ existingUser: { role: 'admin', roles: [] }, otherAdminCount: 3, force: false }).action, 'noop');
});

test('planAdminSeed: another admin already exists -> refuse without --force, proceed with it', () => {
  const refused = planAdminSeed({ existingUser: null, otherAdminCount: 1, force: false });
  assert.equal(refused.action, 'refuse');
  assert.match(refused.reason, /1 admin account/);
  assert.deepEqual(planAdminSeed({ existingUser: null, otherAdminCount: 1, force: true }), { action: 'create' });
});

test('adminRoleFields: sets the legacy role and adds admin to the roles list without dropping others', () => {
  assert.deepEqual(adminRoleFields(['student', 'teacher']), { role: 'admin', roles: ['student', 'teacher', 'admin'] });
  assert.deepEqual(adminRoleFields(undefined), { role: 'admin', roles: ['admin'] });
  assert.deepEqual(adminRoleFields(['admin']), { role: 'admin', roles: ['admin'] });
});
