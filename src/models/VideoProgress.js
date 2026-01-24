const mongoose = require('mongoose');

const videoProgressSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    video_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', required: true, index: true },
    progress_seconds: { type: Number, default: 0 },
    duration_seconds: { type: Number, default: 0 },
    progress_percent: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

videoProgressSchema.index({ user_id: 1, video_id: 1 }, { unique: true });

module.exports = mongoose.model('VideoProgress', videoProgressSchema);
