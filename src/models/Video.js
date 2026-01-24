const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    subject: { type: String, required: true },
    teacher_name: { type: String, required: true },
    teacher_email: { type: String },
    subtopic: { type: String, default: '' },
    order: { type: Number, default: 0 },
    video_url: { type: String, required: true },
    thumbnail_url: { type: String, default: '' },
    card_thumbnail_url: { type: String, default: '' },
    transcript_text: { type: String, default: '' },
    transcript_url: { type: String, default: '' },
    is_published: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    allowed_plans: { type: [String], default: [] },
    is_free: { type: Boolean, default: false },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Video', videoSchema);
