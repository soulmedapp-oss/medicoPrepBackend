const express = require('express');
const { createFeedbackController } = require('../controllers/feedbackController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize, publicRoute } = require('../rbac/authorize');

function createFeedbackRoutes({
  authMiddleware,
  createNotification,
  sendSupportEmail,
  broadcastFeedback,
}) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createFeedbackController({
    createNotification,
    sendSupportEmail,
    broadcastFeedback,
  });

  router.get('/feedback', authMiddleware, authorize.any('CanAccessFeedback', 'CanViewAllFeedback'), controller.listFeedback);
  router.post('/feedback', authMiddleware, authorize('CanAccessFeedback'), controller.createFeedback);
  router.post('/feedback/public', publicRoute, controller.createPublicFeedback);
  router.patch('/feedback/:id', authMiddleware, authorize('CanEditFeedback'), controller.updateFeedback);

  return router;
}

module.exports = createFeedbackRoutes;
