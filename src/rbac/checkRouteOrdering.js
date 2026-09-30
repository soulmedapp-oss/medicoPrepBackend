// Fix round 1, item B: `authorize`/`selfService`/`publicRoute` are
// pass-throughs (their whole job is to carry a marker), so a route scores
// "exactly one rule" (test/rbacCoverage.test.js) even when nothing actually
// enforces login in front of it, or when the rule sits in the wrong place in
// the stack. This is the ordering check shared by the synthetic probe tests
// (test/rbacRouteOrdering.test.js) and the real-app coverage test
// (test/rbacCoverage.test.js), so both exercise exactly the same logic.
//
// Takes one entry from listRoutes(app) — `{ rules, authIndex, ruleIndex,
// stackLength }` — and returns null when its ordering is correct, or a short
// string describing the violation.
function checkRouteOrdering(route) {
  const { rules, authIndex, ruleIndex, stackLength } = route;
  // A different assertion (rbacCoverage.test.js: "exactly one access rule")
  // already covers 0 or 2+ rules; nothing useful to say about order here.
  if (!rules || rules.length !== 1 || ruleIndex === -1) return null;
  const rule = rules[0];

  if (rule.type === 'public') {
    if (ruleIndex !== 0) {
      return `publicRoute must be the first handler (found at index ${ruleIndex})`;
    }
  } else {
    // 'permission' (authorize/authorize.any) or 'self' (selfService): login
    // must be enforced before the rule runs.
    if (authIndex === -1) {
      return 'no handler carrying the auth marker (authMiddleware) is present before the rule';
    }
    if (authIndex >= ruleIndex) {
      return `authMiddleware (index ${authIndex}) does not come before the rule (index ${ruleIndex})`;
    }
  }

  // In every case — public included — the rule must not be the last thing
  // in the stack; something has to actually handle the request afterwards.
  if (ruleIndex >= stackLength - 1) {
    return 'the rule is the last handler in the stack (nothing runs after it)';
  }

  return null;
}

module.exports = { checkRouteOrdering };
