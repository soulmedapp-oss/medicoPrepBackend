const TestAttempt = require('../models/TestAttempt');
const User = require('../models/User');
const TutorSession = require('../models/TutorSession');
const { enqueueTutorSession, requestChatResponse } = require('../services/tutorService');

async function ensureAccess(req, attempt) {
  if (String(attempt.user_id) === String(req.userId)) return true;
  const user = await User.findById(req.userId).lean();
  return Boolean(user && (user.role === 'admin' || user.role === 'teacher' || user.is_teacher));
}

function createTutorSessionsController() {
  async function requestTutorSession(req, res) {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ error: 'Tutor service is not configured' });
      }
      const attempt = await TestAttempt.findById(req.params.id).lean();
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }
      if (attempt.status !== 'completed') {
        return res.status(400).json({ error: 'Attempt is not completed yet' });
      }
      const hasAccess = await ensureAccess(req, attempt);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const session = await enqueueTutorSession(attempt._id);
      return res.status(202).json({ session });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to start tutor session. Check server configuration.' });
    }
  }

  async function getTutorSession(req, res) {
    try {
      const attempt = await TestAttempt.findById(req.params.id).lean();
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }
      const hasAccess = await ensureAccess(req, attempt);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      let session = await TutorSession.findOne({ attempt_id: attempt._id }).lean();
      if (!session) {
        if (attempt.status !== 'completed') {
          return res.status(400).json({ error: 'Attempt is not completed yet' });
        }
        session = await enqueueTutorSession(attempt._id);
        return res.status(202).json({ session });
      }
      return res.json({ session });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load tutor session' });
    }
  }

  async function chatWithTutor(req, res) {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ error: 'Tutor service is not configured' });
      }
      const { message, context } = req.body || {};
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
      }
      const response = await requestChatResponse(message.trim(), context);
      return res.json({ reply: response });
    } catch (err) {
      return res.status(500).json({ error: 'Tutor chat failed. Check server configuration.' });
    }
  }

  return {
    requestTutorSession,
    getTutorSession,
    chatWithTutor,
  };
}

module.exports = { createTutorSessionsController };
