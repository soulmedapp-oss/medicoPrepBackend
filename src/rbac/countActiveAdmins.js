// Shared by rolesController and usersController so both count "active admins"
// the same way (legacy `role: 'admin'` and the new `roles` array both count).
const User = require('../models/User');
const countActiveAdmins = () => User.countDocuments({ is_active: { $ne: false }, $or: [{ roles: 'admin' }, { role: 'admin' }] });
module.exports = { countActiveAdmins };
