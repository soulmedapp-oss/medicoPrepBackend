// Pure lock-out decisions (spec 6.3): no database access. Controllers gather
// the facts (the role doc, how many active users hold it, how many active
// admins exist) and call these; nothing is written when one refuses.
const { collectRoleNames, normalizeRoleName } = require('./resolvePermissions');

const ok = (extra = {}) => ({ ok: true, message: '', ...extra });
const no = (message) => ({ ok: false, message });
const same = (a, b) => String(a) === String(b);

// Pre-review correction: a role is a system role when its `is_system` flag
// says so OR its normalised name is `admin`/`student` — deliberate defence
// in depth so this holds even for a document whose flag is missing (a
// database that has not restarted since the flag was introduced) or was
// tampered with (e.g. a client-writable `is_system` before this fix).
function isSystemRole(role) {
  if (role?.is_system) return true;
  const name = normalizeRoleName(role?.name);
  return name === 'admin' || name === 'student';
}

function checkRoleRename({ role, newName }) {
  if (isSystemRole(role) && normalizeRoleName(newName) !== normalizeRoleName(role.name)) {
    return no(`The ${role.name} role is built in and cannot be renamed.`);
  }
  return ok();
}

function checkRoleDeactivation({ role, assignedActiveUsers }) {
  if (isSystemRole(role)) return no(`The ${role.name} role is built in and cannot be deactivated.`);
  if (assignedActiveUsers > 0) {
    return no(`This role is assigned to ${assignedActiveUsers} active user(s). Remove it from them first.`);
  }
  return ok();
}

function checkUserRolesChange({ actorId, targetUser, newRoleNames, activeAdminCount }) {
  const normalised = Array.from(new Set((newRoleNames || []).map(normalizeRoleName).filter(Boolean)));
  const roles = normalised.length > 0 ? normalised : ['student'];
  const wasAdmin = collectRoleNames(targetUser).includes('admin');
  const staysAdmin = roles.includes('admin');
  if (wasAdmin && !staysAdmin) {
    if (same(actorId, targetUser._id)) return no('You cannot remove your own admin role.');
    if (activeAdminCount <= 1) return no('This is the last active admin. Make someone else an admin first.');
  }
  return ok({ roles });
}

function checkUserDeactivation({ actorId, targetUser, activeAdminCount }) {
  if (same(actorId, targetUser._id)) return no('You cannot deactivate your own account.');
  if (collectRoleNames(targetUser).includes('admin') && activeAdminCount <= 1) {
    return no('This is the last active admin and cannot be deactivated.');
  }
  return ok();
}

module.exports = { checkRoleRename, checkRoleDeactivation, checkUserRolesChange, checkUserDeactivation, isSystemRole };
