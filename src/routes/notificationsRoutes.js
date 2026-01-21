const express = require('express');
const { createNotificationsController } = require('../controllers/notificationsController');

function createNotificationsRoutes({ authMiddleware, requireAdmin, createNotification }) {
  const router = express.Router();
  const controller = createNotificationsController({ createNotification });

  router.get('/notifications', authMiddleware, controller.listNotifications);
  router.post('/notifications', authMiddleware, requireAdmin, controller.createNotificationForUsers);
  router.patch('/notifications/:id', authMiddleware, controller.updateNotification);

  return router;
}

module.exports = createNotificationsRoutes;
