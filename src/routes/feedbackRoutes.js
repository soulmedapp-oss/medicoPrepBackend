const express = require('express');
const { createFeedbackController } = require('../controllers/feedbackController');

function createFeedbackRoutes({
  authMiddleware,
  createNotification,
  sendSupportEmail,
  broadcastFeedback,
}) {
  const router = express.Router();
  const controller = createFeedbackController({
    createNotification,
    sendSupportEmail,
    broadcastFeedback,
  });

  router.get('/feedback', authMiddleware, controller.listFeedback);
  router.post('/feedback', authMiddleware, controller.createFeedback);
  router.post('/feedback/public', controller.createPublicFeedback);
  router.patch('/feedback/:id', authMiddleware, controller.updateFeedback);

  return router;
}

module.exports = createFeedbackRoutes;
