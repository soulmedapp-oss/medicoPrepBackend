const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user_email: { type: String, required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, default: 'info' },
    link: { type: String, default: '' },
    is_read: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Notification', notificationSchema);
