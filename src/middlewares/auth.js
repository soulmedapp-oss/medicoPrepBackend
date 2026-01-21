const jwt = require('jsonwebtoken');
const User = require('../models/User');

const { JWT_SECRET } = process.env;

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user || user.role !== 'admin') {
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
    const user = await User.findById(req.userId).lean();
    if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
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
  return false;
}

module.exports = {
  authMiddleware,
  requireAdmin,
  requireStaff,
  hasPermission,
};
