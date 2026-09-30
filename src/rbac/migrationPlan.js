// Task 12: pure planning logic for the one-time legacy -> RBAC migration.
// No I/O here so it is testable without a database; scripts/migrateRbac.js
// consumes it and does the actual reads/writes.
//
// Addendum (controller, 2026-09-21) fixed two defects found in the original
// brief before this was written:
//  A. Seeding is insert-only (src/rbac/defaultRoles.js) precisely so an
//     admin's edits on the Roles page survive a server restart. This
//     planner must honour the same rule: a default role's DEFAULT_ROLE_
//     PERMISSIONS top-up is only applied when the role has never been
//     migrated (none of its stored permissions is a catalogue code), or
//     when the caller explicitly asks via `forceTopUp` (CLI --reset-defaults).
//     Otherwise a re-run would silently undo an admin unticking a default
//     permission - the same bug class the seeding fix already addressed.
//  B. Role names are identifiers: permissions are resolved by lower-cased
//     name (see resolvePermissions.js), so a legacy role document named
//     "Teacher" or "Class Manager" would silently grant nothing. The plan
//     now always returns the normalised name plus `renameFrom` (the raw
//     stored name, when it differs) so the script can rename the document.
const crypto = require('node:crypto');
const { mapLegacyPermissions, DEFAULT_ROLE_PERMISSIONS } = require('./legacyMap');
const { collectRoleNames, primaryRole, normalizeRoleName } = require('./resolvePermissions');
const { isKnownPermission } = require('./permissions');

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function planRoleMigration(roleDoc, { forceTopUp = false } = {}) {
  const rawName = roleDoc.name;
  const name = normalizeRoleName(rawName);
  const current = roleDoc.permissions || [];
  const isDefaultRole = Object.prototype.hasOwnProperty.call(DEFAULT_ROLE_PERMISSIONS, name);
  // "Never migrated" = every stored permission is either absent or still a
  // legacy string - none of them is already a catalogue code. Once a role
  // holds at least one catalogue code, it has been through this migration
  // (or an admin curated it directly) and must not be topped up again.
  const neverMigrated = !current.some(isKnownPermission);
  const shouldTopUp = name !== 'admin' && isDefaultRole && (forceTopUp || neverMigrated);
  const topUp = shouldTopUp ? (DEFAULT_ROLE_PERMISSIONS[name] || []) : [];
  const mapped = mapLegacyPermissions(current);
  const next = name === 'admin' ? [] : Array.from(new Set([...mapped, ...topUp]));
  const renameFrom = rawName !== name ? rawName : null;
  const unchanged = sameSet(current, next) && renameFrom === null;
  return unchanged ? null : { name, permissions: next, renameFrom };
}

function customRoleName(codes) {
  const hash = crypto.createHash('sha1').update([...codes].sort().join(',')).digest('hex').slice(0, 8);
  return `custom_${hash}`;
}

function planUserMigration(userDoc) {
  const names = collectRoleNames(userDoc);
  let roles = names.length > 0 ? names : ['student'];
  const perUser = Array.isArray(userDoc.permissions) ? userDoc.permissions : [];
  let customRole = null;
  if (perUser.length > 0 && !roles.includes('admin')) {
    const mapped = mapLegacyPermissions(perUser);
    if (mapped.length > 0) {
      customRole = { name: customRoleName(mapped), permissions: mapped };
      roles = Array.from(new Set([...roles, customRole.name]));
    }
  }
  // Fix round 1 (C1): primaryRole has no ranking entry for the generated
  // custom_<hash> name, so passing it `roles` unfiltered fell through to
  // "first non-student name" and returned the hash itself, silently
  // stripping student-only access. Compute the primary role from the real
  // role names only, falling back to the full list (hash included) solely
  // when that would otherwise be empty (a user whose only role IS a custom
  // one - nothing better to report).
  const primaryCandidates = roles.filter((n) => !n.startsWith('custom_'));
  const next = { roles, role: primaryRole(primaryCandidates.length > 0 ? primaryCandidates : roles), is_teacher: roles.includes('teacher'), customRole, clearPermissions: perUser.length > 0 };
  // Compare against the RAW stored roles (not a normalised copy) so a user
  // holding e.g. ['Teacher'] is recognised as needing a rewrite to
  // ['teacher'] - otherwise permissions silently fail to resolve for them
  // (addendum B).
  const stored = userDoc.roles || [];
  const unchanged = sameSet(stored, roles) && normalizeRoleName(userDoc.role) === next.role
    && Boolean(userDoc.is_teacher) === next.is_teacher && !next.clearPermissions;
  return unchanged ? null : next;
}

module.exports = { planRoleMigration, planUserMigration, customRoleName };
