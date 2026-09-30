const { isKnownPermission } = require('./permissions');
const { canAny } = require('./can');

function build(codes) {
  if (codes.length === 0) throw new Error('authorize() needs at least one permission code');
  const unknown = codes.filter((code) => !isKnownPermission(code));
  // Fail when the route file loads, so a typo can never become a silent deny.
  if (unknown.length > 0) throw new Error(`Unknown permission code(s): ${unknown.join(', ')}`);

  const middleware = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authorization required' });
    if (canAny(req.user, codes)) return next();
    return res.status(403).json({ error: 'Permission denied', required: codes });
  };
  middleware.rbacRule = { type: 'permission', codes };
  return middleware;
}

const authorize = (code) => build(code === undefined ? [] : [code]);
authorize.any = (...codes) => build(codes);

// Login required; the controller limits data to the caller's own records.
const selfService = (req, res, next) => next();
selfService.rbacRule = { type: 'self', codes: [] };

// No login required (auth flows, webhooks, health).
const publicRoute = (req, res, next) => next();
publicRoute.rbacRule = { type: 'public', codes: [] };

module.exports = { authorize, selfService, publicRoute };
