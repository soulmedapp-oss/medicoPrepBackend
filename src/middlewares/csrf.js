const { checkCsrf } = require('../auth/session');

// Double-submit CSRF guard for cookie-authenticated, state-changing requests.
// Mounted app-wide after cookie-parser; the decision itself is pure and
// tested in src/auth/session.js. `allowedOrigins` is the same list CORS
// uses, so the two never disagree about which frontends are "ours".
function csrfProtection({ allowedOrigins = [] } = {}) {
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  return function csrfMiddleware(req, res, next) {
    const verdict = checkCsrf({ method: req.method, cookies: req.cookies, headers: req.headers, allowedOrigins: origins });
    if (verdict.ok) return next();
    return res.status(403).json({ error: verdict.reason });
  };
}

module.exports = { csrfProtection };
