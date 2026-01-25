const mongoose = require('mongoose');

const couponRedemptionSchema = new mongoose.Schema(
  {
    coupon_code: { type: String, required: true, index: true },
    coupon_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    payment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

couponRedemptionSchema.index({ coupon_code: 1, user_id: 1 }, { unique: true });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
