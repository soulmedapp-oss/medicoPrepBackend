process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listRoutes, listMounts, mountViolation } = require('../src/rbac/listRoutes');
const { isKnownPermission } = require('../src/rbac/permissions');
const { checkRouteOrdering } = require('../src/rbac/checkRouteOrdering');

const app = require('../src/server.js').rawApp;
const routes = listRoutes(app);

test('the app registers routes', () => {
  assert.ok(routes.length > 100, `found ${routes.length}`);
});

test('every route declares exactly one access rule', () => {
  const bad = routes.filter((r) => r.rules.length !== 1).map((r) => `${r.method} ${r.path} (${r.rules.length})`);
  assert.deepEqual(bad, []);
});

test('every permission named on a route is in the catalogue', () => {
  const unknown = routes.flatMap((r) => r.rules.flatMap((rule) => rule.codes)).filter((c) => !isKnownPermission(c));
  assert.deepEqual(unknown, []);
});

test('no permission in the catalogue is unused by both routes and controllers', () => {
  const { ALL_CODES } = require('../src/rbac/permissions');
  const fs = require('node:fs'); const path = require('node:path');
  const read = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? read(path.join(dir, e.name)) : [fs.readFileSync(path.join(dir, e.name), 'utf8')]);
  const source = [...read(path.join(__dirname, '../src/routes')), ...read(path.join(__dirname, '../src/controllers')),
    fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8')].join('\n');
  // CanAccessProgress/Subscription/Payments gate frontend pages only (their APIs are selfService).
  const frontendOnly = new Set(['CanAccessProgress', 'CanAccessSubscription', 'CanAccessPayments']);
  // Codes whose first backend use arrives with a LATER task. Each later task must delete its entry here.
  const pendingLaterTasks = new Set();
  const unused = ALL_CODES.filter((code) => !frontendOnly.has(code) && !pendingLaterTasks.has(code) && !source.includes(`'${code}'`));
  assert.deepEqual(unused, []);
});

// Fix round 1, item A: `listRoutes` only sees router-registered routes, so a
// handler mounted middleware-style (`app.use('/mw', fn)`) or as a sub-app
// (`app.use('/sub', subApp)`) would be invisible to every test above. This
// makes that failure mode explicit: every such mount in the real app must be
// a deliberate, allowlisted exception, each with a reason. Note this asserts
// "every mount found is allowlisted", not "every allowlisted path is
// mounted" — /docs is absent in a production stack (see reason below), so
// the reverse assertion would be environment-dependent.
const MOUNT_ALLOWLIST = [
  {
    name: '/docs',
    sample: '/docs/anything',
    reason: 'Swagger API docs UI (swagger-ui-express) — mounted only outside production or with ENABLE_API_DOCS=true, so it is legitimately absent from a production route listing.',
  },
  {
    name: '/uploads',
    sample: '/uploads/anything.png',
    reason: 'Public static file server (express.static) for uploaded media — images load via a plain <img src>, which cannot attach a bearer token, so this must stay unauthenticated; served with X-Content-Type-Options: nosniff and Content-Disposition: attachment for non-image files.',
  },
];

// Fix round 2: a mount registered with an ARRAY or REGEX path is still one
// layer, so a naive "matches some allowlist sample" check (as above,
// originally) would pass `app.use(['/uploads', '/admin-secret'], fn)` on the
// strength of the '/uploads' half alone. `mountViolation` (shared with the
// synthetic probes in test/rbacListMounts.test.js) requires every one of the
// mount's paths to be allowlisted, and rejects a regex path outright since
// its match space can't be audited by sample testing.
test('every path-mounted non-router layer (a handler listRoutes cannot see) is an allowlisted exception', () => {
  const mounts = listMounts(app);
  const violations = mounts
    .map((layer) => ({ name: layer.name, violation: mountViolation(layer, MOUNT_ALLOWLIST) }))
    .filter((v) => v.violation);
  assert.deepEqual(violations, []);
});

// Fix round 1, item B: "exactly one rule" (the test above) is satisfied by
// `router.get('/x', selfService, handler)` even with no authMiddleware in
// front of it at all — selfService/publicRoute are pass-throughs, and order
// was never checked. See test/rbacRouteOrdering.test.js for synthetic proof
// that checkRouteOrdering actually catches each failure mode; this is the
// same check run over every real route.
test('every route\'s auth/rule ordering is correct (login before a permission/self rule; publicRoute first; the rule is never the last handler)', () => {
  const violations = routes
    .map((r) => ({ route: `${r.method} ${r.path}`, violation: checkRouteOrdering(r) }))
    .filter((v) => v.violation);
  assert.deepEqual(violations, []);
});
