const express = require('express');
const { createDoubtsController } = require('../controllers/doubtsController');

function createDoubtsRoutes({ authMiddleware, createNotification }) {
  const router = express.Router();
  const controller = createDoubtsController({ createNotification });

  router.get('/doubts', authMiddleware, controller.listDoubts);
  router.post('/doubts', authMiddleware, controller.createDoubt);
  router.patch('/doubts/:id', authMiddleware, controller.updateDoubt);

  return router;
}

module.exports = createDoubtsRoutes;
