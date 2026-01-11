const mongoose = require('mongoose');

const doubtSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    student_email: { type: String, required: true, index: true },
    student_name: { type: String, default: '' },
    subject: { type: String, required: true },
    topic: { type: String, default: '' },
    question: { type: String, required: true },
    priority: { type: String, default: 'medium' },
    status: { type: String, default: 'pending' },
    image_url: { type: String, default: '' },
    answer: { type: String, default: '' },
    answer_image_url: { type: String, default: '' },
    assigned_teacher_email: { type: String, default: '' },
    assigned_teacher_name: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Doubt', doubtSchema);
