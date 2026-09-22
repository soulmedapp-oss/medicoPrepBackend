const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { authorize, selfService, publicRoute } = require('../src/rbac/authorize');
const { listRoutes } = require('../src/rbac/listRoutes');

function mockRes() {
  return { statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
}
const run = (mw, req) => { const res = mockRes(); let nexted = false; mw(req, res, () => { nexted = true; }); return { res, nexted }; };

test('authorize allows a user holding the permission', () => {
  const { nexted } = run(authorize('CanEditQuestions'), { user: { effective_permissions: ['CanEditQuestions'] } });
  assert.equal(nexted, true);
});

test('authorize denies with 403 and the required codes', () => {
  const { res, nexted } = run(authorize('CanEditQuestions'), { user: { effective_permissions: [] } });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanEditQuestions'] });
});

test('authorize answers 401 when there is no user', () => {
  const { res } = run(authorize('CanEditQuestions'), {});
  assert.equal(res.statusCode, 401);
});

test('authorize denies a user whose permissions are missing entirely (all roles inactive)', () => {
  const { res } = run(authorize('CanEditQuestions'), { user: {} });
  assert.equal(res.statusCode, 403);
});

test('authorize.any allows when any one code is held', () => {
  const mw = authorize.any('CanAccessTests', 'CanViewTests');
  assert.equal(run(mw, { user: { effective_permissions: ['CanViewTests'] } }).nexted, true);
  assert.equal(run(mw, { user: { effective_permissions: ['CanViewVideos'] } }).res.statusCode, 403);
});

test('a misspelled code throws when the route is defined', () => {
  assert.throws(() => authorize('CanEditQuestons'), /Unknown permission/);
  assert.throws(() => authorize.any('CanViewTests', 'nope'), /Unknown permission/);
  assert.throws(() => authorize(), /at least one/);
});

test('markers', () => {
  assert.deepEqual(authorize('CanViewTests').rbacRule, { type: 'permission', codes: ['CanViewTests'] });
  assert.equal(selfService.rbacRule.type, 'self');
  assert.equal(publicRoute.rbacRule.type, 'public');
});

test('listRoutes finds rules on direct and nested routes', () => {
  const app = express();
  const router = express.Router();
  router.get('/a', authorize('CanViewTests'), (req, res) => res.end());
  router.post('/b', (req, res) => res.end());
  app.use('/x', router);
  app.get('/health', publicRoute, (req, res) => res.end());
  const routes = listRoutes(app);
  const find = (m, p) => routes.find((r) => r.method === m && r.path === p);
  assert.deepEqual(find('GET', '/a').rules, [{ type: 'permission', codes: ['CanViewTests'] }]);
  assert.deepEqual(find('POST', '/b').rules, []);
  assert.equal(find('GET', '/health').rules[0].type, 'public');
});
