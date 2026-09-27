const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// Spec §5. `report_count` is kept equal to `reports.length` by the
// controller (a `$push` + `$inc` in the same atomic update) rather than by a
// pre-save hook, so it stays correct under concurrent reports.
const discussionPostSchema = new mongoose.Schema(
  {
    anchor: {
      type: { type: String, enum: ['lecture', 'question'], required: true },
      id: { type: ObjectId, required: true },
    },
    parent_id: { type: ObjectId, ref: 'DiscussionPost', default: null }, // null = top-level
    author_id: { type: ObjectId, ref: 'User', required: true, index: true },
    author_snapshot: { display_name: String, avatar_id: String },
    is_anonymous: { type: Boolean, default: false },
    body: { type: String, required: true }, // 2-2000 chars, plain text
    video_time: { type: Number, default: null }, // seconds; lecture anchors only
    upvotes: { type: [ObjectId], default: [] }, // user ids, toggle
    is_teacher_reply: { type: Boolean, default: false }, // author held CanModerateDiscussions at post time
    is_pinned: { type: Boolean, default: false }, // one per thread; set by a moderator
    is_hidden: { type: Boolean, default: false },
    hidden_by: { type: ObjectId, ref: 'User' },
    hidden_reason: { type: String, default: '' }, // 'moderator' | 'auto_reports' | 'filter'
    reports: [{ user_id: ObjectId, reason: String, at: Date }],
    report_count: { type: Number, default: 0, index: true }, // = reports.length, kept in step atomically
    edited_at: Date,
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

discussionPostSchema.index({ 'anchor.type': 1, 'anchor.id': 1, parent_id: 1, created_date: -1 });
discussionPostSchema.index({ author_id: 1, created_date: -1 });
discussionPostSchema.index({ report_count: -1, created_date: -1 }); // the report queue

module.exports = mongoose.model('DiscussionPost', discussionPostSchema, 'discussion_posts');
