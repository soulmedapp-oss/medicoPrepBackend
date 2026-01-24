const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, default: '' },
    is_encrypted: { type: Boolean, default: false },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Settings', settingsSchema);
