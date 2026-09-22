const Role = require('../models/Role');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');
const { recordAudit } = require('../utils/audit');
const { isKnownPermission } = require('../rbac/permissions');
const { missingUpdatePermissions } = require('../rbac/updatePermissions');
const { checkRoleRename, checkRoleDeactivation, isSystemRole } = require('../rbac/lockout');
const { missingForRolePermissions } = require('../rbac/escalation');
const { normalizeRoleName } = require('../rbac/resolvePermissions');

const ESCALATION_ERROR = 'You cannot grant permissions you do not hold.';

function normalizePermissionsInput(value) {
  return Array.isArray(value) ? value.map((p) => String(p).trim()).filter(Boolean) : [];
}

// Every role that is still assigned to at least one active user, whether via
// the legacy `role` field or the `roles` array (spec 6.3 rule 2).
function countActiveUsersForRole(name) {
  return User.countDocuments({ is_active: { $ne: false }, $or: [{ roles: name }, { role: name }] });
}

function createRolesController() {
  async function listRoles(req, res) {
    try {
      const { all } = req.query;
      const filter = all === 'true' ? {} : { is_active: true };
      const roles = await Role.find(filter).sort({ name: 1 }).lean();
      // Fix round 1, Finding 2: user_count must mean the same thing as the
      // 409 deactivation message — reuse countActiveUsersForRole (roles/role
      // both count) instead of an aggregate that only looked at `roles`, or
      // a legacy `role`-only holder shows as 0 here but still blocks delete.
      const counts = await Promise.all(roles.map((role) => countActiveUsersForRole(role.name)));
      const withCounts = roles.map((role, i) => ({ ...role, user_count: counts[i] }));
      return res.json({ roles: withCounts });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load roles' });
    }
  }

  async function createRole(req, res) {
    try {
      const data = req.body || {};
      if (!data.name || !isValidTextLength(String(data.name), 2, 40)) {
        return res.status(400).json({ error: 'name must be between 2 and 40 characters' });
      }
      const name = String(data.name).trim().toLowerCase();
      // Fix round 1, Finding 7: reserved names — checked explicitly so the
      // defence does not depend on the admin/student Role document existing.
      if (isSystemRole({ name })) {
        return res.status(409).json({ error: `"${name}" is a reserved role name.` });
      }
      const permissions = normalizePermissionsInput(data.permissions);
      const unknown = permissions.filter((code) => !isKnownPermission(code));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Unknown permission code(s): ${unknown.join(', ')}` });
      }
      // No-escalation (spec 6.4 rule 3): on create, the whole permissions list counts as added.
      const missing = missingForRolePermissions({ actorPermissions: req.user?.effective_permissions, addedCodes: permissions });
      if (missing) return res.status(403).json({ error: ESCALATION_ERROR, required: missing });
      // Pre-review correction, item 1: only name/description/permissions are
      // ever taken from the client — a new role is always active and never a
      // system role, regardless of anything else in the body (`is_system`
      // above all).
      const role = await Role.create({
        // Role names are identifiers (spec 6.5): stored trimmed and lower-cased.
        name,
        description: data.description || '',
        permissions,
      });
      await recordAudit(req, { action: 'role.created', target_type: 'role', target_id: role._id, target_label: role.name, after: { name: role.name, permissions: role.permissions } });
      return res.status(201).json({ role });
    } catch (err) {
      console.error(err);
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Role already exists' });
      }
      return res.status(500).json({ error: 'Failed to create role' });
    }
  }

  async function updateRole(req, res) {
    try {
      const existing = await Role.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }
      const body = req.body || {};
      // Pre-review correction: whitelist FIRST, and use only this filtered
      // object from here on — for the permission check, the escalation
      // check, the lock-out checks, AND the write. `is_system` above all
      // (and `_id`, `created_date`, operator keys, etc.) must never be
      // client-writable: it's what the lock-out rules trust to decide
      // "system role", so a raw-body write of it was a full lock-out
      // sidestep (rename the admin role once is_system is turned off).
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(body, 'name')) updates.name = body.name;
      if (Object.prototype.hasOwnProperty.call(body, 'description')) updates.description = body.description;
      if (Object.prototype.hasOwnProperty.call(body, 'permissions')) updates.permissions = body.permissions;
      if (Object.prototype.hasOwnProperty.call(body, 'is_active')) updates.is_active = body.is_active;

      // Fix round 1, Finding 8: a body whose only keys are non-whitelisted
      // (or an empty body) used to fall through to a 200 with an empty
      // write — safe (nothing was written) but told the caller their change
      // succeeded when it did not.
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Nothing to update. Editable fields: name, description, permissions, is_active.' });
      }

      // Task 10 adds the lock-out rules for deactivating a role (system roles,
      // roles still assigned to active users) on every path, including this one.
      const missing = missingUpdatePermissions(req.user, updates, existing, { edit: 'CanEditRoles', deactivate: 'CanDeactivateRoles' });
      if (missing) return res.status(403).json({ error: 'Permission denied', required: missing });

      if (updates.name !== undefined && !isValidTextLength(String(updates.name), 2, 40)) {
        return res.status(400).json({ error: 'name must be between 2 and 40 characters' });
      }
      let permissions;
      if (updates.permissions !== undefined) {
        permissions = normalizePermissionsInput(updates.permissions);
        const unknown = permissions.filter((code) => !isKnownPermission(code));
        if (unknown.length > 0) {
          return res.status(400).json({ error: `Unknown permission code(s): ${unknown.join(', ')}` });
        }
      }

      // No-escalation (spec 6.4 rule 3): only newly ADDED codes must be ones
      // the actor holds — removing permissions is always allowed.
      // Fix round 1, Finding 1: reactivating an INACTIVE role is itself a
      // grant of its whole final permission list — an inactive role
      // contributes nothing to its holders (resolvePermissions.js), so
      // turning it back on re-grants everything at once, even when the body
      // carries no `permissions` key at all. Gate the FINAL list (the body's
      // `permissions` when present, else the stored list) instead of the
      // usual "new minus stored" diff.
      // Final review fix round 1, Critical: fail closed, mirroring the
      // `deactivates` check below — reactivating is "the request TOUCHES
      // is_active and does not explicitly keep it false", not a strict
      // equality against the literal boolean true. A strict `=== true`
      // check let a non-boolean value ("true", 1, "1", "yes" — all of which
      // Mongoose still casts to the boolean true on write) skip this gate
      // entirely while still reactivating the role underneath it.
      const reactivates = existing.is_active === false && Object.prototype.hasOwnProperty.call(updates, 'is_active') && updates.is_active !== false;
      if (reactivates) {
        const finalPermissions = permissions !== undefined ? permissions : (existing.permissions || []);
        const addedCodes = finalPermissions.filter((code) => isKnownPermission(code));
        const missingCodes = missingForRolePermissions({ actorPermissions: req.user?.effective_permissions, addedCodes });
        if (missingCodes) return res.status(403).json({ error: ESCALATION_ERROR, required: missingCodes });
      } else if (permissions !== undefined) {
        const stored = new Set(existing.permissions || []);
        const addedCodes = permissions.filter((code) => !stored.has(code));
        const missingCodes = missingForRolePermissions({ actorPermissions: req.user?.effective_permissions, addedCodes });
        if (missingCodes) return res.status(403).json({ error: ESCALATION_ERROR, required: missingCodes });
      }

      // Role names are identifiers (spec 6.5): trimmed + lower-cased, and
      // system roles (by flag OR by name — isSystemRole) can never be renamed
      // (lock-out rule 1).
      let newName;
      if (updates.name !== undefined) {
        newName = String(updates.name).trim().toLowerCase();
        const renameCheck = checkRoleRename({ role: existing, newName });
        if (!renameCheck.ok) return res.status(409).json({ error: renameCheck.message });
        // Fix round 1, Finding 7: nobody may rename a role TO a reserved
        // name (unless it is already that very role) — checked explicitly,
        // before the collision query, so the defence does not depend on the
        // admin/student Role document existing.
        if (isSystemRole({ name: newName }) && newName !== normalizeRoleName(existing.name)) {
          return res.status(409).json({ error: `"${newName}" is a reserved role name.` });
        }
      }

      // Lock-out (spec 6.3, addendum A): deactivating through this route is
      // subject to the same rules as DELETE /roles/:id.
      const wasActive = existing.is_active !== false;
      const deactivates = wasActive && Object.prototype.hasOwnProperty.call(updates, 'is_active') && updates.is_active !== true;
      if (deactivates) {
        // Fix round 1, Finding 5: use the same "system role" definition
        // (isSystemRole) as the check that follows, not the raw flag.
        const assignedActiveUsers = isSystemRole(existing) ? 0 : await countActiveUsersForRole(existing.name);
        const deactivationCheck = checkRoleDeactivation({ role: existing, assignedActiveUsers });
        if (!deactivationCheck.ok) return res.status(409).json({ error: deactivationCheck.message });
      }

      if (newName !== undefined && newName !== existing.name) {
        const collision = await Role.findOne({ name: newName, _id: { $ne: existing._id } }).lean();
        if (collision) return res.status(409).json({ error: 'A role with this name already exists' });
      }

      const setOps = { ...updates };
      if (newName !== undefined) setOps.name = newName;
      if (permissions !== undefined) setOps.permissions = permissions;

      const role = await Role.findByIdAndUpdate(
        req.params.id,
        { $set: setOps },
        { new: true }
      ).lean();
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      // Renaming a role updates every user who holds it, in the same request
      // (spec 6.5), so nobody silently loses the role's permissions.
      // Ruled, fix round 1 item 14 (Finding 3): this is not atomic (no
      // transactions on a standalone MongoDB) and the role is written FIRST
      // on purpose — a failed rename then changes nothing. Known failure
      // mode: if either User write below fails AFTER the role was renamed,
      // holders of the OLD name resolve to nothing (an inactive-equivalent
      // role) until the rename is repeated from the old name or their roles
      // are re-saved directly.
      if (newName !== undefined && newName !== existing.name) {
        await User.updateMany(
          { roles: existing.name },
          { $set: { 'roles.$[elem]': newName } },
          { arrayFilters: [{ elem: existing.name }] }
        );
        await User.updateMany({ role: existing.name }, { $set: { role: newName } });
      }

      // Addendum A: roles have no "reactivated" action — a deactivation
      // (compared against the STORED is_active, not the raw body) gets its
      // own action with target_* only; every other successful update
      // (rename, permission change, description change, or a reactivation)
      // is role.updated with before/after limited to whichever of
      // name/permissions/is_active actually changed (addendum B: never the
      // raw body). Fix round 1, Important 2: the "content edits are not
      // audited" carve-out belongs to the seven generic resources only —
      // spec 9 lists "role … edited", so a description-only PATCH still
      // writes an entry, just with before/after empty (no guard on
      // changedKeys.length here).
      const isActiveNow = role.is_active !== false;
      if (wasActive && !isActiveNow) {
        await recordAudit(req, { action: 'role.deactivated', target_type: 'role', target_id: role._id, target_label: role.name });
      } else {
        const changedKeys = ['name', 'permissions', 'is_active'].filter(
          (key) => JSON.stringify(existing[key]) !== JSON.stringify(role[key])
        );
        const before = {}; const after = {};
        changedKeys.forEach((key) => { before[key] = existing[key]; after[key] = role[key]; });
        await recordAudit(req, { action: 'role.updated', target_type: 'role', target_id: role._id, target_label: role.name, before, after });
      }

      return res.json({ role });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update role' });
    }
  }

  async function deleteRole(req, res) {
    try {
      const existing = await Role.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }
      // Lock-out (spec 6.3 rules 1 and 2): system roles and roles still
      // assigned to active users cannot be deactivated.
      // Fix round 1, Finding 5: use isSystemRole(existing), not the raw flag.
      const assignedActiveUsers = isSystemRole(existing) ? 0 : await countActiveUsersForRole(existing.name);
      const deactivationCheck = checkRoleDeactivation({ role: existing, assignedActiveUsers });
      if (!deactivationCheck.ok) return res.status(409).json({ error: deactivationCheck.message });
      const role = await Role.findByIdAndUpdate(
        req.params.id,
        { $set: { is_active: false } },
        { new: true }
      ).lean();
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }
      await recordAudit(req, { action: 'role.deactivated', target_type: 'role', target_id: role._id, target_label: role.name });
      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
  }

  return {
    listRoles,
    createRole,
    updateRole,
    deleteRole,
  };
}

module.exports = { createRolesController };
