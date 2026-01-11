const mongoose = require('mongoose');

const testSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    subject: { type: String, required: true },
    difficulty: { type: String, default: 'medium' },
    duration_minutes: { type: Number, default: 60 },
    total_marks: { type: Number, default: 100 },
    passing_marks: { type: Number, default: 40 },
    is_free: { type: Boolean, default: true },
    is_published: { type: Boolean, default: false },
    question_count: { type: Number, default: 0 },
    attempt_count: { type: Number, default: 0 },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Test', testSchema);
