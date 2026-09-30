// Walks an Express 5 app and lists every route with the rbac rules found in
// its middleware stack. Used by the coverage test.
function walk(stack, out) {
  (stack || []).forEach((layer) => {
    if (layer.route) {
      const handlers = layer.route.stack.map((l) => l.handle);
      const rules = handlers.map((h) => h && h.rbacRule).filter(Boolean);
      // Fix round 1, item B: record WHERE (not just whether) the auth marker
      // and the rule marker sit in the stack, so the coverage test can also
      // check ordering — a rule with no authMiddleware in front of it, or
      // placed after the handler, previously still scored as compliant.
      const authIndex = handlers.findIndex((h) => h && h.rbacAuth === true);
      const ruleIndex = handlers.findIndex((h) => h && h.rbacRule);
      Object.keys(layer.route.methods || {}).forEach((method) => {
        out.push({
          method: method.toUpperCase(),
          path: layer.route.path,
          rules,
          authIndex,
          ruleIndex,
          stackLength: handlers.length,
        });
      });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      walk(layer.handle.stack, out);
    }
  });
  return out;
}

const listRoutes = (app) => walk((app.router || app._router).stack, []);

// Finds handlers that listRoutes cannot see: layers registered via `.use()`
// at a specific path (not '/') whose handler is not a mounted Router — a
// plain middleware function, a static file server (`express.static`), or a
// mounted sub Express app (Express wraps it in an anonymous `mounted_app`
// closure with no `.stack`, so it looks like plain middleware here too).
// These never produce a route entry, so the coverage test uses this to
// require every one of them to be a deliberate, allowlisted exception.
//
// Signal (verified against Express 5.2.1's router package with a synthetic
// app — see test/rbacListMounts.test.js and task-9-report.md "Fix round 1"):
// `Router#use` always builds its Layer with `end: false`, so a Layer's
// `.slash` is `true` exactly when its mount path is '/' (`app.use(fn)` or
// `app.use('/', fn)`) — genuine global middleware, which must NOT be
// reported. Everything else left over from a `.use()` call (not a route,
// not a mounted Router) is a path-mounted non-router layer.
function walkMounts(stack, out) {
  (stack || []).forEach((layer) => {
    if (layer.route) return;
    if (layer.slash) return;
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      walkMounts(layer.handle.stack, out);
      return;
    }
    out.push(layer);
  });
  return out;
}

const listMounts = (app) => walkMounts((app.router || app._router).stack, []);

// Fix round 2: a mount can be registered with an ARRAY of paths or a REGEX
// path — still exactly ONE layer, so `layer.match(sample)` returning true
// for ONE allowlisted sample gives no signal that the same layer also
// serves an unallowlisted path (e.g. `app.use(['/uploads', '/admin-secret'],
// fn)` would pass a naive "matches some allowlist sample" check on the
// strength of '/uploads' alone). This is the one shared helper — used by
// both test/rbacListMounts.test.js's synthetic probes and the real-app
// coverage test — that decides whether a found mount is acceptable.
//
// Signal (verified with a synthetic app against Express 5.2.1's router
// package — see test/rbacListMounts.test.js and task-9-report.md "Fix round
// 2"): `layer.matchers` has one independently-callable matcher PER path
// element (length 1 for a plain string path, length N for an array of N
// paths — node_modules/router/lib/layer.js: `this.matchers =
// Array.isArray(path) ? path.map(matcher) : [matcher(path)]`). Calling a
// matcher directly with a candidate string (`matcher(path)`) is side-effect
// free, unlike `layer.match(path)` which mutates `.path`/`.params`. A
// matcher's function is named exactly `regexpMatcher` if and only if its
// path element was a RegExp instance — that literal name is hand-written in
// layer.js's own regex branch, and the string-path branch instead returns
// path-to-regexp's `match()` (itself a function hand-written and named
// `match` in node_modules/path-to-regexp) — the two names are from two
// different libraries' source and can never collide.
//
// Fix round 3: a matcher accepting an allowlist sample only proves it is not
// TOO NARROW (it doesn't reject the good path) — it says nothing about
// whether it is too BROAD. A plain STRING mount path containing a parameter
// or wildcard segment (`/:anything`, `/*splat`, `/{*any}`, `/:seg/:seg2`)
// compiles to path-to-regexp's ordinary `match` function (so the regex check
// above does not fire), and it happily accepts an allowlist sample while
// ALSO accepting almost any other path. Proving a matcher accepts a GOOD
// path never proves it rejects BAD ones, so every matcher must additionally
// reject a fixed set of deliberately unrelated NEGATIVE probe paths, chosen
// to cover the shapes a broad matcher would swallow: the root itself, one
// segment, two segments, a deep path, and one with a file extension — all
// under a prefix no real mount would ever use.
//
// Verified with a synthetic app (task-9-report.md "Fix round 3"): `/{*any}`
// matches the root `/` itself, `/:anything` and `/*splat` match a single
// unrelated segment, and `/:seg/:seg2` matches (a prefix of) any two-or-more
// segment path — each caught by one of these probes — while
// `/uploads/*splat` matches nothing outside the literal `/uploads/` prefix
// and correctly stays accepted. A bonus of checking this generically instead
// of by name: if a future `router` release ever renames `regexpMatcher`
// (silently defeating the check above), a broad string-based matcher built
// from that renamed regex path would still fail CLOSED here.
const MOUNT_NEGATIVE_PROBE_PATHS = [
  '/',
  '/__rbac_negative__',
  '/__rbac_negative__/a',
  '/__rbac_negative__/a/b/c',
  '/__rbac_negative__/x.png',
];

// Returns null when the mount is acceptable, or a short string describing
// why not.
function mountViolation(layer, allowlist) {
  const isRegexMatcher = (matcher) => matcher.name === 'regexpMatcher';
  if (layer.matchers.some(isRegexMatcher)) {
    return 'mounted with a regex path, which cannot be audited by sample-path testing (a regex\'s full match space cannot be enumerated from a few allowlist samples) — rewrite as explicit string path(s)';
  }
  // Every path element on the mount (one matcher each) must independently
  // match at least one allowlist sample, so an array mount is only accepted
  // when ALL of its paths are allowlisted, not just one of them. (An empty
  // `matchers` array — from `app.use([], fn)` — vacuously passes this and
  // the check below: it can never match any real request, so it is
  // harmless and deliberately left accepted; see
  // test/rbacListMounts.test.js's pinning test.)
  const unmatched = layer.matchers.filter(
    (matcher) => !allowlist.some((entry) => matcher(entry.sample))
  );
  if (unmatched.length > 0) {
    return `mounted at ${unmatched.length} of ${layer.matchers.length} path(s) with no matching allowlist entry`;
  }
  for (const matcher of layer.matchers) {
    const falsePositive = MOUNT_NEGATIVE_PROBE_PATHS.find((probePath) => matcher(probePath));
    if (falsePositive) {
      return `mounted at a path broad enough to also match an unrelated path (${falsePositive}) — likely a parameter or wildcard segment (e.g. ':id', '*splat', '{*any}') rather than a fixed prefix`;
    }
  }
  return null;
}

module.exports = { listRoutes, listMounts, mountViolation, MOUNT_NEGATIVE_PROBE_PATHS };
