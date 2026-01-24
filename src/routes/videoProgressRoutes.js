const express = require('express');
const { createVideoProgressController } = require('../controllers/videoProgressController');

function createVideoProgressRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createVideoProgressController();

  router.get('/video-progress', authMiddleware, controller.listProgress);
  router.post('/video-progress', authMiddleware, controller.upsertProgress);

  return router;
}

module.exports = createVideoProgressRoutes;
