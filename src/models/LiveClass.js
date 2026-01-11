const mongoose = require('mongoose');

const liveClassSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    subject: { type: String, required: true },
    teacher_name: { type: String, required: true },
    teacher_email: { type: String },
    scheduled_date: { type: Date, required: true },
    duration_minutes: { type: Number, default: 60 },
    meeting_link: { type: String },
    youtube_url: { type: String },
    is_free: { type: Boolean, default: false },
    is_published: { type: Boolean, default: false },
    status: { type: String, default: 'scheduled' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('LiveClass', liveClassSchema);
