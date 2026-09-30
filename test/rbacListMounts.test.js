// Fix round 1, item A. `listRoutes` cannot see handlers mounted middleware-style
// (`app.use('/mw', fn)`) or as a sub-app (`app.use('/sub', subApp)`) — they
// produce zero route entries. `listMounts` finds these so the coverage test
// can require each one to be a deliberate, allowlisted exception.
//
// Signal verified against Express 5.2.1 (node_modules/router/lib/layer.js,
// node_modules/router/index.js) with a synthetic app, per probe results in
// task-9-report.md "Fix round 1": `Router#use` always builds its Layer with
// `end: false`, so `layer.slash` is `true` exactly when the mount path is
// '/' (`app.use(fn)` or `app.use('/', fn)`) — true global middleware, which
// must NOT be reported. `layer.route` marks an actual route (listRoutes'
// job). `Array.isArray(layer.handle.stack)` marks a mounted Router (recursed
// into, not itself reported — its routes surface via listRoutes instead).
// Everything else left over from a `.use()` call is a path-mounted
// non-router layer: plain middleware, `express.static`, or Express's
// `mounted_app` wrapper around a mounted sub Express app (confirmed by the
// probe: the wrapper has no `.stack`, so it falls into this same bucket —
// satisfying "a sub-app mount must be reported as a mount too").
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listRoutes, listMounts, mountViolation, MOUNT_NEGATIVE_PROBE_PATHS } = require('../src/rbac/listRoutes');

test('listMounts ignores a normal registered route (visible via listRoutes instead)', () => {
  const app = express();
  app.get('/direct', (req, res) => res.end());
  assert.deepEqual(listMounts(app), []);
  assert.equal(listRoutes(app).length, 1);
});

test('listMounts ignores global middleware mounted at "/" (implicit or explicit)', () => {
  const app = express();
  app.use((req, res, next) => next());
  app.use('/', (req, res, next) => next());
  app.use(express.json());
  assert.deepEqual(listMounts(app), []);
});

test('listMounts reports a plain path-mounted middleware function', () => {
  const app = express();
  app.use('/mw', (req, res, next) => next());
  const mounts = listMounts(app);
  assert.equal(mounts.length, 1);
  assert.ok(mounts[0].match('/mw/anything'), 'the found layer matches a path under /mw');
  assert.ok(!mounts[0].match('/unrelated'), 'the found layer does not match an unrelated path');
});

test('listMounts reports a path-mounted express.static server', () => {
  const app = express();
  app.use('/uploads', express.static(__dirname));
  const mounts = listMounts(app);
  assert.equal(mounts.length, 1);
  assert.ok(mounts[0].match('/uploads/pic.png'));
});

test('listMounts does NOT report a mounted Router — its routes surface via listRoutes', () => {
  const app = express();
  const sub = express.Router();
  sub.get('/y', (req, res) => res.end());
  app.use('/router-mount', sub);
  assert.deepEqual(listMounts(app), []);
  const routes = listRoutes(app);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/y');
});

test('listMounts reports a mounted sub Express app as a mount', () => {
  const app = express();
  const subApp = express();
  subApp.get('/x', (req, res) => res.end());
  app.use('/sub', subApp);
  const mounts = listMounts(app);
  assert.equal(mounts.length, 1, 'the sub-app mount is reported (its internal routes are not merged into the parent stack, so listRoutes cannot see them either)');
  assert.ok(mounts[0].match('/sub/x'));
});

test('listMounts on the real app finds exactly the /docs and /uploads mounts', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { rawApp } = require('../src/server.js');
  const mounts = listMounts(rawApp);
  assert.ok(mounts.length > 0, 'at least one mount found');
  const isDocs = (l) => l.match('/docs/anything');
  const isUploads = (l) => l.match('/uploads/anything.png');
  const unclassified = mounts.filter((l) => !isDocs(l) && !isUploads(l));
  assert.deepEqual(unclassified.map((l) => l.name), []);
  assert.ok(mounts.some(isUploads), '/uploads is found');
});

// Fix round 2: a mount registered with an ARRAY or REGEX path is still ONE
// layer with `layer.match(sample) === true` for whichever allowlist sample
// happens to fall under any one of its paths — so the fix round 1 check
// (`MOUNT_ALLOWLIST.some((entry) => layer.match(entry.sample))`) would wave
// through `app.use(['/uploads', '/admin-secret'], fn)` on the strength of the
// '/uploads' half alone, with no signal that the same layer also serves
// '/admin-secret'. `mountViolation(layer, allowlist)` is the one shared
// helper (used by both these synthetic probes and the real-app coverage
// test) that closes this gap. See task-9-report.md "Fix round 2" for the
// probe establishing the two signals it relies on:
//  - `layer.matchers` has one matcher PER path element (one for a plain
//    string path, N for an array of N paths) — verified directly callable
//    with a sample path, side-effect-free (unlike `layer.match`, which
//    mutates `.path`/`.params`).
//  - A matcher's function is named `regexpMatcher` if and ONLY IF the
//    corresponding registered path element was a RegExp instance — this is a
//    literal, deliberate function name baked into
//    node_modules/router/lib/layer.js's own `matcher()` (the string-path
//    branch instead delegates to path-to-regexp's `match()`, itself a
//    function literally named `match` in node_modules/path-to-regexp — the
//    two names can never collide since both are hand-written in their
//    respective source files, not generated).
const ALLOWLIST = [
  { name: '/docs', sample: '/docs/anything' },
  { name: '/uploads', sample: '/uploads/anything.png' },
];
function onlyMount(app) {
  const mounts = listMounts(app);
  assert.equal(mounts.length, 1, 'exactly one mount found');
  return mounts[0];
}

test('mountViolation: CAUGHT — array path with one unallowlisted member', () => {
  const app = express();
  app.use(['/uploads', '/admin-secret'], (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation, 'must be flagged even though /uploads alone would pass');
  assert.match(violation, /admin-secret|not allowlisted|1 of 2|unallowlisted/i);
});

test('mountViolation: OK — array path whose members are all allowlisted', () => {
  const app = express();
  app.use(['/uploads', '/docs'], (req, res, next) => next());
  assert.equal(mountViolation(onlyMount(app), ALLOWLIST), null);
});

test('mountViolation: CAUGHT — a regex path mount cannot be audited by sample testing', () => {
  const app = express();
  app.use(/^\/(uploads|admin-secret)\//, (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation, 'must be flagged regardless of what it happens to match');
  assert.match(violation, /regex/i);
});

test('mountViolation: CAUGHT — /uploads-private is a decoy, not the allowlisted /uploads', () => {
  const app = express();
  app.use('/uploads-private', (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation, 'a same-prefix decoy path must still be rejected');
});

test('mountViolation: OK — plain /uploads and /docs mounts', () => {
  const uploadsApp = express();
  uploadsApp.use('/uploads', (req, res, next) => next());
  assert.equal(mountViolation(onlyMount(uploadsApp), ALLOWLIST), null);

  const docsApp = express();
  docsApp.use('/docs', (req, res, next) => next());
  assert.equal(mountViolation(onlyMount(docsApp), ALLOWLIST), null);
});

test('mountViolation: CAUGHT — a sub-app mounted at an unallowlisted path', () => {
  const app = express();
  const subApp = express();
  subApp.get('/x', (req, res) => res.end());
  app.use('/admin-secret', subApp);
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation, 'a sub-app mount is not exempt from the allowlist just because it is a sub-app');
});

test('mountViolation: the real app has no violations', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { rawApp } = require('../src/server.js');
  const violations = listMounts(rawApp)
    .map((layer) => mountViolation(layer, ALLOWLIST))
    .filter(Boolean);
  assert.deepEqual(violations, []);
});

// Fix round 3: a matcher accepting an allowlist sample only proves it is not
// TOO NARROW — it says nothing about whether it is too BROAD. A plain STRING
// mount path containing a parameter or wildcard segment (`/:anything`,
// `/*splat`, `/{*any}`, `/:seg/:seg2`) compiles to path-to-regexp's ordinary
// `match` function (NOT `regexpMatcher`, so the fix round 2 regex check does
// not fire), and it happily accepts the allowlist sample `/uploads/anything
// .png` while ALSO accepting `/admin-secret/x` and almost everything else.
// `MOUNT_NEGATIVE_PROBE_PATHS` is the fixed, exported set of deliberately
// unrelated paths (under a prefix no real mount would ever use) that every
// matcher must reject in addition to accepting an allowlist sample — see
// task-9-report.md "Fix round 3" for the probe establishing exactly which
// syntaxes each negative path catches (root catches `/{*any}`, which even
// matches '/'; one segment catches `/:anything` and `/*splat`; two segments
// catches `/:seg/:seg2`).
test('mountViolation: CAUGHT — "/:anything" is broad enough to match an unrelated path', () => {
  const app = express();
  app.use('/:anything', (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation, 'accepts the allowlist sample but also matches /__rbac_negative__');
});

test('mountViolation: CAUGHT — "/*splat" is broad enough to match an unrelated path', () => {
  const app = express();
  app.use('/*splat', (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation);
});

test('mountViolation: CAUGHT — "/{*any}" is broad enough to match even the root path', () => {
  const app = express();
  app.use('/{*any}', (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation, '{*any} matches "/" itself, which only the root negative probe catches');
});

test('mountViolation: CAUGHT — "/:seg/:seg2" is broad enough to match an unrelated two-segment path', () => {
  const app = express();
  app.use('/:seg/:seg2', (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(violation);
});

test('mountViolation: OK — "/uploads/*splat" only matches under the literal /uploads prefix', () => {
  const app = express();
  app.use('/uploads/*splat', (req, res, next) => next());
  assert.equal(mountViolation(onlyMount(app), ALLOWLIST), null);
});

test('mountViolation: the violation message names which negative path was wrongly accepted', () => {
  const app = express();
  app.use('/:anything', (req, res, next) => next());
  const violation = mountViolation(onlyMount(app), ALLOWLIST);
  assert.ok(
    MOUNT_NEGATIVE_PROBE_PATHS.some((p) => violation.includes(p)),
    `violation message "${violation}" should name one of ${JSON.stringify(MOUNT_NEGATIVE_PROBE_PATHS)}`
  );
});

test('mountViolation: an empty-array mount ([]) is harmless and stays accepted (it can never match a request)', () => {
  const app = express();
  app.use([], (req, res, next) => next());
  const mounts = listMounts(app);
  // Express drops an empty-array `.use()` call entirely — nothing is even
  // registered — so there is no layer to flag in the first place. Either
  // way (no layer, or a layer with zero matchers), it must not be a
  // violation: it can never match any real request.
  if (mounts.length === 0) {
    assert.equal(mounts.length, 0);
  } else {
    assert.equal(mounts[0].matchers.length, 0);
    assert.equal(mountViolation(mounts[0], ALLOWLIST), null);
  }
});

test('mountViolation: the real app still has zero violations with negative-probe checking added', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { rawApp } = require('../src/server.js');
  const violations = listMounts(rawApp)
    .map((layer) => mountViolation(layer, ALLOWLIST))
    .filter(Boolean);
  assert.deepEqual(violations, []);
});
