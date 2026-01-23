const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Role = require('../models/Role');

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
    const user = await User.findById(req.userId).lean();
    if (!user || user.is_active === false) {
      return res.status(401).json({ error: 'Account is inactive' });
    }
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
    if (!user || user.is_active === false || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
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
  if (user.role === 'admin') {
    if (!Array.isArray(user.permissions) || user.permissions.length === 0) return true;
    if (user.permissions.includes(permission)) return true;
    if (permission === 'manage_feedback') return true;
    return false;
  }
  if (Array.isArray(user.permissions) && user.permissions.includes(permission)) return true;
  if (Array.isArray(user.effective_permissions) && user.effective_permissions.includes(permission)) return true;
  return false;
}

module.exports = {
  authMiddleware,
  requireAdmin,
  requireStaff,
  hasPermission,
};
