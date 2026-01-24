const VideoProgress = require('../models/VideoProgress');

function createVideoProgressController() {
  async function listProgress(req, res) {
    try {
      const { video_ids } = req.query;
      const filter = { user_id: req.userId };
      if (video_ids) {
        const ids = String(video_ids)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        if (ids.length > 0) {
          filter.video_id = { $in: ids };
        }
      }
      const entries = await VideoProgress.find(filter).lean();
      return res.json({ progress: entries });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load video progress' });
    }
  }

  async function upsertProgress(req, res) {
    try {
      const { video_id, progress_seconds, duration_seconds } = req.body || {};
      if (!video_id) {
        return res.status(400).json({ error: 'video_id is required' });
      }
      const progress = Number(progress_seconds || 0);
      const duration = Number(duration_seconds || 0);
      const percent = duration > 0
        ? Math.min(100, Math.max(0, Math.round((progress / duration) * 100)))
        : 0;

      const entry = await VideoProgress.findOneAndUpdate(
        { user_id: req.userId, video_id },
        {
          $set: {
            progress_seconds: progress,
            duration_seconds: duration,
            progress_percent: percent,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();

      return res.json({ progress: entry });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update video progress' });
    }
  }

  return { listProgress, upsertProgress };
}

module.exports = { createVideoProgressController };
