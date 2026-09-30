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
    // The Lecture (Video) that holds this class's recording on Bunny, once the
    // Zoom ingest has created it. Students watch it on the lecture watch page.
    recording_video_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Video' },
    thumbnail_url: { type: String },
    zoom_meeting_id: { type: String },
    zoom_meeting_uuid: { type: String },
    zoom_join_url: { type: String },
    zoom_start_url: { type: String },
    zoom_recording_files: { type: Array, default: [] },
    zoom_recording_started_at: { type: Date },
    zoom_recording_completed_at: { type: Date },
    zoom_recording_password: { type: String },
    // The ingest claim. Zoom redelivers `recording.completed` whenever it does
    // not see a prompt 200, and we now answer before the ingest runs — so two
    // deliveries can overlap. The ingest claims the class with a conditional
    // findOneAndUpdate on this field being absent; the loser does nothing.
    // Unset again when a step failed, so a redelivery may retry it.
    zoom_ingest_claimed_at: { type: Date },
    is_free: { type: Boolean, default: false },
    is_published: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    status: { type: String, default: 'scheduled' },
    allowed_plans: { type: [String], default: [] },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Set together, only on a human-initiated create/update/deactivate —
    // mirrors Video.updated_by/updated_by_at (see src/models/Video.js) so the
    // admin UI's "last modified by <name>" column works the same way for
    // both Lecture Library and Manage Live Class.
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('LiveClass', liveClassSchema);
