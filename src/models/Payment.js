const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    user_email: { type: String, required: true, index: true },
    user_name: { type: String, default: '' },
    plan: { type: String, required: true },
    base_amount: { type: Number, default: 0 },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: { type: String, default: 'created' },
    provider: { type: String, default: 'razorpay' },
    upgrade_from: { type: String, default: '' },
    // Kept non-unique on purpose: an `order_id_1` non-unique index already exists
    // in deployed DBs, so declaring unique here would fail autoIndex silently.
    // Make it unique via a one-off migration after checking for duplicates.
    // Payment processing is idempotent via atomic subscription_activated claims.
    order_id: { type: String, index: true },
    payment_id: { type: String, index: true },
    method: { type: String, default: '' },
    bank: { type: String, default: '' },
    wallet: { type: String, default: '' },
    vpa: { type: String, default: '' },
    error_code: { type: String, default: '' },
    error_description: { type: String, default: '' },
    coupon_code: { type: String, default: '' },
    discount_percent: { type: Number, default: 0 },
    discount_amount: { type: Number, default: 0 },
    paid_at: { type: Date },
    coupon_redeemed: { type: Boolean, default: false },
    subscription_activated: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Payment', paymentSchema);
