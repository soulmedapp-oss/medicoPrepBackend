const Permission = require('../models/Permission');
const Role = require('../models/Role');
const { PERMISSIONS, PERMISSION_CODES } = require('./permissions');

async function syncPermissions() {
  await Permission.bulkWrite(PERMISSIONS.map((p) => ({
    updateOne: {
      filter: { code: p.code },
      update: { $set: { label: p.label, description: p.description, resource: p.resource, is_active: true } },
      upsert: true,
    },
  })));

  const stored = await Permission.find({ is_active: true }).select('code').lean();
  const deactivated = stored.map((p) => p.code).filter((code) => !PERMISSION_CODES.has(code));
  if (deactivated.length > 0) {
    await Permission.updateMany({ code: { $in: deactivated } }, { $set: { is_active: false } });
    await Role.updateMany({ permissions: { $in: deactivated } }, { $pull: { permissions: { $in: deactivated } } });
  }
  return { upserted: PERMISSIONS.length, deactivated };
}

module.exports = { syncPermissions };
