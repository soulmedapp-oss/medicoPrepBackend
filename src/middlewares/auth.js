const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Role = require('../models/Role');
const { expireSubscriptionIfNeeded } = require('../utils/subscriptionExpiry');

const { JWT_SECRET } = process.env;

// Roles that count as "staff" for class/video/doubt/feedback management gates.
// content_manager is intentionally excluded: it only gets manage_tests/manage_questions
// permission, checked separately via hasPermission() on the tests/questions routes.
const STAFF_ROLES = ['admin', 'teacher'];

function isStaffUser(user) {
  if (!user) return false;
  if (user.is_teacher) return true;
  const roleNames = Array.isArray(user.roles) && user.roles.length > 0
    ? user.roles
    : (user.role ? [user.role] : []);
  return roleNames.some((role) => STAFF_ROLES.includes(String(role || '').toLowerCase()));
}

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
    user = await expireSubscriptionIfNeeded(user);
    if (!Array.isArray(user.permissions) || user.permissions.length === 0) {
      const roleNames = Array.isArray(user.roles) && user.roles.length > 0
        ? user.roles
        : (user.role ? [user.role] : []);
      const normalized = roleNames
        .map((role) => String(role || '').toLowerCase())
        .filter(Boolean);
      if (normalized.length > 0 && !normalized.includes('admin')) {
        const roles = await Role.find({ name: { $in: normalized }, is_active: true }).lean();
        const merged = roles
          .flatMap((role) => role.permissions || [])
          .filter(Boolean);
        if (merged.length > 0) {
          user.effective_permissions = Array.from(new Set(merged));
        }
      }
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = req.user || await User.findById(req.userId).lean();
    if (!user || user.is_active === false || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify admin access' });
  }
}

async function requireStaff(req, res, next) {
  try {
    const user = req.user || await User.findById(req.userId).lean();
    if (!user || user.is_active === false || !isStaffUser(user)) {
      return res.status(403).json({ error: 'Staff access required' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify staff access' });
  }
}

function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (Array.isArray(user.permissions) && user.permissions.includes(permission)) return true;
  if (Array.isArray(user.effective_permissions) && user.effective_permissions.includes(permission)) return true;
  return false;
}

module.exports = {
  authMiddleware,
  requireAdmin,
  requireStaff,
  hasPermission,
  isStaffUser,
  STAFF_ROLES,
};
