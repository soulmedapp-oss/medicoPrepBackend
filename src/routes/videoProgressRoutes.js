const express = require('express');
const { createVideoProgressController } = require('../controllers/videoProgressController');
const { authorize } = require('../rbac/authorize');

function createVideoProgressRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createVideoProgressController();

  router.get('/video-progress', authMiddleware, authorize('CanAccessVideos'), controller.listProgress);
  router.post('/video-progress', authMiddleware, authorize('CanAccessVideos'), controller.upsertProgress);

  return router;
}

module.exports = createVideoProgressRoutes;
