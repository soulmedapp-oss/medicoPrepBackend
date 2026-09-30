const express = require('express');
const { createNotificationsController } = require('../controllers/notificationsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize, selfService } = require('../rbac/authorize');

function createNotificationsRoutes({ authMiddleware, createNotification }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createNotificationsController({ createNotification });

  router.get('/notifications', authMiddleware, selfService, controller.listNotifications);
  router.post('/notifications', authMiddleware, authorize('CanSendNotifications'), controller.createNotificationForUsers);
  router.patch('/notifications/:id', authMiddleware, selfService, controller.updateNotification);

  return router;
}

module.exports = createNotificationsRoutes;
