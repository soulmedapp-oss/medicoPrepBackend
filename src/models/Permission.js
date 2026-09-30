const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true },
    description: { type: String, default: '' },
    resource: { type: String, required: true, index: true },
    is_active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Permission', permissionSchema);
