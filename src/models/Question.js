const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
  },
  { _id: false }
);

const questionSchema = new mongoose.Schema(
  {
    test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', index: true, default: null },
    subject: { type: String },
    question_text: { type: String, required: true },
    question_type: { type: String, default: 'single_choice' },
    options: { type: [optionSchema], default: [] },
    correct_answers: { type: [String], default: [] },
    explanation: { type: String },
    explanation_image_url: { type: String },
    difficulty: { type: String, default: 'medium' },
    marks: { type: Number, default: 1 },
    negative_marks: { type: Number, default: 0 },
    required_plan: { type: String, default: 'free' },
    is_active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Question', questionSchema);
