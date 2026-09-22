const express = require('express');
const { createTutorSessionsController } = require('../controllers/tutorSessionsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { createRateLimiter, userOrIpKey } = require('../middlewares/rateLimit');
const { authorize } = require('../rbac/authorize');

function createTutorSessionsRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ['id']);
  const controller = createTutorSessionsController();
  const tutorChatLimiter = createRateLimiter({
    name: 'tutor-chat',
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: userOrIpKey,
    message: 'Too many AI tutor questions. Please wait a minute.',
  });

  router.post('/attempts/:id/tutor', authMiddleware, authorize('CanUseAiTutor'), controller.requestTutorSession);
  router.get('/attempts/:id/tutor', authMiddleware, authorize('CanUseAiTutor'), controller.getTutorSession);
  router.post('/tutor/chat', authMiddleware, authorize('CanUseAiTutor'), tutorChatLimiter, controller.chatWithTutor);

  return router;
}

module.exports = createTutorSessionsRoutes;
