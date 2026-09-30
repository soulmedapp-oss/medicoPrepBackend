const test = require('node:test');
const assert = require('node:assert/strict');
const { missingUpdatePermissions } = require('../src/rbac/updatePermissions');

const codes = { edit: 'CanEditTests', deactivate: 'CanDeactivateTests' };
const user = (...perms) => ({ effective_permissions: perms });

test('editing other fields needs only the edit permission', () => {
  assert.equal(missingUpdatePermissions(user('CanEditTests'), { title: 'x' }, { is_active: true }, codes), null);
  assert.deepEqual(missingUpdatePermissions(user('CanDeactivateTests'), { title: 'x' }, { is_active: true }, codes), ['CanEditTests']);
});

test('changing is_active needs the deactivate permission, in both directions', () => {
  assert.deepEqual(missingUpdatePermissions(user('CanEditTests'), { is_active: false }, { is_active: true }, codes), ['CanDeactivateTests']);
  assert.deepEqual(missingUpdatePermissions(user('CanEditTests'), { is_active: true }, { is_active: false }, codes), ['CanDeactivateTests']);
  assert.equal(missingUpdatePermissions(user('CanDeactivateTests'), { is_active: true }, { is_active: false }, codes), null);
});

test('a full-form save with an UNCHANGED is_active needs nothing extra', () => {
  assert.equal(missingUpdatePermissions(user('CanEditTests'), { title: 'x', is_active: true }, { is_active: true }, codes), null);
  // a stored document without the field counts as active
  assert.equal(missingUpdatePermissions(user('CanEditTests'), { title: 'x', is_active: true }, {}, codes), null);
  assert.deepEqual(missingUpdatePermissions(user('CanEditTests'), { title: 'x', is_active: false }, {}, codes), ['CanDeactivateTests']);
});

test('changing both needs both; holding both passes', () => {
  assert.deepEqual(missingUpdatePermissions(user(), { title: 'x', is_active: false }, { is_active: true }, codes).sort(), ['CanDeactivateTests', 'CanEditTests']);
  assert.equal(missingUpdatePermissions(user('CanEditTests', 'CanDeactivateTests'), { title: 'x', is_active: false }, { is_active: true }, codes), null);
});

test('is_published is an edit, not a deactivation', () => {
  assert.deepEqual(missingUpdatePermissions(user('CanDeactivateTests'), { is_published: false }, { is_published: true }, codes), ['CanEditTests']);
});

test('tolerates a missing body, user or current document', () => {
  assert.equal(missingUpdatePermissions(user('CanEditTests'), undefined, undefined, codes), null);
  assert.deepEqual(missingUpdatePermissions(null, { title: 'x' }, {}, codes), ['CanEditTests']);
});

// Fix round 1, item A: Mongoose casts "false", 0, "0", "no" to the boolean
// `false` on write (every model declares `is_active: { type: Boolean }`), so
// the helper must fail closed — an edit-only caller must not be able to
// deactivate by sending a non-strict-boolean value the DB would still cast.
test('a non-strict-boolean is_active is treated as a change, whatever it would cast to (fail closed)', () => {
  ['false', 0, '0', 'no', null].forEach((value) => {
    assert.deepEqual(
      missingUpdatePermissions(user('CanEditTests'), { is_active: value }, { is_active: true }, codes),
      ['CanDeactivateTests'],
      `value ${JSON.stringify(value)} must require CanDeactivateTests`
    );
  });
  // Over-strict on purpose: the string "true" is not a strict boolean, so it
  // still fails closed even though it would cast to the same stored value.
  assert.deepEqual(
    missingUpdatePermissions(user('CanEditTests'), { is_active: 'true' }, { is_active: true }, codes),
    ['CanDeactivateTests']
  );
  // A caller who actually holds the deactivate permission may still send a
  // non-strict-boolean value — the fail-closed rule only affects who is
  // *required* to hold the permission, not whether the request is allowed.
  assert.equal(
    missingUpdatePermissions(user('CanDeactivateTests'), { is_active: 'false' }, { is_active: true }, codes),
    null
  );
});

test('a strict-boolean echo of the stored value still needs nothing extra', () => {
  assert.equal(missingUpdatePermissions(user('CanEditTests'), { title: 'x', is_active: true }, { is_active: true }, codes), null);
  assert.equal(missingUpdatePermissions(user('CanEditTests'), { title: 'x', is_active: true }, {}, codes), null);
  assert.equal(missingUpdatePermissions(user('CanEditTests'), { title: 'x', is_active: false }, { is_active: false }, codes), null);
});
