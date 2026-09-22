const mongoose = require('mongoose');

const playlistItemSchema = new mongoose.Schema(
  { lecture_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', required: true },
    order: { type: Number, default: 0 } },
  { _id: true }
);

const playlistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    // Optional browse tags; a playlist may legitimately span subjects.
    subject_ids: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subject' }], default: [] },
    allowed_plans: { type: [String], default: [] },   // empty = all plans
    is_free: { type: Boolean, default: false },
    is_published: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    items: { type: [playlistItemSchema], default: [] },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

playlistSchema.index({ is_published: 1, is_active: 1 });
playlistSchema.index({ subject_ids: 1 });
playlistSchema.index({ 'items.lecture_id': 1 });

module.exports = mongoose.model('Playlist', playlistSchema);
