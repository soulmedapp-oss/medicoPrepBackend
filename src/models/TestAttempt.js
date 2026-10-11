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
    deadline_at: { type: Date },
    exam_protocol: { type: Number },
    paper_id: { type: String, ref: 'ExamPaper' },
    answer_version: { type: Number, default: 0 },
    completion_effects_pending: { type: Boolean, default: false },
    finalize_next_run_at: Date,
    finalize_error: String,
    completed_at: { type: Date },
    total_marks: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    time_taken_seconds: { type: Number, default: 0 },
    answers: { type: [answerSchema], default: [] },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

// "My attempts" listing (user, optionally by status, newest first).
testAttemptSchema.index({ user_id: 1, status: 1, created_date: -1 });
// Per-test completed-attempt counts and stats.
testAttemptSchema.index({ test_id: 1, status: 1 });
testAttemptSchema.index({ test_id: 1, status: 1, percentage: -1, score: -1 });
// Legacy attempts are excluded: no destructive cleanup or retroactive deadlines.
testAttemptSchema.index({ test_id: 1, user_id: 1 }, {
  unique: true, name: 'one_active_protocol_attempt',
  partialFilterExpression: { status: 'in_progress', exam_protocol: 1 },
});
testAttemptSchema.index({ status: 1, exam_protocol: 1, deadline_at: 1 });
testAttemptSchema.index({ completion_effects_pending: 1, completed_at: 1 });

module.exports = mongoose.model('TestAttempt', testAttemptSchema);
