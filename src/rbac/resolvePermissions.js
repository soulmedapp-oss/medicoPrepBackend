const { ALL_CODES, PERMISSION_CODES } = require('./permissions');

const ROLE_RANK = ['admin', 'teacher', 'content_manager', 'content_writer'];
const normalize = (name) => String(name || '').trim().toLowerCase();

function collectRoleNames(user) {
  if (!user) return [];
  const names = [
    ...(Array.isArray(user.roles) ? user.roles : []),
    user.role,
    user.is_teacher ? 'teacher' : null,
  ].map(normalize).filter(Boolean);
  return Array.from(new Set(names));
}

function resolvePermissions(user, roleDocs) {
  const names = collectRoleNames(user);
  if (names.includes('admin')) return [...ALL_CODES];
  const wanted = new Set(names);
  const merged = new Set();
  (roleDocs || []).forEach((doc) => {
    if (!doc || doc.is_active === false || !wanted.has(normalize(doc.name))) return;
    (doc.permissions || []).forEach((code) => {
      if (PERMISSION_CODES.has(code)) merged.add(code);
    });
  });
  return Array.from(merged);
}

function primaryRole(roleNames) {
  const names = (roleNames || []).map(normalize).filter(Boolean);
  const ranked = ROLE_RANK.find((name) => names.includes(name));
  if (ranked) return ranked;
  return names.find((name) => name !== 'student') || 'student';
}

module.exports = { collectRoleNames, resolvePermissions, primaryRole, normalizeRoleName: normalize };
