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
    video_url: {
      type: String,
      required: function required() {
        return this.provider !== 'bunny';
      },
    },
    provider: { type: String, enum: ['youtube', 'bunny'], default: 'youtube' },
    bunny_video_id: { type: String, default: '' },
    bunny_library_id: { type: String, default: '' },
    processing_status: {
      type: String,
      enum: ['uploading', 'processing', 'ready', 'failed'],
      default: 'ready',
    },
    duration_seconds: { type: Number, default: 0 },
    transcript_status: {
      type: String,
      enum: ['none', 'pending', 'ready', 'failed'],
      default: 'none',
    },
    thumbnail_url: { type: String, default: '' },
    card_thumbnail_url: { type: String, default: '' },
    transcript_text: { type: String, default: '' },
    transcript_url: { type: String, default: '' },
    is_published: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    allowed_plans: { type: [String], default: [] },
    is_free: { type: Boolean, default: false },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Set together, only on a human-initiated updateVideo call — never from
    // the Bunny webhook, refresh-status, or the upload claim/release paths,
    // all of which mutate processing_status without a person behind them.
    // Pairing them lets the UI show "last modified by <name>" against a
    // timestamp that's actually that edit, not an unrelated system write
    // that also happens to bump updated_date.
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

videoSchema.index({ provider: 1, processing_status: 1 });
// Every Bunny webhook (and the admin refresh-status endpoint) looks a video
// up by bunny_video_id alone; the compound index above doesn't serve that
// query, so without this every webhook was a collection scan.
videoSchema.index({ bunny_video_id: 1 });

module.exports = mongoose.model('Video', videoSchema);
