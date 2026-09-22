const express = require('express');
const { createVideosController } = require('../controllers/videosController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { createRateLimiter, userOrIpKey } = require('../middlewares/rateLimit');
const { authorize } = require('../rbac/authorize');

function createVideosRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ['id']);
  const controller = createVideosController();
  const aiChatLimiter = createRateLimiter({
    name: 'video-ai-chat',
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: userOrIpKey,
    message: 'Too many AI questions. Please wait a minute.',
  });

  router.get('/videos', authMiddleware, authorize.any('CanAccessVideos', 'CanViewVideos'), controller.listVideos);
  router.post('/videos', authMiddleware, authorize('CanAddVideos'), controller.createVideo);
  router.post(
    '/videos/:id/upload-url',
    authMiddleware,
    authorize.any('CanAddVideos', 'CanEditVideos'),
    controller.createUploadUrl
  );
  router.patch('/videos/:id', authMiddleware, authorize.any('CanEditVideos', 'CanDeactivateVideos'), controller.updateVideo);
  router.delete('/videos/:id', authMiddleware, authorize('CanDeactivateVideos'), controller.deleteVideo);
  router.get('/videos/:id/ai-summary', authMiddleware, authorize.any('CanAccessVideos', 'CanViewVideos'), controller.getVideoSummary);
  router.post('/videos/:id/ai-chat', authMiddleware, authorize.any('CanAccessVideos', 'CanViewVideos'), aiChatLimiter, controller.chatAboutVideo);

  return router;
}

module.exports = createVideosRoutes;
