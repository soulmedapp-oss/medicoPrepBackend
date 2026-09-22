// Fix round 1, item B: `authorize`/`selfService`/`publicRoute` are
// pass-throughs, so a route can score "exactly one rule" (test/rbacCoverage
// .test.js's second test) while still being completely unauthenticated —
// `router.get('/x', selfService, handler)` never runs authMiddleware at all.
// The old test also never checked ORDER, so `authorize` placed after the
// handler, or `publicRoute` not first, would also score as compliant.
//
// This builds real synthetic Express routers (not hand-built plain objects)
// using the REAL authMiddleware/authorize/selfService/publicRoute, runs them
// through the REAL listRoutes, and feeds the result to checkRouteOrdering —
// the same function the real-app coverage test uses — to prove each failure
// mode is actually caught.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listRoutes } = require('../src/rbac/listRoutes');
const { checkRouteOrdering } = require('../src/rbac/checkRouteOrdering');
const { authMiddleware } = require('../src/middlewares/auth');
const { authorize, selfService, publicRoute } = require('../src/rbac/authorize');

function routeFor(buildRouter) {
  const app = express();
  const router = express.Router();
  buildRouter(router);
  app.use(router);
  const routes = listRoutes(app);
  assert.equal(routes.length, 1, 'exactly one route registered');
  return routes[0];
}

test('CAUGHT: selfService with no auth in front at all', () => {
  const route = routeFor((r) => r.get('/x', selfService, (req, res) => res.end()));
  const violation = checkRouteOrdering(route);
  assert.ok(violation, 'must be flagged');
  assert.match(violation, /auth/i);
});

test('CAUGHT: authorize(...) placed AFTER the handler', () => {
  const route = routeFor((r) => r.get('/x', authMiddleware, (req, res) => res.end(), authorize('CanEditQuestions')));
  const violation = checkRouteOrdering(route);
  assert.ok(violation, 'must be flagged — the rule is the last handler, nothing runs after it');
});

test('CAUGHT: publicRoute not first', () => {
  const someOtherMiddleware = (req, res, next) => next();
  const route = routeFor((r) => r.get('/x', someOtherMiddleware, publicRoute, (req, res) => res.end()));
  const violation = checkRouteOrdering(route);
  assert.ok(violation, 'must be flagged — publicRoute must be the first handler');
});

test('CAUGHT: authorize present but with no authMiddleware before it', () => {
  const route = routeFor((r) => r.get('/x', authorize('CanEditQuestions'), (req, res) => res.end()));
  const violation = checkRouteOrdering(route);
  assert.ok(violation, 'must be flagged — no login enforced before the permission check');
});

test('PASSES: the correct permission-route shape', () => {
  const route = routeFor((r) => r.get('/x', authMiddleware, authorize('CanEditQuestions'), (req, res) => res.end()));
  assert.equal(checkRouteOrdering(route), null);
});

test('PASSES: the correct selfService shape', () => {
  const route = routeFor((r) => r.get('/x', authMiddleware, selfService, (req, res) => res.end()));
  assert.equal(checkRouteOrdering(route), null);
});

test('PASSES: the correct publicRoute shape', () => {
  const route = routeFor((r) => r.get('/x', publicRoute, (req, res) => res.end()));
  assert.equal(checkRouteOrdering(route), null);
});
