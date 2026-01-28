const Role = require('../models/Role');
const { isValidTextLength } = require('../utils/validation');

function createRolesController() {
  async function listRoles(req, res) {
    try {
      const { all } = req.query;
      const filter = all === 'true' ? {} : { is_active: true };
      const roles = await Role.find(filter).sort({ name: 1 }).lean();
      return res.json({ roles });
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
      const permissions = Array.isArray(data.permissions)
        ? data.permissions.map((p) => String(p).trim()).filter(Boolean)
        : [];
      const role = await Role.create({
        name: data.name.toLowerCase(),
        description: data.description || '',
        permissions,
      });
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
      const updates = req.body || {};
      if (updates.name && !isValidTextLength(String(updates.name), 2, 40)) {
        return res.status(400).json({ error: 'name must be between 2 and 40 characters' });
      }
      if (updates.permissions) {
        updates.permissions = Array.isArray(updates.permissions)
          ? updates.permissions.map((p) => String(p).trim()).filter(Boolean)
          : [];
      }
      const role = await Role.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }
      return res.json({ role });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update role' });
    }
  }

  async function deleteRole(req, res) {
    try {
      const role = await Role.findByIdAndUpdate(
        req.params.id,
        { $set: { is_active: false } },
        { new: true }
      ).lean();
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }
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
