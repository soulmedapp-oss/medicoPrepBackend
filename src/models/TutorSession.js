const mongoose = require('mongoose');

const tutorItemSchema = new mongoose.Schema(
  {
    question_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    correct_answers: { type: [String], default: [] },
    user_answer: { type: [String], default: [] },
    feedback: { type: String, default: '' },
    concept_gap: { type: String, default: '' },
    next_step: { type: String, default: '' },
  },
  { _id: false }
);

const tutorSessionSchema = new mongoose.Schema(
  {
    attempt_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TestAttempt', required: true, index: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true, index: true },
    status: { type: String, default: 'pending' },
    summary: { type: String, default: '' },
    items: { type: [tutorItemSchema], default: [] },
    error_message: { type: String, default: '' },
    lease_owner: String,
    lease_until: Date,
    next_run_at: { type: Date, default: Date.now },
    processing_attempts: { type: Number, default: 0 },
    processed_question_ids: { type: [String], default: [] },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

tutorSessionSchema.index({ status: 1, next_run_at: 1, lease_until: 1 });
module.exports = mongoose.model('TutorSession', tutorSessionSchema);
