const Notification = require('../models/Notification');
const { capLimit } = require('../utils/security');
const { isValidTextLength } = require('../utils/validation');

function createNotificationsController({ createNotification }) {
  async function listNotifications(req, res) {
    try {
      const { limit, unread } = req.query;
      const user = req.user;

      // Which broadcast audience group ("teachers" vs "students") this
      // caller's own inbox includes — a personalization of their own
      // notifications, not a permission gate (no catalogue permission
      // represents "is a teacher"; Notifications only has
      // CanSendNotifications). Reads the already-resolved `role_names`
      // (authMiddleware/collectRoleNames) — the same staff-identity union
      // the old check approximated by hand, kept behavior-preserving.
      const roleNames = Array.isArray(user?.role_names) ? user.role_names : [];
      const isStaff = roleNames.includes('admin') || roleNames.includes('teacher');
      const audiences = isStaff
        ? [user.email, 'all', 'teachers']
        : [user.email, 'all', 'students'];
      const filter = { user_email: { $in: audiences } };
      if (unread === 'true') {
        filter.is_read = false;
      }

      const max = capLimit(limit, 50, 200);
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
      const user = req.user;
      // selfService: own records only, no admin bypass — no permission fits
      // "manage any notification" and nothing in the app relies on it (the
      // only caller, NotificationBell, marks the caller's own notifications).
      if (notification.user_email !== user.email && notification.user_email !== 'all') {
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
