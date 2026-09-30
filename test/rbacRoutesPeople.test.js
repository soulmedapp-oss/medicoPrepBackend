// Route-rule coverage tests (Task 8) for users, community (connections/groups),
// doubts, feedback, teacher requests, notifications and dashboard.
// `rulesFor`/`expectRule` helpers copied in as in Task 7 (test/rbacRoutesMedia.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listRoutes } = require('../src/rbac/listRoutes');
const createUsersRoutes = require('../src/routes/usersRoutes');
const createConnectionsRoutes = require('../src/routes/connectionsRoutes');
const createGroupsRoutes = require('../src/routes/groupsRoutes');
const createDoubtsRoutes = require('../src/routes/doubtsRoutes');
const createFeedbackRoutes = require('../src/routes/feedbackRoutes');
const createTeacherRequestsRoutes = require('../src/routes/teacherRequestsRoutes');
const createNotificationsRoutes = require('../src/routes/notificationsRoutes');
const createDashboardRoutes = require('../src/routes/dashboardRoutes');

const pass = (req, res, next) => next();
// Built from each factory's real parameter list (pass-through stubs).
const deps = {
  authMiddleware: pass,
  createNotification: async () => {},
  isStudentUser: () => true,
  hasAcceptedConnection: async () => true,
  sendSupportEmail: async () => {},
  broadcastFeedback: () => {},
};
function rulesFor(factory) { const app = express(); app.use(factory(deps)); return listRoutes(app); }
const expectRule = (routes, method, path, type, codes) => {
  const route = routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} exists`);
  assert.equal(route.rules.length, 1, `${method} ${path} declares exactly one rule`);
  assert.equal(route.rules[0].type, type);
  assert.deepEqual([...route.rules[0].codes].sort(), [...codes].sort());
};

test('users', () => {
  const routes = rulesFor(createUsersRoutes);
  expectRule(routes, 'GET', '/users', 'self', []);
  expectRule(routes, 'POST', '/users', 'permission', ['CanAddUsers']);
  expectRule(routes, 'PUT', '/users/:id/roles', 'permission', ['CanAssignUserRoles']);
  expectRule(routes, 'PATCH', '/users/:id', 'permission', ['CanEditUsers', 'CanDeactivateUsers']);
  expectRule(routes, 'DELETE', '/users/:id', 'permission', ['CanDeactivateUsers']);
});
test('community', () => {
  const c = rulesFor(createConnectionsRoutes);
  ['GET /connections/requests', 'POST /connections/request', 'PATCH /connections/requests/:id', 'GET /connections', 'GET /students']
    .forEach((e) => { const [m, p] = e.split(' '); expectRule(c, m, p, 'permission', ['CanAccessCommunity']); });
  const g = rulesFor(createGroupsRoutes);
  // Guards against a vacuous pass on an empty route list (7 routes today:
  // GET/POST /groups, POST /groups/:id/members, GET/POST /groups/:id/resources,
  // POST /groups/:groupId/resources/:resourceId/like and .../comments).
  assert.equal(g.length, 7);
  g.forEach((r) => expectRule(g, r.method, r.path, 'permission', ['CanAccessCommunity']));
});
test('doubts', () => {
  const routes = rulesFor(createDoubtsRoutes);
  expectRule(routes, 'GET', '/doubts', 'permission', ['CanAccessDoubts', 'CanViewAllDoubts']);
  expectRule(routes, 'POST', '/doubts', 'permission', ['CanAccessDoubts']);
  expectRule(routes, 'PATCH', '/doubts/:id', 'permission', ['CanAccessDoubts', 'CanAnswerDoubts']);
});
test('feedback', () => {
  const routes = rulesFor(createFeedbackRoutes);
  expectRule(routes, 'GET', '/feedback', 'permission', ['CanAccessFeedback', 'CanViewAllFeedback']);
  expectRule(routes, 'POST', '/feedback', 'permission', ['CanAccessFeedback']);
  expectRule(routes, 'POST', '/feedback/public', 'public', []);
  expectRule(routes, 'PATCH', '/feedback/:id', 'permission', ['CanEditFeedback']);
});
test('teacher requests', () => {
  const routes = rulesFor(createTeacherRequestsRoutes);
  expectRule(routes, 'GET', '/teacher-requests', 'permission', ['CanAccessTeacherRequests', 'CanViewAllTeacherRequests']);
  expectRule(routes, 'POST', '/teacher-requests', 'permission', ['CanAccessTeacherRequests']);
  expectRule(routes, 'PATCH', '/teacher-requests/:id', 'permission', ['CanEditTeacherRequests']);
});
test('notifications', () => {
  const routes = rulesFor(createNotificationsRoutes);
  expectRule(routes, 'GET', '/notifications', 'self', []);
  expectRule(routes, 'PATCH', '/notifications/:id', 'self', []);
  expectRule(routes, 'POST', '/notifications', 'permission', ['CanSendNotifications']);
});
test('dashboard', () => {
  const routes = rulesFor(createDashboardRoutes);
  expectRule(routes, 'GET', '/dashboard/admin', 'permission', ['CanViewAdminDashboard']);
  expectRule(routes, 'GET', '/dashboard/student', 'permission', ['CanAccessDashboard']);
});
