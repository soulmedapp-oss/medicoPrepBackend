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
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('TutorSession', tutorSessionSchema);
