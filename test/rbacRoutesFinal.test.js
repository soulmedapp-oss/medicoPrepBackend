// Route-rule coverage tests (Task 9) for the last unconverted routes: auth,
// payments, coupons, subscription-plans/subscriptions, settings, roles, and
// the app-level direct routes in server.js (webhooks, health, debug,
// OPTIONS preflight). Verifies the EXACT rule per route, not just "exactly
// one" (which test/rbacCoverage.test.js already checks generically).
// Pattern copied from test/rbacRoutesPeople.test.js / rbacRoutesMedia.test.js
// (factory-level) and test/rbacUploadRoutes.test.js (app-level via rawApp).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listRoutes } = require('../src/rbac/listRoutes');
const authRoutes = require('../src/routes/authRoutes');
const createPaymentsRoutes = require('../src/routes/paymentsRoutes');
const createCouponsRoutes = require('../src/routes/couponsRoutes');
const createSubscriptionsRoutes = require('../src/routes/subscriptionsRoutes');
const createSettingsRoutes = require('../src/routes/settingsRoutes');
const createRolesRoutes = require('../src/routes/rolesRoutes');
const createPermissionsRoutes = require('../src/routes/permissionsRoutes');
const { rawApp } = require('../src/server.js');

const pass = (req, res, next) => next();
const deps = {
  authMiddleware: pass,
  createNotification: async () => {},
  getPlansCache: () => null,
  setPlansCache: () => {},
  clearPlansCache: () => {},
};
function rulesFor(factory) { const app = express(); app.use(factory(deps)); return listRoutes(app); }
const expectRule = (routes, method, path, type, codes) => {
  const route = routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} exists`);
  assert.equal(route.rules.length, 1, `${method} ${path} declares exactly one rule`);
  assert.equal(route.rules[0].type, type);
  assert.deepEqual([...route.rules[0].codes].sort(), [...codes].sort());
};

test('auth', () => {
  const app = express();
  app.use(authRoutes);
  const routes = listRoutes(app);
  ['/register', '/login', '/verify-email', '/resend-verification', '/forgot-password',
    '/reset-password', '/validate-reset-token', '/google'].forEach((p) => {
    const route = routes.find((r) => r.path === p);
    assert.ok(route, `${p} exists`);
    expectRule(routes, route.method, p, 'public', []);
  });
  expectRule(routes, 'GET', '/me', 'self', []);
  expectRule(routes, 'PATCH', '/me', 'self', []);
});

test('payments', () => {
  const routes = rulesFor(createPaymentsRoutes);
  expectRule(routes, 'POST', '/payments/order', 'self', []);
  expectRule(routes, 'POST', '/payments/verify', 'self', []);
  expectRule(routes, 'GET', '/payments', 'self', []);
  expectRule(routes, 'PATCH', '/payments/:id/cancel', 'self', []);
  expectRule(routes, 'GET', '/payments/all', 'permission', ['CanViewAllPayments']);
});

test('coupons', () => {
  const routes = rulesFor(createCouponsRoutes);
  expectRule(routes, 'POST', '/coupons/validate', 'self', []);
  expectRule(routes, 'GET', '/coupons', 'permission', ['CanViewCoupons']);
  expectRule(routes, 'POST', '/coupons', 'permission', ['CanAddCoupons']);
  expectRule(routes, 'PATCH', '/coupons/:id', 'permission', ['CanEditCoupons', 'CanDeactivateCoupons']);
  expectRule(routes, 'DELETE', '/coupons/:id', 'permission', ['CanDeactivateCoupons']);
});

test('subscription-plans and subscriptions', () => {
  const routes = rulesFor(createSubscriptionsRoutes);
  expectRule(routes, 'GET', '/subscription-plans', 'public', []);
  expectRule(routes, 'GET', '/subscription-plans/all', 'permission', ['CanViewSubscriptionPlans']);
  expectRule(routes, 'POST', '/subscription-plans', 'permission', ['CanAddSubscriptionPlans']);
  expectRule(routes, 'PATCH', '/subscription-plans/:id', 'permission', ['CanEditSubscriptionPlans', 'CanDeactivateSubscriptionPlans']);
  expectRule(routes, 'DELETE', '/subscription-plans/:id', 'permission', ['CanDeactivateSubscriptionPlans']);
  expectRule(routes, 'GET', '/subscriptions', 'self', []);
  expectRule(routes, 'POST', '/subscriptions', 'permission', ['CanAddSubscriptions']);
  expectRule(routes, 'PATCH', '/subscriptions/:id', 'permission', ['CanEditSubscriptions']);
  expectRule(routes, 'DELETE', '/subscriptions/:id', 'permission', ['CanDeactivateSubscriptions']);
  expectRule(routes, 'POST', '/subscriptions/:id/extend', 'permission', ['CanEditSubscriptions']);
});

test('settings', () => {
  const routes = rulesFor(createSettingsRoutes);
  expectRule(routes, 'GET', '/settings/openai-key', 'permission', ['CanViewSettings']);
  expectRule(routes, 'PUT', '/settings/openai-key', 'permission', ['CanEditSettings']);
});

test('roles', () => {
  const routes = rulesFor(createRolesRoutes);
  expectRule(routes, 'GET', '/roles', 'permission', ['CanViewRoles', 'CanAssignUserRoles']);
  expectRule(routes, 'POST', '/roles', 'permission', ['CanAddRoles']);
  expectRule(routes, 'PATCH', '/roles/:id', 'permission', ['CanEditRoles', 'CanDeactivateRoles']);
  expectRule(routes, 'DELETE', '/roles/:id', 'permission', ['CanDeactivateRoles']);
});

test('permissions (Task 10)', () => {
  const routes = rulesFor(createPermissionsRoutes);
  expectRule(routes, 'GET', '/permissions', 'permission', ['CanViewPermissions', 'CanViewRoles']);
});

test('app-level: webhooks, health, debug rate-limit, OPTIONS preflight', () => {
  const routes = listRoutes(rawApp);
  expectRule(routes, 'POST', '/webhooks/zoom', 'public', []);
  expectRule(routes, 'GET', '/webhooks/razorpay', 'public', []);
  expectRule(routes, 'POST', '/webhooks/razorpay', 'public', []);
  expectRule(routes, 'GET', '/health', 'public', []);
  expectRule(routes, 'GET', '/admin/debug/rate-limit', 'permission', ['CanViewSettings']);
  const optionsRoute = routes.find((r) => r.method === 'OPTIONS');
  assert.ok(optionsRoute, 'an OPTIONS route exists');
  assert.equal(optionsRoute.rules.length, 1);
  assert.equal(optionsRoute.rules[0].type, 'public');
});
