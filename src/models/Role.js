const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: '' },
    permissions: { type: [String], default: [] },
    is_active: { type: Boolean, default: true },
    is_system: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Role', roleSchema);
