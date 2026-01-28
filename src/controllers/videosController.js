const Video = require('../models/Video');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');
const { validateSubjectIfConfigured } = require('../utils/subjects');
const { requestVideoSummary, requestVideoChat } = require('../services/tutorService');
const { getOpenAiKey } = require('../services/settingsService');

function canAccessVideo(video, planName) {
  if (video.is_free) return true;
  const allowed = Array.isArray(video.allowed_plans) ? video.allowed_plans : [];
  if (allowed.length === 0) return true;
  return allowed.includes(planName);
}

function createVideosController() {
  async function loadVideoForUser(userId, videoId) {
    const video = await Video.findById(videoId).lean();
    if (!video) return { error: 'Video not found' };
    const user = await User.findById(userId).lean();
    if (!user) return { error: 'User not found' };
    const isStaff = user.role === 'admin' || user.role === 'teacher' || user.is_teacher;
    if (!isStaff) {
      if (!video.is_published || video.is_active === false) {
        return { error: 'Video not found' };
      }
      const planName = user.subscription_plan || 'free';
      if (!canAccessVideo(video, planName)) {
        return { error: 'Upgrade required', status: 403 };
      }
    }
    return { video };
  }

  async function listVideos(req, res) {
    try {
      const { all, subject, teacher_name, teacher_email } = req.query;
      const filter = {};

      if (all === 'true') {
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      } else {
        filter.is_published = true;
        filter.is_active = { $ne: false };
      }

      if (subject) {
        filter.subject = subject;
      }
      if (teacher_name) {
        filter.teacher_name = teacher_name;
      }
      if (teacher_email) {
        filter.teacher_email = teacher_email;
      }

      const videos = await Video.find(filter).sort({ created_date: -1 }).lean();
      if (all === 'true') {
        return res.json({ videos });
      }

      const user = await User.findById(req.userId).lean();
      const planName = user?.subscription_plan || 'free';
      const visible = videos.filter((video) => canAccessVideo(video, planName));
      return res.json({ videos: visible });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load videos' });
    }
  }

  async function createVideo(req, res) {
    try {
      const data = req.body || {};
      if (!data.title || !isValidTextLength(String(data.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (!data.subject || !isValidTextLength(String(data.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject is required' });
      }
      if (!data.teacher_name || !isValidTextLength(String(data.teacher_name), 2, 120)) {
        return res.status(400).json({ error: 'teacher_name is required' });
      }
      if (data.teacher_email && !isValidTextLength(String(data.teacher_email), 3, 200)) {
        return res.status(400).json({ error: 'teacher_email must be between 3 and 200 characters' });
      }
      if (data.subtopic && !isValidTextLength(String(data.subtopic), 2, 200)) {
        return res.status(400).json({ error: 'subtopic must be between 2 and 200 characters' });
      }
      if (data.order !== undefined && Number.isNaN(Number(data.order))) {
        return res.status(400).json({ error: 'order must be a number' });
      }
      if (!data.video_url || !isValidTextLength(String(data.video_url), 5, 500)) {
        return res.status(400).json({ error: 'video_url is required' });
      }
      if (data.thumbnail_url && !isValidTextLength(String(data.thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'thumbnail_url must be between 5 and 500 characters' });
      }
      if (data.card_thumbnail_url && !isValidTextLength(String(data.card_thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'card_thumbnail_url must be between 5 and 500 characters' });
      }
      if (data.transcript_url && !isValidTextLength(String(data.transcript_url), 5, 500)) {
        return res.status(400).json({ error: 'transcript_url must be between 5 and 500 characters' });
      }
      if (data.transcript_text && !isValidTextLength(String(data.transcript_text), 5, 200000)) {
        return res.status(400).json({ error: 'transcript_text is too long' });
      }

      const allowedPlans = Array.isArray(data.allowed_plans)
        ? data.allowed_plans.map((p) => String(p).trim()).filter(Boolean)
        : [];
      const isFreePlan = allowedPlans.includes('free');

      const subjectName = await validateSubjectIfConfigured(data.subject);
      const video = await Video.create({
        title: data.title,
        description: data.description || '',
        subject: subjectName,
        teacher_name: data.teacher_name,
        teacher_email: data.teacher_email || '',
        subtopic: data.subtopic || '',
        order: data.order !== undefined ? Number(data.order) : 0,
        video_url: data.video_url,
        thumbnail_url: data.thumbnail_url || '',
        card_thumbnail_url: data.card_thumbnail_url || '',
        transcript_url: data.transcript_url || '',
        transcript_text: data.transcript_text || '',
        is_published: Boolean(data.is_published),
        is_active: data.is_active !== false,
        allowed_plans: allowedPlans,
        is_free: isFreePlan,
        created_by: req.userId,
      });

      return res.status(201).json({ video });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create video' });
    }
  }

  async function updateVideo(req, res) {
    try {
      const updates = req.body || {};
      if (updates.title && !isValidTextLength(String(updates.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }
      if (updates.subject) {
        updates.subject = await validateSubjectIfConfigured(updates.subject);
      }
      if (updates.teacher_name !== undefined && !isValidTextLength(String(updates.teacher_name), 2, 120)) {
        return res.status(400).json({ error: 'teacher_name is required' });
      }
      if (updates.teacher_email && !isValidTextLength(String(updates.teacher_email), 3, 200)) {
        return res.status(400).json({ error: 'teacher_email must be between 3 and 200 characters' });
      }
      if (updates.subtopic && !isValidTextLength(String(updates.subtopic), 2, 200)) {
        return res.status(400).json({ error: 'subtopic must be between 2 and 200 characters' });
      }
      if (updates.order !== undefined && Number.isNaN(Number(updates.order))) {
        return res.status(400).json({ error: 'order must be a number' });
      }
      if (updates.video_url && !isValidTextLength(String(updates.video_url), 5, 500)) {
        return res.status(400).json({ error: 'video_url must be between 5 and 500 characters' });
      }
      if (updates.thumbnail_url && !isValidTextLength(String(updates.thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'thumbnail_url must be between 5 and 500 characters' });
      }
      if (updates.card_thumbnail_url && !isValidTextLength(String(updates.card_thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'card_thumbnail_url must be between 5 and 500 characters' });
      }
      if (updates.transcript_url && !isValidTextLength(String(updates.transcript_url), 5, 500)) {
        return res.status(400).json({ error: 'transcript_url must be between 5 and 500 characters' });
      }
      if (updates.transcript_text && !isValidTextLength(String(updates.transcript_text), 5, 200000)) {
        return res.status(400).json({ error: 'transcript_text is too long' });
      }
      if (updates.allowed_plans) {
        updates.allowed_plans = Array.isArray(updates.allowed_plans)
          ? updates.allowed_plans.map((p) => String(p).trim()).filter(Boolean)
          : [];
        updates.is_free = updates.allowed_plans.includes('free');
      }

      const video = await Video.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }
      return res.json({ video });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update video' });
    }
  }

  async function deleteVideo(req, res) {
    try {
      const video = await Video.findById(req.params.id);
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }
      video.is_active = false;
      video.is_published = false;
      await video.save();
      return res.json({ ok: true, video: video.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate video' });
    }
  }

  async function getVideoSummary(req, res) {
    try {
      const { value } = await getOpenAiKey();
      if (!value) {
        return res.status(400).json({ error: 'Tutor service is not configured' });
      }
      const { video, error, status } = await loadVideoForUser(req.userId, req.params.id);
      if (!video) {
        return res.status(status || 404).json({ error });
      }
      const summary = await requestVideoSummary(video);
      return res.json({ summary });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to generate summary' });
    }
  }

  async function chatAboutVideo(req, res) {
    try {
      const { value } = await getOpenAiKey();
      if (!value) {
        return res.status(400).json({ error: 'Tutor service is not configured' });
      }
      const { message } = req.body || {};
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }
      const { video, error, status } = await loadVideoForUser(req.userId, req.params.id);
      if (!video) {
        return res.status(status || 404).json({ error });
      }
      const answer = await requestVideoChat(message, video);
      return res.json({ answer });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to generate response' });
    }
  }

  return {
    listVideos,
    createVideo,
    updateVideo,
    deleteVideo,
    getVideoSummary,
    chatAboutVideo,
  };
}

module.exports = { createVideosController };
