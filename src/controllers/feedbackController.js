const Feedback = require('../models/Feedback');
const User = require('../models/User');
const { hasPermission } = require('../middlewares/auth');
const { isValidEmail, isValidPhone, isValidTextLength } = require('../utils/validation');

function createFeedbackController({ createNotification, sendSupportEmail, broadcastFeedback }) {
  async function listFeedback(req, res) {
    try {
      const { all, status, category, limit } = req.query;
      const filter = {};
      if (status) filter.status = status;
      if (category) filter.category = category;

      if (all === 'true') {
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(403).json({ error: 'Staff access required' });
        }
        if (user.role === 'admin' && !hasPermission(user, 'manage_feedback')) {
          return res.status(403).json({ error: 'Feedback access required' });
        }
      } else {
        filter.student_id = req.userId;
      }

      const max = Number(limit) || 100;
      const feedback = await Feedback.find(filter)
        .sort({ created_date: -1 })
        .limit(max)
        .lean();
      return res.json({ feedback });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load feedback' });
    }
  }

  async function createFeedback(req, res) {
    try {
      const data = req.body || {};
      if (!data.message) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (!isValidTextLength(String(data.message), 1, 4000)) {
        return res.status(400).json({ error: 'message must be between 1 and 4000 characters' });
      }
      if (data.subject && !isValidTextLength(String(data.subject), 2, 200)) {
        return res.status(400).json({ error: 'subject must be between 2 and 200 characters' });
      }

      const user = await User.findById(req.userId).lean();
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const contactEmail = data.contact_email || user.email || '';
      const contactPhone = data.contact_phone || '';
      const contactName = data.contact_name || user.full_name || '';
      if (contactEmail && !isValidEmail(String(contactEmail))) {
        return res.status(400).json({ error: 'Invalid contact_email format' });
      }
      if (contactPhone && !isValidPhone(String(contactPhone))) {
        return res.status(400).json({ error: 'Invalid contact_phone format' });
      }

      const feedback = await Feedback.create({
        student_id: user._id,
        student_email: user.email,
        student_name: user.full_name || '',
        category: data.category || 'general',
        subject: data.subject || '',
        message: data.message,
        rating: Number(data.rating) || 0,
        status: 'open',
        contact_email: contactEmail,
        contact_phone: contactPhone,
        source: data.source || 'app',
      });

      await createNotification({
        userEmail: 'teachers',
        title: 'New feedback submitted',
        message: feedback.subject || 'A student submitted feedback.',
        type: 'info',
      });

      await sendSupportEmail({
        subject: 'New support query',
        text: [
          `Source: ${feedback.source || 'app'}`,
          `Name: ${contactName || 'N/A'}`,
          `Email: ${contactEmail || 'N/A'}`,
          `Phone: ${contactPhone || 'N/A'}`,
          `Subject: ${feedback.subject || 'Feedback'}`,
          `Category: ${feedback.category || 'general'}`,
          '',
          feedback.message,
        ].join('\n'),
      });

      return res.status(201).json({ feedback });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create feedback' });
    }
  }

  async function createPublicFeedback(req, res) {
    try {
      const data = req.body || {};
      if (!data.message) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (!isValidTextLength(String(data.message), 1, 4000)) {
        return res.status(400).json({ error: 'message must be between 1 and 4000 characters' });
      }
      if (data.subject && !isValidTextLength(String(data.subject), 2, 200)) {
        return res.status(400).json({ error: 'subject must be between 2 and 200 characters' });
      }

      const contactEmail = data.contact_email || '';
      const contactPhone = data.contact_phone || '';
      if (!contactEmail && !contactPhone) {
        return res.status(400).json({ error: 'contact_email or contact_phone is required' });
      }
      if (contactEmail && !isValidEmail(String(contactEmail))) {
        return res.status(400).json({ error: 'Invalid contact_email format' });
      }
      if (contactPhone && !isValidPhone(String(contactPhone))) {
        return res.status(400).json({ error: 'Invalid contact_phone format' });
      }

      const contactName = data.contact_name || data.student_name || '';

      const feedback = await Feedback.create({
        student_id: null,
        student_email: contactEmail,
        student_name: contactName,
        category: data.category || 'general',
        subject: data.subject || 'Support query',
        message: data.message,
        rating: 0,
        status: 'open',
        contact_email: contactEmail,
        contact_phone: contactPhone,
        source: data.source || 'public',
      });

      await createNotification({
        userEmail: 'teachers',
        title: 'New support query',
        message: feedback.subject || 'A visitor submitted a support query.',
        type: 'info',
      });

      await sendSupportEmail({
        subject: 'New support query',
        text: [
          `Source: ${feedback.source || 'public'}`,
          `Name: ${contactName || 'N/A'}`,
          `Email: ${contactEmail || 'N/A'}`,
          `Phone: ${contactPhone || 'N/A'}`,
          `Subject: ${feedback.subject || 'Support query'}`,
          `Category: ${feedback.category || 'general'}`,
          '',
          feedback.message,
        ].join('\n'),
      });

      return res.status(201).json({ feedback });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create feedback' });
    }
  }

  async function updateFeedback(req, res) {
    try {
      const feedback = await Feedback.findById(req.params.id);
      if (!feedback) {
        return res.status(404).json({ error: 'Feedback not found' });
      }

      const user = await User.findById(req.userId).lean();
      const isStaff = user?.role === 'admin' || user?.role === 'teacher' || user?.is_teacher;
      const isOwner = String(feedback.student_id) === String(req.userId);
      if (!isStaff && !isOwner) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      if (user?.role === 'admin' && isStaff && !hasPermission(user, 'manage_feedback')) {
        return res.status(403).json({ error: 'Feedback access required' });
      }

      const updates = req.body || {};
      if (updates.message && !isValidTextLength(String(updates.message), 1, 4000)) {
        return res.status(400).json({ error: 'message must be between 1 and 4000 characters' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 200)) {
        return res.status(400).json({ error: 'subject must be between 2 and 200 characters' });
      }

      if (isStaff) {
        const allowed = ['status', 'admin_response', 'responded_by'];
        allowed.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(updates, field)) {
            feedback[field] = updates[field];
          }
        });
        if (updates.admin_response) {
          feedback.responded_at = new Date();
        }
      } else if (isOwner && feedback.status === 'open') {
        const allowed = ['category', 'subject', 'message', 'rating'];
        allowed.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(updates, field)) {
            feedback[field] = updates[field];
          }
        });
      }

      await feedback.save();

      if (isStaff) {
        broadcastFeedback(feedback.toObject());
      }

      if (isStaff && updates.admin_response) {
        await createNotification({
          userEmail: feedback.student_email,
          title: 'Feedback response',
          message: feedback.subject || 'Your feedback has a response.',
          type: 'info',
        });
      }

      return res.json({ feedback: feedback.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update feedback' });
    }
  }

  return {
    listFeedback,
    createFeedback,
    createPublicFeedback,
    updateFeedback,
  };
}

module.exports = { createFeedbackController };
