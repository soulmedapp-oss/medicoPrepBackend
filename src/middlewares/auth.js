const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { expireSubscriptionIfNeeded } = require('../utils/subscriptionExpiry');
const { isTokenVersionCurrent } = require('../utils/security');
const { loadPermissions } = require('../rbac/loadPermissions');
const { COOKIE, AI_TOKEN_SCOPE } = require('../auth/session');

const { JWT_SECRET } = process.env;

async function authMiddleware(req, res, next) {
  // Browsers authenticate with the HttpOnly session cookie; API clients may
  // still send a bearer header. The header wins when both are present.
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearer || req.cookies?.[COOKIE.access] || null;
  req.authVia = bearer ? 'header' : (token ? 'cookie' : null);
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // A token minted for the AI service (POST /auth/ai-token) is readable by
    // page scripts; it must never double as a session for this API.
    if (payload.scope === AI_TOKEN_SCOPE) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.userId = payload.sub;
    let user = await User.findById(req.userId).lean();
    if (!user || user.is_active === false) {
      return res.status(401).json({ error: 'Account is inactive' });
    }
    // Tokens are revoked by bumping user.token_version (password reset/change).
    // Tokens without a `tv` claim count as version 0.
    if (!isTokenVersionCurrent(payload, user)) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    user = await expireSubscriptionIfNeeded(user);
    const { roleNames, permissions } = await loadPermissions(user);
    user.role_names = roleNames;
    user.effective_permissions = permissions;
    req.user = user;
    // Every later log line for this request carries who made it. Id and
    // plan only — email is PII and is one lookup away when needed.
    if (req.log) {
      req.log = req.log.child({ userId: String(user._id), plan: user.subscription_plan });
    }
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Marker so listRoutes (Fix round 1, item B) can find where in a route's
// handler stack login is actually enforced, the same way authorize/
// selfService/publicRoute carry `.rbacRule`.
authMiddleware.rbacAuth = true;

module.exports = {
  authMiddleware,
};
