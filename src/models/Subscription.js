const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    user_email: { type: String, required: true, index: true },
    user_name: { type: String, default: '' },
    plan: { type: String, required: true },
    status: { type: String, default: 'active' },
    start_date: { type: Date, required: true },
    end_date: { type: Date },
    is_active: { type: Boolean, default: true },
    // Payment that created this subscription (used to revoke it on refund).
    payment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', index: true, sparse: true },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Subscription', subscriptionSchema);
