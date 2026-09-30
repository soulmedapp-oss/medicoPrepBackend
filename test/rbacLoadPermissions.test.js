const test = require('node:test');
const assert = require('node:assert/strict');
const Role = require('../src/models/Role');
const { loadPermissions } = require('../src/rbac/loadPermissions');
const { ALL_CODES } = require('../src/rbac/permissions');

function stubRoleFind(fn) {
  const orig = Role.find;
  Role.find = fn;
  return () => { Role.find = orig; };
}

test('union of two roles', async () => {
  let called = false;
  const restore = stubRoleFind(() => {
    called = true;
    return { lean: async () => [
      { name: 'teacher', permissions: ['CanViewTests'], is_active: true },
      { name: 'reviewer', permissions: ['CanViewQuestions'], is_active: true },
    ] };
  });
  try {
    const { roleNames, permissions } = await loadPermissions({ roles: ['teacher', 'reviewer'] });
    assert.equal(called, true);
    assert.deepEqual(roleNames.sort(), ['reviewer', 'teacher']);
    assert.deepEqual(permissions.sort(), ['CanViewQuestions', 'CanViewTests']);
  } finally {
    restore();
  }
});

test('admin makes no Role.find call and gets every code', async () => {
  let called = false;
  const restore = stubRoleFind(() => { called = true; return { lean: async () => [] }; });
  try {
    const { roleNames, permissions } = await loadPermissions({ role: 'admin' });
    assert.equal(called, false);
    assert.deepEqual(roleNames, ['admin']);
    assert.equal(permissions.length, ALL_CODES.length);
  } finally {
    restore();
  }
});

test('a user with no roles makes no Role.find call and gets []', async () => {
  let called = false;
  const restore = stubRoleFind(() => { called = true; return { lean: async () => [] }; });
  try {
    const { roleNames, permissions } = await loadPermissions({});
    assert.equal(called, false);
    assert.deepEqual(roleNames, []);
    assert.deepEqual(permissions, []);
  } finally {
    restore();
  }
});

test('an inactive role contributes nothing', async () => {
  const restore = stubRoleFind(() => ({ lean: async () => [
    { name: 'teacher', permissions: ['CanViewTests'], is_active: false },
  ] }));
  try {
    const { permissions } = await loadPermissions({ role: 'teacher' });
    assert.deepEqual(permissions, []);
  } finally {
    restore();
  }
});
