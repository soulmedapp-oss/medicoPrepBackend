const mongoose = require('mongoose');

const connectionRequestSchema = new mongoose.Schema(
  {
    requester_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requester_email: { type: String, required: true, index: true },
    requester_name: { type: String, default: '' },
    target_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    target_email: { type: String, required: true, index: true },
    target_name: { type: String, default: '' },
    status: { type: String, default: 'pending' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('ConnectionRequest', connectionRequestSchema);
