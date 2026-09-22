const Permission = require('../models/Permission');
const Role = require('../models/Role');
const { PERMISSIONS } = require('../rbac/permissions');
const { normalizeRoleName } = require('../rbac/resolvePermissions');

function createPermissionsController() {
  async function listPermissions(req, res) {
    try {
      const [permissionDocs, roleDocs] = await Promise.all([
        Permission.find({ is_active: true }).lean(),
        Role.find({ is_active: true }).lean(),
      ]);
      const activeCodes = new Set(permissionDocs.map((p) => p.code));
      // Non-admin roles that hold each code — admin's own permissions field is
      // ignored (spec 6.1: it always has everything), so it's excluded here
      // and prepended once below instead.
      const customRoles = roleDocs.filter((doc) => normalizeRoleName(doc.name) !== 'admin');

      const permissions = PERMISSIONS
        .filter((p) => activeCodes.has(p.code))
        .map((p) => {
          const roles = customRoles
            .filter((doc) => Array.isArray(doc.permissions) && doc.permissions.includes(p.code))
            .map((doc) => doc.name);
          return {
            code: p.code,
            label: p.label,
            description: p.description,
            resource: p.resource,
            roles: ['admin', ...roles],
          };
        });

      return res.json({ permissions });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load permissions' });
    }
  }

  return { listPermissions };
}

module.exports = { createPermissionsController };
