const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, default: '', required: function requireOptionText() { return !this.image_url; } },
    image_url: { type: String, default: '' },
  },
  { _id: false }
);

const questionSchema = new mongoose.Schema(
  {
    test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', index: true, default: null },
    subject: { type: String },
    subject_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject' },
    question_code: { type: String, immutable: true, index: true },
    source_type: { type: String, enum: ['pyq', 'question_bank'], default: 'question_bank' },
    origin_method: { type: String, default: 'manual' },
    exam: { type: String, enum: ['', 'FMGE', 'NEET-PG', 'INI-CET'], default: '' },
    exam_year: { type: Number, default: null, min: 1950, validate: v => v == null || (Number.isInteger(v) && v <= new Date().getFullYear()) },
    topic: { type: String, default: '', maxlength: 120 },
    extraction_job_id: { type: mongoose.Schema.Types.ObjectId, immutable: true },
    extraction_draft_id: { type: String, immutable: true },
    source_question_number: { type: String },
    source_filename: { type: String },
    team_reference: { type: String, immutable: true },
    team_reference_key: { type: String, immutable: true },
    source_reference: { type: String },
    template_version: { type: Number, immutable: true },
    content_hash: { type: String, index: true },
    media: { type: [{
      asset_id: String,
      url: String,
      role: { type: String, enum: ['stem', 'option', 'explanation'] },
      option_id: String,
      confirmed: Boolean,
    }], default: [] },
    question_text: { type: String, required: true },
    question_type: { type: String, default: 'single_choice' },
    subtopic: { type: String, default: '' },
    options: { type: [optionSchema], default: [] },
    correct_answers: { type: [String], default: [] },
    explanation: { type: String },
    explanation_image_url: { type: String },
    question_image_url: { type: String, default: '' }, // figure shown with the stem (AI Path A / manual)
    difficulty: { type: String, default: 'medium' },
    marks: { type: Number, default: 1 },
    negative_marks: { type: Number, default: 0 },
    required_plan: { type: String, default: 'free' },
    is_active: { type: Boolean, default: true },
    is_through_upload: { type: Boolean, default: false },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    created_by_name: { type: String, default: '' },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by_name: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Question', questionSchema);
