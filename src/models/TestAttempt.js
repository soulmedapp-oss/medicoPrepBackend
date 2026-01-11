const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema(
  {
    question_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    selected_options: { type: [String], default: [] },
    is_correct: { type: Boolean, default: false },
    marks_obtained: { type: Number, default: 0 },
  },
  { _id: false }
);

const testAttemptSchema = new mongoose.Schema(
  {
    test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true, index: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    user_email: { type: String, required: true },
    user_name: { type: String },
    status: { type: String, default: 'in_progress' },
    started_at: { type: Date },
    completed_at: { type: Date },
    total_marks: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    time_taken_seconds: { type: Number, default: 0 },
    answers: { type: [answerSchema], default: [] },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('TestAttempt', testAttemptSchema);
