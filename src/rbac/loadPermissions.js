const Role = require('../models/Role');
const { collectRoleNames, resolvePermissions } = require('./resolvePermissions');

// Single place that decides a user's permissions: normalizes their role names,
// loads the role documents that matter (skipping the query for admins and for
// users with no roles at all — resolvePermissions() filters is_active itself),
// and resolves the final permission list. Used by authMiddleware and by
// authController's /auth/me + login/googleAuth payload builder so both stay
// in lockstep with a single implementation.
async function loadPermissions(user) {
  const roleNames = collectRoleNames(user);
  const roleDocs = roleNames.length > 0 && !roleNames.includes('admin')
    ? await Role.find({ name: { $in: roleNames } }).lean()
    : [];
  return { roleNames, permissions: resolvePermissions(user, roleDocs) };
}

module.exports = { loadPermissions };
