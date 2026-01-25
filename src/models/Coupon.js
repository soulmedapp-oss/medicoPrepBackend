const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    percent_off: { type: Number, required: true },
    description: { type: String, default: '' },
    is_active: { type: Boolean, default: true },
    max_uses_total: { type: Number, default: 0 },
    max_uses_per_user: { type: Number, default: 1 },
    uses_total: { type: Number, default: 0 },
    expires_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Coupon', couponSchema);
