process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const { authMiddleware } = require('../src/middlewares/auth');
const { ALL_CODES } = require('../src/rbac/permissions');

const lean = (value) => ({ lean: async () => value });
function mockRes() {
  return { statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
}
async function runWith(user, roles) {
  const orig = [User.findById, Role.find];
  User.findById = () => lean(user);
  Role.find = () => lean(roles);
  try {
    const token = jwt.sign({ sub: String(user._id), tv: user.token_version || 0 }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nexted = false;
    await authMiddleware(req, res, () => { nexted = true; });
    return { req, res, nexted };
  } finally {
    [User.findById, Role.find] = orig;
  }
}

test('permissions are the union of the user roles', async () => {
  const { req, nexted } = await runWith(
    { _id: '64b000000000000000000001', roles: ['teacher', 'reviewer'], is_active: true },
    [{ name: 'teacher', permissions: ['CanViewTests'], is_active: true },
      { name: 'reviewer', permissions: ['CanViewQuestions'], is_active: true }],
  );
  assert.equal(nexted, true);
  assert.deepEqual(req.user.effective_permissions.sort(), ['CanViewQuestions', 'CanViewTests']);
  assert.deepEqual(req.user.role_names.sort(), ['reviewer', 'teacher']);
});

test('admin with an explicit per-user permission still gets everything', async () => {
  const { req } = await runWith(
    { _id: '64b000000000000000000002', role: 'admin', permissions: ['manage_feedback'], is_active: true }, [],
  );
  assert.equal(req.user.effective_permissions.length, ALL_CODES.length);
});

test('per-user permissions no longer grant anything', async () => {
  const { req } = await runWith(
    { _id: '64b000000000000000000003', role: 'student', permissions: ['CanEditQuestions'], is_active: true },
    [{ name: 'student', permissions: ['CanAccessTests'], is_active: true }],
  );
  assert.deepEqual(req.user.effective_permissions, ['CanAccessTests']);
});
