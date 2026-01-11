const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    student_email: { type: String, required: true, index: true },
    student_name: { type: String, default: '' },
    category: { type: String, default: 'general' },
    subject: { type: String, default: '' },
    message: { type: String, required: true },
    rating: { type: Number, default: 0 },
    status: { type: String, default: 'open' },
    admin_response: { type: String, default: '' },
    responded_by: { type: String, default: '' },
    responded_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Feedback', feedbackSchema);
