// Pure builder for the default-role seed data server.js's ensureDefaultRoles
// applies. Separated so it can be tested without loading the app or a
// database. Seeding is INSERT-ONLY (fix round 1, item B): everything, incl.
// `permissions`, goes into $setOnInsert so an admin's edits on the Roles page
// (e.g. unticking a default permission) are never overwritten on a later
// server start / Lambda cold start.
const { DEFAULT_ROLE_PERMISSIONS } = require('./legacyMap');

const ROLE_BASE = {
  student: { description: 'Default student role', is_active: true, is_system: true },
  teacher: { description: 'Default teacher role', is_active: true },
  content_writer: { description: 'Creates and reviews question banks for teacher approval', is_active: true },
  admin: { description: 'Default admin role', is_active: true, is_system: true },
};

function defaultRoleUpserts() {
  return Object.entries(ROLE_BASE).map(([name, base]) => ({
    filter: { name },
    update: {
      $setOnInsert: {
        name,
        ...base,
        permissions: DEFAULT_ROLE_PERMISSIONS[name] || [],
      },
    },
  }));
}

module.exports = { defaultRoleUpserts };
