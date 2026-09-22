const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listRoutes } = require('../src/rbac/listRoutes');
const createClassesRoutes = require('../src/routes/classesRoutes');
const createVideosRoutes = require('../src/routes/videosRoutes');
const createVideoProgressRoutes = require('../src/routes/videoProgressRoutes');

const pass = (req, res, next) => next();
const deps = { authMiddleware: pass, aiChatLimiter: pass, createNotification: async () => {}, broadcastUserEvent: () => {} };
function rulesFor(factory) { const app = express(); app.use(factory(deps)); return listRoutes(app); }
const expectRule = (routes, method, path, type, codes) => {
  const route = routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} exists`);
  assert.equal(route.rules.length, 1, `${method} ${path} declares exactly one rule`);
  assert.equal(route.rules[0].type, type);
  assert.deepEqual([...route.rules[0].codes].sort(), [...codes].sort());
};

test('classes routes', () => {
  const routes = rulesFor(createClassesRoutes);
  expectRule(routes, 'GET', '/classes', 'permission', ['CanAccessLiveClasses', 'CanViewClasses']);
  expectRule(routes, 'POST', '/classes', 'permission', ['CanAddClasses']);
  expectRule(routes, 'PATCH', '/classes/:id', 'permission', ['CanEditClasses', 'CanDeactivateClasses']);
  expectRule(routes, 'DELETE', '/classes/:id', 'permission', ['CanDeactivateClasses']);
  ['GET /classes/:id/notes', 'POST /classes/:id/notes', 'DELETE /classes/:classId/notes/:noteId',
    'GET /classes/:id/recording', 'GET /classes/:id/join', 'GET /classes/:id/ai-summary', 'POST /classes/:id/ai-chat',
  ].forEach((entry) => { const [m, p] = entry.split(' '); expectRule(routes, m, p, 'permission', ['CanAccessLiveClasses']); });
});

test('videos routes', () => {
  const routes = rulesFor(createVideosRoutes);
  expectRule(routes, 'GET', '/videos', 'permission', ['CanAccessVideos', 'CanViewVideos']);
  expectRule(routes, 'GET', '/videos/:id/ai-summary', 'permission', ['CanAccessVideos', 'CanViewVideos']);
  expectRule(routes, 'POST', '/videos/:id/ai-chat', 'permission', ['CanAccessVideos', 'CanViewVideos']);
  expectRule(routes, 'POST', '/videos', 'permission', ['CanAddVideos']);
  expectRule(routes, 'PATCH', '/videos/:id', 'permission', ['CanEditVideos', 'CanDeactivateVideos']);
  expectRule(routes, 'DELETE', '/videos/:id', 'permission', ['CanDeactivateVideos']);
});

test('video progress routes', () => {
  const routes = rulesFor(createVideoProgressRoutes);
  expectRule(routes, 'GET', '/video-progress', 'permission', ['CanAccessVideos']);
  expectRule(routes, 'POST', '/video-progress', 'permission', ['CanAccessVideos']);
});
