const express = require('express');
const { createVideosController } = require('../controllers/videosController');

function createVideosRoutes({ authMiddleware, requireStaff }) {
  const router = express.Router();
  const controller = createVideosController();

  router.get('/videos', authMiddleware, controller.listVideos);
  router.post('/videos', authMiddleware, requireStaff, controller.createVideo);
  router.patch('/videos/:id', authMiddleware, requireStaff, controller.updateVideo);
  router.delete('/videos/:id', authMiddleware, requireStaff, controller.deleteVideo);
  router.get('/videos/:id/ai-summary', authMiddleware, controller.getVideoSummary);
  router.post('/videos/:id/ai-chat', authMiddleware, controller.chatAboutVideo);

  return router;
}

module.exports = createVideosRoutes;
