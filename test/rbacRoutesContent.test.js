const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listRoutes } = require('../src/rbac/listRoutes');
const createTestsRoutes = require('../src/routes/testsRoutes');
const createTutorSessionsRoutes = require('../src/routes/tutorSessionsRoutes');
const createSubjectsRoutes = require('../src/routes/subjectsRoutes');

const pass = (req, res, next) => next();
const deps = {
  authMiddleware: pass, csvUpload: { single: () => pass }, createNotification: async () => {},
  broadcastUserEvent: () => {}, enqueueTutorSession: async () => {}, tutorChatLimiter: pass,
};

function rulesFor(factory) {
  const app = express();
  app.use(factory(deps));
  return listRoutes(app);
}
const expectRule = (routes, method, path, type, codes) => {
  const route = routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} exists`);
  assert.equal(route.rules.length, 1, `${method} ${path} declares exactly one rule`);
  assert.equal(route.rules[0].type, type);
  assert.deepEqual([...route.rules[0].codes].sort(), [...codes].sort());
};

test('tests routes follow the spec route map', () => {
  const routes = rulesFor(createTestsRoutes);
  expectRule(routes, 'GET', '/tests', 'permission', ['CanAccessTests', 'CanViewTests']);
  expectRule(routes, 'GET', '/tests/:id', 'permission', ['CanAccessTests', 'CanViewTests']);
  expectRule(routes, 'GET', '/tests/:id/stats', 'permission', ['CanAccessTests', 'CanViewTests']);
  expectRule(routes, 'GET', '/tests/:id/questions', 'permission', ['CanAccessTests', 'CanViewTests']);
  expectRule(routes, 'POST', '/tests', 'permission', ['CanAddTests']);
  expectRule(routes, 'PATCH', '/tests/:id', 'permission', ['CanEditTests', 'CanDeactivateTests']);
  expectRule(routes, 'DELETE', '/tests/:id', 'permission', ['CanDeactivateTests']);
  expectRule(routes, 'POST', '/tests/:id/questions', 'permission', ['CanAddQuestions']);
  expectRule(routes, 'POST', '/tests/:id/questions/bulk-csv', 'permission', ['CanBulkUploadQuestions']);
  expectRule(routes, 'POST', '/tests/:id/questions/assign', 'permission', ['CanAssignTestQuestions']);
  expectRule(routes, 'POST', '/tests/:id/questions/unassign', 'permission', ['CanAssignTestQuestions']);
  expectRule(routes, 'GET', '/questions', 'permission', ['CanViewQuestions']);
  expectRule(routes, 'PATCH', '/questions/:id', 'permission', ['CanEditQuestions', 'CanDeactivateQuestions']);
  expectRule(routes, 'DELETE', '/questions/:id', 'permission', ['CanDeactivateQuestions']);
  expectRule(routes, 'POST', '/questions/bulk-delete', 'permission', ['CanDeactivateQuestions']);
  expectRule(routes, 'POST', '/questions/bulk-activate', 'permission', ['CanDeactivateQuestions']);
  expectRule(routes, 'GET', '/question-bank', 'permission', ['CanViewQuestionBank']);
  expectRule(routes, 'POST', '/question-bank', 'permission', ['CanAddQuestionBank']);
  expectRule(routes, 'POST', '/question-bank/bulk-csv', 'permission', ['CanBulkUploadQuestionBank']);
  expectRule(routes, 'PATCH', '/question-bank/:id', 'permission', ['CanEditQuestionBank', 'CanDeactivateQuestionBank']);
  expectRule(routes, 'DELETE', '/question-bank/:id', 'permission', ['CanDeactivateQuestionBank']);
  expectRule(routes, 'GET', '/attempts', 'self', []);
  expectRule(routes, 'POST', '/tests/:id/attempts', 'permission', ['CanAccessTests']);
  expectRule(routes, 'PATCH', '/attempts/:id', 'self', []);
  expectRule(routes, 'GET', '/attempts/:id/review', 'self', []);
});

test('tutor routes need CanUseAiTutor', () => {
  const routes = rulesFor(createTutorSessionsRoutes);
  expectRule(routes, 'POST', '/attempts/:id/tutor', 'permission', ['CanUseAiTutor']);
  expectRule(routes, 'GET', '/attempts/:id/tutor', 'permission', ['CanUseAiTutor']);
  expectRule(routes, 'POST', '/tutor/chat', 'permission', ['CanUseAiTutor']);
});

test('subjects routes', () => {
  const routes = rulesFor(createSubjectsRoutes);
  expectRule(routes, 'GET', '/subjects', 'self', []);
  expectRule(routes, 'POST', '/subjects', 'permission', ['CanAddSubjects']);
  expectRule(routes, 'PATCH', '/subjects/:id', 'permission', ['CanEditSubjects']);
  expectRule(routes, 'POST', '/subjects/:id/subtopics', 'permission', ['CanAddSubjects']);
  expectRule(routes, 'PATCH', '/subjects/:id/subtopics/:subtopicId', 'permission', ['CanEditSubjects']);
  expectRule(routes, 'PUT', '/subjects/:id/owners', 'permission', ['CanManageSubjectOwners']);
});
