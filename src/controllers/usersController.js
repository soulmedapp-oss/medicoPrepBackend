const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Role = require('../models/Role');
const { sanitizeUser, sanitizePublicUser } = require('../utils/userUtils');
const { isValidEmail, isValidPhone, isValidTextLength } = require('../utils/validation');
const { capLimit } = require('../utils/security');
const { canAny } = require('../rbac/can');
const { missingUpdatePermissions } = require('../rbac/updatePermissions');
const { collectRoleNames, primaryRole, normalizeRoleName } = require('../rbac/resolvePermissions');
const { loadPermissions } = require('../rbac/loadPermissions');
const { checkUserRolesChange, checkUserDeactivation } = require('../rbac/lockout');
const { missingForRoleGrant } = require('../rbac/escalation');
const { countActiveAdmins } = require('../rbac/countActiveAdmins');
const { recordAudit } = require('../utils/audit');

const ESCALATION_ERROR = 'You cannot grant permissions you do not hold.';

// Fix round 1, Finding 15: shared by createUser and setUserRoles so the role
// resolution + no-escalation check (spec 6.4 rules 1/2/3, addendum B.1/B.2/
// B.4) exists in exactly one place. `existingRoleNames` is the target's
// CURRENT normalised roles ([] for a brand-new user in createUser).
// Returns `{ refusal: { status, body } }` on any refusal, or
// `{ requestedNames, finalRoles }` on success.
async function resolveRequestedRoles(req, existingRoleNames) {
  const data = req.body || {};
  if (data.roles !== undefined && !Array.isArray(data.roles)) {
    return { refusal: { status: 400, body: { error: 'roles must be an array' } } };
  }
  const requestedNames = Array.from(new Set((data.roles || []).map(normalizeRoleName).filter(Boolean)));
  let roleDocs = [];
  if (requestedNames.length > 0) {
    roleDocs = await Role.find({ name: { $in: requestedNames }, is_active: true }).lean();
    const foundNames = new Set(roleDocs.map((r) => normalizeRoleName(r.name)));
    const unknownNames = requestedNames.filter((name) => !foundNames.has(name));
    if (unknownNames.length > 0) {
      return { refusal: { status: 400, body: { error: `Unknown or inactive role(s): ${unknownNames.join(', ')}` } } };
    }
  }
  // An empty list falls back to student (spec 6.3 rule 5). `student` is the
  // baseline every account gets — it's also the sign-up default, and the
  // Admin Users form sends `roles` explicitly — so it stays EXEMPT from the
  // no-escalation gate below (ruled, item 13 of fix round 1): gating it
  // would stop a delegated role manager from creating a plain student. The
  // cost: a role manager can hand someone the student pages even if they
  // lack one themselves.
  const finalRoles = requestedNames.length > 0 ? requestedNames : ['student'];
  const addedRoleNames = finalRoles.filter((name) => name !== 'student' && !existingRoleNames.includes(name));
  const addsOrRemovesAdmin = finalRoles.includes('admin') !== existingRoleNames.includes('admin');

  const actorIsAdmin = Array.isArray(req.user?.role_names) && req.user.role_names.includes('admin');
  const addedRoleDocs = roleDocs.filter((doc) => normalizeRoleName(doc.name) !== 'admin' && addedRoleNames.includes(normalizeRoleName(doc.name)));
  const missingGrant = missingForRoleGrant({
    actorPermissions: req.user?.effective_permissions,
    actorIsAdmin,
    addedRoleDocs,
    addsOrRemovesAdmin,
  });
  if (missingGrant) {
    // Fix round 1, Finding 9: adding/removing admin is an IDENTITY check
    // (spec 6.4 rule 2), not a coverage one — no permission code would help,
    // so `required` is honestly empty.
    if (missingGrant.adminOnly) {
      return { refusal: { status: 403, body: { error: 'Only an admin can add or remove the admin role.', required: [] } } };
    }
    return { refusal: { status: 403, body: { error: ESCALATION_ERROR, required: missingGrant } } };
  }
  return { requestedNames, finalRoles };
}

function createUsersController() {
  async function listUsers(req, res) {
    try {
      const { role } = req.query;
      const filter = {};
      // Addendum D: CanAssignUserRoles also widens this — the User Roles page
      // is guarded by CanAssignUserRoles alone and needs the full user list
      // to assign roles to, even for a caller who cannot open the Users page.
      // The 403 below still names only CanViewUsers (unchanged contract).
      const canManageUsers = canAny(req.user, ['CanViewUsers', 'CanAssignUserRoles']);

      if (!canManageUsers) {
        if (role && role !== 'teacher') {
          return res.status(403).json({ error: 'Permission denied', required: ['CanViewUsers'] });
        }
        filter.$or = [
          { role: 'teacher' },
          { roles: 'teacher' },
          { is_teacher: true },
        ];
        filter.is_active = true;
      } else if (role) {
        filter.$or = [{ role }, { roles: role }];
      }

      // Admin screens load the full directory, so the default/cap is higher here.
      const max = capLimit(req.query.limit, 1000, 1000);
      const records = await User.find(filter).sort({ created_date: -1 }).limit(max).lean();
      const users = records.map(canManageUsers ? sanitizeUser : sanitizePublicUser);
      return res.json({ users });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load users' });
    }
  }

  async function createUser(req, res) {
    try {
      const data = req.body || {};
      if (!data.email || !data.full_name) {
        return res.status(400).json({ error: 'email and full_name are required' });
      }
      if (!isValidEmail(String(data.email))) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      if (!isValidTextLength(String(data.full_name), 2, 120)) {
        return res.status(400).json({ error: 'full_name must be between 2 and 120 characters' });
      }
      if (data.password && (typeof data.password !== 'string' || data.password.length < 6)) {
        return res.status(400).json({ error: 'password must be at least 6 characters' });
      }

      const existing = await User.findOne({ email: data.email });
      if (existing) {
        return res.status(409).json({ error: 'Email already exists' });
      }

      // Fix round 1, Finding 15: role resolution + no-escalation (addendum
      // B.4, same rule as PUT /users/:id/roles) is shared with setUserRoles
      // via resolveRequestedRoles — a brand-new user has no existing roles.
      const resolved = await resolveRequestedRoles(req, []);
      if (resolved.refusal) return res.status(resolved.refusal.status).json(resolved.refusal.body);
      // E: default to student; no per-user `permissions` field is written any more.
      const { finalRoles } = resolved;

      const userPayload = {
        email: data.email,
        full_name: data.full_name,
        role: primaryRole(finalRoles),
        roles: finalRoles,
        is_teacher: finalRoles.includes('teacher'),
        admin_status: data.admin_status || 'active',
        subscription_plan: data.subscription_plan || 'free',
        email_verified: data.email_verified ?? true,
        is_active: data.is_active ?? true,
      };

      if (data.password) {
        userPayload.passwordHash = await bcrypt.hash(data.password, 10);
      }

      if (userPayload.email_verified) {
        userPayload.email_verified_at = new Date();
        userPayload.email_verification_token = undefined;
        userPayload.email_verification_expires = undefined;
      }

      const user = await User.create(userPayload);
      await recordAudit(req, { action: 'user.created', target_type: 'user', target_id: user._id, target_label: user.full_name || user.email, after: { email: user.email, full_name: user.full_name, roles: user.roles } });
      return res.status(201).json({ user: sanitizeUser(user) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }

  async function setUserRoles(req, res) {
    try {
      const targetUser = await User.findById(req.params.id);
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      const beforeRoles = collectRoleNames(targetUser);

      // Fix round 1, Finding 15: role resolution + no-escalation (spec 6.4
      // rules 1/2, addendum B.1/B.2) is shared with createUser via
      // resolveRequestedRoles, against the target's CURRENT normalised roles.
      const resolved = await resolveRequestedRoles(req, beforeRoles);
      if (resolved.refusal) return res.status(resolved.refusal.status).json(resolved.refusal.body);
      const { requestedNames } = resolved;

      // Lock-out (spec 6.3 rules 3-5).
      const activeAdminCount = await countActiveAdmins();
      const lockoutCheck = checkUserRolesChange({
        actorId: req.user?._id, targetUser, newRoleNames: requestedNames, activeAdminCount,
      });
      if (!lockoutCheck.ok) {
        return res.status(409).json({ error: lockoutCheck.message });
      }

      targetUser.roles = lockoutCheck.roles;
      targetUser.role = primaryRole(lockoutCheck.roles);
      targetUser.is_teacher = lockoutCheck.roles.includes('teacher');
      await targetUser.save();
      await recordAudit(req, {
        action: 'user.roles_changed',
        target_type: 'user',
        target_id: targetUser._id,
        target_label: targetUser.full_name || targetUser.email,
        before: { roles: beforeRoles },
        after: { roles: lockoutCheck.roles },
      });

      // F: the single shared loader for a user's effective permissions.
      const { permissions } = await loadPermissions(targetUser);
      const sanitized = sanitizeUser(targetUser);
      sanitized.effective_permissions = permissions;
      return res.json({ user: sanitized });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to set user roles' });
    }
  }

  async function updateUser(req, res) {
    try {
      const existing = await User.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }
      const updates = req.body || {};
      const allowedFields = [
        'email',
        'full_name',
        'admin_status',
        'subscription_plan',
        'phone',
        'college',
        'year_of_study',
        'target_exam',
        'email_verified',
        'email_verified_by',
        'email_verified_reason',
        'is_active',
      ];

      const payload = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          payload[field] = updates[field];
        }
      }

      // Task 17 re-review, item J: check what is actually WRITTEN, not the
      // raw body — a stray key the handler discards anyway (e.g. `role`,
      // which this route ignores) must not demand CanEditUsers. `password`
      // isn't in `allowedFields` (its hash is computed further down), so it
      // is added here only for the purpose of this check, matching what will
      // really be written.
      const permissionCheckPayload = { ...payload };
      if (Object.prototype.hasOwnProperty.call(updates, 'password')) {
        permissionCheckPayload.password = updates.password;
      }
      const missing = missingUpdatePermissions(req.user, permissionCheckPayload, existing, { edit: 'CanEditUsers', deactivate: 'CanDeactivateUsers' });
      if (missing) return res.status(403).json({ error: 'Permission denied', required: missing });

      // Lock-out (spec 6.3 rules 3-4, addendum A): deactivating through this
      // route is subject to the same rules as DELETE /users/:id. Fail closed:
      // the stored state is active and the body carries an is_active that is
      // not strictly `true`.
      const wasActive = existing.is_active !== false;
      const deactivates = wasActive && Object.prototype.hasOwnProperty.call(payload, 'is_active') && payload.is_active !== true;
      if (deactivates) {
        // Only spend a query on the active-admin count when it could matter.
        const targetIsAdmin = collectRoleNames(existing).includes('admin');
        const activeAdminCount = targetIsAdmin ? await countActiveAdmins() : 0;
        const deactivationCheck = checkUserDeactivation({ actorId: req.user?._id, targetUser: existing, activeAdminCount });
        if (!deactivationCheck.ok) return res.status(409).json({ error: deactivationCheck.message });
      }

      // Fix round 1, item B: reactivating a user mirrors deleteUser's own
      // admin_status flip (active -> inactive on deactivate) — the server
      // flips it back to 'active' as a consequence of the is_active flag
      // flipping back to true, so a Deactivate-only caller can reactivate an
      // admin by sending is_active alone. This is a server-derived write, not
      // a widening of what the client may write: admin_status sent BY THE
      // CLIENT is still "another field" gated by CanEditUsers above.
      if (
        existing.is_active === false &&
        payload.is_active === true &&
        existing.admin_status === 'inactive' &&
        !Object.prototype.hasOwnProperty.call(updates, 'admin_status')
      ) {
        payload.admin_status = 'active';
      }

      if (payload.email && !isValidEmail(String(payload.email))) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      if (payload.full_name && !isValidTextLength(String(payload.full_name), 2, 120)) {
        return res.status(400).json({ error: 'full_name must be between 2 and 120 characters' });
      }
      if (payload.phone && !isValidPhone(String(payload.phone))) {
        return res.status(400).json({ error: 'Invalid phone number' });
      }

      // role/roles/permissions are never in `payload` (stripped above by
      // `allowedFields`) — role changes go through PUT /users/:id/roles (Task 10).

      if (updates.password) {
        if (typeof updates.password !== 'string' || updates.password.length < 6) {
          return res.status(400).json({ error: 'password must be at least 6 characters' });
        }
        payload.passwordHash = await bcrypt.hash(updates.password, 10);
      }

      if (updates.email_verified === true) {
        payload.email_verified_at = new Date();
        payload.email_verification_token = undefined;
        payload.email_verification_expires = undefined;
        if (!payload.email_verified_by && req.user?.email) {
          payload.email_verified_by = req.user.email;
        }
      }
      if (updates.email_verified === false) {
        payload.email_verified_at = undefined;
        payload.email_verified_by = undefined;
        payload.email_verified_reason = undefined;
      }

      const updateOps = { $set: payload };
      if (payload.passwordHash) {
        // Admin password change revokes the user's existing sessions.
        updateOps.$inc = { token_version: 1 };
      }
      const user = await User.findByIdAndUpdate(
        req.params.id,
        updateOps,
        { new: true }
      );

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Addendum A: a PATCH that turns is_active from active to false is
      // user.deactivated (target_* only); any other successful PATCH —
      // including a reactivation, which has no dedicated action — is
      // user.updated, with before/after limited to whichever of the
      // handler's allowed fields actually changed (addendum B: never the
      // raw body, and never password/passwordHash — a password change is
      // recorded as `after: { password_changed: true }` instead).
      const isActiveNow = user.is_active !== false;
      if (wasActive && !isActiveNow) {
        await recordAudit(req, { action: 'user.deactivated', target_type: 'user', target_id: user._id, target_label: user.full_name || user.email });
      } else {
        // Fix round 1, Minor 3 (ruled, documented not changed): unlike roles
        // (Important 2), this stays guarded on changedKeys.length — a PATCH
        // whose only effect is a server-set field outside allowedFields
        // (e.g. email_verified_at) or that re-sends an identical value
        // writes no entry. Accepted as-is: users have no "role … edited"
        // equivalent in spec 9, and the gap is narrow (no allowedFields
        // value changed means nothing user-visible changed either).
        const changedKeys = allowedFields.filter((key) => JSON.stringify(existing[key]) !== JSON.stringify(user[key]));
        const before = {}; const after = {};
        changedKeys.forEach((key) => { before[key] = existing[key]; after[key] = user[key]; });
        if (payload.passwordHash) after.password_changed = true;
        if (changedKeys.length > 0 || payload.passwordHash) {
          await recordAudit(req, { action: 'user.updated', target_type: 'user', target_id: user._id, target_label: user.full_name || user.email, before, after });
        }
      }

      return res.json({ user: sanitizeUser(user) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  }

  async function deleteUser(req, res) {
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      // Lock-out (spec 6.3 rules 3-4): nobody deactivates themselves, and the
      // last active admin cannot be deactivated. Only spend a query on the
      // active-admin count when it could matter.
      const targetIsAdmin = collectRoleNames(user).includes('admin');
      const activeAdminCount = targetIsAdmin ? await countActiveAdmins() : 0;
      const deactivationCheck = checkUserDeactivation({ actorId: req.user?._id ?? req.userId, targetUser: user, activeAdminCount });
      if (!deactivationCheck.ok) return res.status(409).json({ error: deactivationCheck.message });
      user.is_active = false;
      if (user.admin_status === 'active') {
        user.admin_status = 'inactive';
      }
      await user.save();
      await recordAudit(req, { action: 'user.deactivated', target_type: 'user', target_id: user._id, target_label: user.full_name || user.email });
      return res.json({ ok: true, user: sanitizeUser(user) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate user' });
    }
  }

  return {
    listUsers,
    createUser,
    setUserRoles,
    updateUser,
    deleteUser,
  };
}

module.exports = { createUsersController };
