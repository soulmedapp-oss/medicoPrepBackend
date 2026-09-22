// Pure no-escalation decisions (spec 6.4 / brief addendum B): no database
// access. An admin holds every permission, so none of this restricts admins.
// Each function returns null (allowed) or the list of permission codes the
// actor is missing, for the controller to put on the 403 body's `required`.
const { PERMISSION_CODES } = require('./permissions');
const { normalizeRoleName } = require('./resolvePermissions');

function missingCodes(actorPermissions, requiredCodes) {
  const held = new Set(actorPermissions || []);
  const missing = (requiredCodes || []).filter((code) => !held.has(code));
  return missing.length > 0 ? Array.from(new Set(missing)) : null;
}

// A sentinel distinct from a plain missing-codes array (Fix round 1, Finding
// 9): spec 6.4 rule 2 is an IDENTITY check ("requires the actor to be an
// admin"), not a permission-coverage check — no amount of held codes ever
// satisfies it, so there is no meaningful "missing codes" list to return.
// The controller checks `.adminOnly` to answer the dedicated 403.
const ADMIN_ONLY = { adminOnly: true };

// PUT /users/:id/roles (rules 6.4.1 and 6.4.2). `addedRoleDocs` are the role
// documents behind the roles being newly granted (the target does not
// already hold them) EXCLUDING `admin` itself — admin's permission list is
// ignored and represented instead by `addsOrRemovesAdmin`, since removing
// admin from someone isn't an "added role" but still needs the same gate.
function missingForRoleGrant({ actorPermissions, actorIsAdmin, addedRoleDocs, addsOrRemovesAdmin }) {
  if (actorIsAdmin) return null;
  // Fix round 1, Finding 11: defence in depth — refuse on the function's own
  // terms if an `admin` doc ever turns up in addedRoleDocs, regardless of
  // whether the caller also set addsOrRemovesAdmin.
  const addsAdminDoc = (addedRoleDocs || []).some((doc) => normalizeRoleName(doc?.name) === 'admin');
  if (addsOrRemovesAdmin || addsAdminDoc) return ADMIN_ONLY;
  const requiredCodes = new Set();
  (addedRoleDocs || []).forEach((doc) => {
    // Fix round 1, Finding 10: resolve a role's permissions the way the rest
    // of the system does — only codes in the catalogue count, so a stale
    // code left over from before Task 10's validation cannot permanently
    // brick a legitimate grant.
    (doc?.permissions || []).filter((code) => PERMISSION_CODES.has(code)).forEach((code) => requiredCodes.add(code));
  });
  return missingCodes(actorPermissions, Array.from(requiredCodes));
}

// POST /roles, PATCH /roles/:id (rule 6.4.3): every permission code being
// ADDED to the role (new list minus stored list; the whole list on create)
// must be one the actor holds. Removing permissions is always allowed, so
// callers only ever pass the ADDED codes here.
function missingForRolePermissions({ actorPermissions, addedCodes }) {
  return missingCodes(actorPermissions, addedCodes);
}

module.exports = { missingForRoleGrant, missingForRolePermissions };
