const express = require('express');
const { createTutorSessionsController } = require('../controllers/tutorSessionsController');

function createTutorSessionsRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createTutorSessionsController();

  router.post('/attempts/:id/tutor', authMiddleware, controller.requestTutorSession);
  router.get('/attempts/:id/tutor', authMiddleware, controller.getTutorSession);
  router.post('/tutor/chat', authMiddleware, controller.chatWithTutor);

  return router;
}

module.exports = createTutorSessionsRoutes;
