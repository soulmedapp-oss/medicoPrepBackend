const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { sanitizeUser } = require('../utils/userUtils');
const { isValidEmail, isValidPhone, isValidTextLength } = require('../utils/validation');

function createUsersController() {
  async function listUsers(req, res) {
    try {
      const { role } = req.query;
      const filter = {};
      const user = await User.findById(req.userId).lean();
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (user.role !== 'admin' && !user.is_teacher && user.role !== 'teacher') {
        if (role === 'teacher') {
          filter.role = 'teacher';
        } else {
          filter.role = 'student';
          filter.is_teacher = { $ne: true };
        }
        filter.is_active = true;
      } else if (role) {
        filter.role = role;
      }
      const users = await User.find(filter).sort({ created_date: -1 }).lean();
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

      const userPayload = {
        email: data.email,
        full_name: data.full_name,
        role: data.role || 'student',
        permissions: data.permissions || [],
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
      return res.status(201).json({ user: sanitizeUser(user) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }

  async function updateUser(req, res) {
    try {
      const updates = req.body || {};
      const allowedFields = [
        'email',
        'full_name',
        'role',
        'permissions',
        'admin_status',
        'subscription_plan',
        'phone',
        'college',
        'year_of_study',
        'target_exam',
        'email_verified',
        'is_active',
      ];

      const payload = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          payload[field] = updates[field];
        }
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
      }

      const user = await User.findByIdAndUpdate(
        req.params.id,
        { $set: payload },
        { new: true }
      );

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json({ user: sanitizeUser(user) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  }

  async function deleteUser(req, res) {
    try {
      if (String(req.params.id) === String(req.userId)) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      user.is_active = false;
      if (user.admin_status === 'active') {
        user.admin_status = 'inactive';
      }
      await user.save();
      return res.json({ ok: true, user: sanitizeUser(user) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate user' });
    }
  }

  return {
    listUsers,
    createUser,
    updateUser,
    deleteUser,
  };
}

module.exports = { createUsersController };
