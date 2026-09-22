// Fix round 1, item B (and a coverage check for the whole upload-route family):
// asserts the exact rbac rule on every app-level POST /uploads/* route in
// src/server.js. Loads the real app via its `rawApp` export (no DB
// connection/listen happens at require time — startLocalServer() only runs
// when `require.main === module`, which is not the case under the test
// runner; see also the `node -e "require('./src/server.js')"` smoke check
// used throughout task-7-report.md).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rawApp } = require('../src/server.js');
const { listRoutes } = require('../src/rbac/listRoutes');

const expectRule = (routes, method, path, type, codes) => {
  const route = routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} exists`);
  assert.equal(route.rules.length, 1, `${method} ${path} declares exactly one rule`);
  assert.equal(route.rules[0].type, type);
  assert.deepEqual([...route.rules[0].codes].sort(), [...codes].sort());
};

test('app-level upload routes carry the exact spec-mandated rule', () => {
  const routes = listRoutes(rawApp);
  expectRule(routes, 'POST', '/uploads/questions', 'permission',
    ['CanAddQuestions', 'CanEditQuestions', 'CanAddQuestionBank', 'CanEditQuestionBank']);
  expectRule(routes, 'POST', '/uploads/classes', 'permission', ['CanAddClasses', 'CanEditClasses']);
  expectRule(routes, 'POST', '/uploads/recordings', 'permission', ['CanAddClasses', 'CanEditClasses']);
  expectRule(routes, 'POST', '/uploads/transcripts', 'permission', ['CanAddClasses', 'CanEditClasses']);
  expectRule(routes, 'POST', '/uploads/videos', 'permission', ['CanAddVideos', 'CanEditVideos']);
  expectRule(routes, 'POST', '/uploads/doubts', 'permission', ['CanAccessDoubts', 'CanAnswerDoubts']);
  expectRule(routes, 'POST', '/uploads/profile', 'self', []);
});
