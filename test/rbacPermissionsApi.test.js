// Controller-level tests (Task 10) for GET /permissions: catalogue order,
// shape, and role attribution (admin always listed, spec 6.2/addendum G).
const test = require('node:test');
const assert = require('node:assert/strict');

const Permission = require('../src/models/Permission');
const Role = require('../src/models/Role');
const { createPermissionsController } = require('../src/controllers/permissionsController');
const { PERMISSIONS, ALL_CODES } = require('../src/rbac/permissions');

function q(value) {
  const chain = {
    sort: () => chain,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const originals = [];
function stub(obj, key, fn) {
  originals.push([obj, key, obj[key]]);
  obj[key] = fn;
}
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
});

function permissionsController() { return createPermissionsController(); }

test('listPermissions: every catalogue permission carries its shape, in catalogue order', async () => {
  stub(Permission, 'find', () => q(ALL_CODES.map((code) => ({ code, is_active: true }))));
  stub(Role, 'find', () => q([]));
  const res = mockRes();
  await permissionsController().listPermissions({ user: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.permissions.length, PERMISSIONS.length);
  assert.deepEqual(res.body.permissions.map((p) => p.code), PERMISSIONS.map((p) => p.code));
  const first = res.body.permissions[0];
  assert.deepEqual(Object.keys(first).sort(), ['code', 'description', 'label', 'resource', 'roles'].sort());
});

test('listPermissions: admin is listed on every permission, even with no custom roles', async () => {
  stub(Permission, 'find', () => q(ALL_CODES.map((code) => ({ code, is_active: true }))));
  stub(Role, 'find', () => q([]));
  const res = mockRes();
  await permissionsController().listPermissions({ user: {} }, res);
  assert.ok(res.body.permissions.every((p) => p.roles.includes('admin')));
});

test('listPermissions: a role holding a code is listed on that permission (and only that one)', async () => {
  stub(Permission, 'find', () => q(ALL_CODES.map((code) => ({ code, is_active: true }))));
  stub(Role, 'find', () => q([
    { name: 'reviewer', is_active: true, permissions: ['CanViewTests'] },
  ]));
  const res = mockRes();
  await permissionsController().listPermissions({ user: {} }, res);
  const viewTests = res.body.permissions.find((p) => p.code === 'CanViewTests');
  const editTests = res.body.permissions.find((p) => p.code === 'CanEditTests');
  assert.ok(viewTests.roles.includes('reviewer'));
  assert.ok(!editTests.roles.includes('reviewer'));
});

test('listPermissions: only active permissions from the catalogue are returned', async () => {
  stub(Permission, 'find', () => q(ALL_CODES.filter((c) => c !== 'CanViewTests').map((code) => ({ code, is_active: true }))));
  stub(Role, 'find', () => q([]));
  const res = mockRes();
  await permissionsController().listPermissions({ user: {} }, res);
  assert.ok(!res.body.permissions.some((p) => p.code === 'CanViewTests'));
  assert.equal(res.body.permissions.length, PERMISSIONS.length - 1);
});

test('listPermissions: the literal admin role document never contributes via its own (ignored) permissions field', async () => {
  stub(Permission, 'find', () => q(ALL_CODES.map((code) => ({ code, is_active: true }))));
  stub(Role, 'find', () => q([
    { name: 'admin', is_active: true, is_system: true, permissions: [] },
  ]));
  const res = mockRes();
  await permissionsController().listPermissions({ user: {} }, res);
  // 'admin' is always prepended once, never doubled from its own role doc.
  const viewTests = res.body.permissions.find((p) => p.code === 'CanViewTests');
  assert.deepEqual(viewTests.roles, ['admin']);
});
