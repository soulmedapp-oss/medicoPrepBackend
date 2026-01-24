const mongoose = require('mongoose');

const liveClassSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    topic_covered: { type: String, default: '' },
    subject: { type: String, required: true },
    teacher_name: { type: String, required: true },
    teacher_email: { type: String },
    scheduled_date: { type: Date, required: true },
    duration_minutes: { type: Number, default: 60 },
    meeting_link: { type: String },
    youtube_url: { type: String },
    recording_url: { type: String },
    transcript_url: { type: String },
    transcript_text: { type: String, default: '' },
    thumbnail_url: { type: String },
    zoom_meeting_id: { type: String },
    zoom_meeting_uuid: { type: String },
    zoom_join_url: { type: String },
    zoom_start_url: { type: String },
    zoom_recording_files: { type: Array, default: [] },
    zoom_recording_started_at: { type: Date },
    zoom_recording_completed_at: { type: Date },
    zoom_recording_password: { type: String },
    is_free: { type: Boolean, default: false },
    is_published: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    status: { type: String, default: 'scheduled' },
    allowed_plans: { type: [String], default: [] },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('LiveClass', liveClassSchema);
