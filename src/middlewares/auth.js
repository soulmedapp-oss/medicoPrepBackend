const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { expireSubscriptionIfNeeded } = require('../utils/subscriptionExpiry');
const { isTokenVersionCurrent } = require('../utils/security');
const { loadPermissions } = require('../rbac/loadPermissions');

const { JWT_SECRET } = process.env;

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
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
