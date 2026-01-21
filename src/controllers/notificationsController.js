const Notification = require('../models/Notification');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');

function createNotificationsController({ createNotification }) {
  async function listNotifications(req, res) {
    try {
      const { limit, unread } = req.query;
      const user = await User.findById(req.userId).lean();
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const isStaff = user.role === 'admin' || user.role === 'teacher' || user.is_teacher;
      const audiences = isStaff
        ? [user.email, 'all', 'teachers']
        : [user.email, 'all', 'students'];
      const filter = { user_email: { $in: audiences } };
      if (unread === 'true') {
        filter.is_read = false;
      }

      const max = Number(limit) || 50;
      const notifications = await Notification.find(filter)
        .sort({ created_date: -1 })
        .limit(max)
        .lean();

      return res.json({ notifications });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load notifications' });
    }
  }

  async function createNotificationForUsers(req, res) {
    try {
      const data = req.body || {};
      if (!data.title || !data.message) {
        return res.status(400).json({ error: 'title and message are required' });
      }
      if (!isValidTextLength(String(data.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (!isValidTextLength(String(data.message), 1, 2000)) {
        return res.status(400).json({ error: 'message must be between 1 and 2000 characters' });
      }
      const userEmail = data.user_email || 'all';
      const notification = await createNotification({
        userEmail,
        title: data.title,
        message: data.message,
        type: data.type || 'info',
      });
      return res.status(201).json({ notification });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create notification' });
    }
  }

  async function updateNotification(req, res) {
    try {
      const notification = await Notification.findById(req.params.id);
      if (!notification) {
        return res.status(404).json({ error: 'Notification not found' });
      }
      const user = await User.findById(req.userId).lean();
      const isAdmin = user?.role === 'admin';
      if (!isAdmin && notification.user_email !== user.email && notification.user_email !== 'all') {
        return res.status(403).json({ error: 'Not authorized' });
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'is_read')) {
        notification.is_read = Boolean(req.body.is_read);
      }
      await notification.save();
      return res.json({ notification: notification.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update notification' });
    }
  }

  return {
    listNotifications,
    createNotificationForUsers,
    updateNotification,
  };
}

module.exports = { createNotificationsController };
