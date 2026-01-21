const express = require('express');
const { createTeacherRequestsController } = require('../controllers/teacherRequestsController');

function createTeacherRequestsRoutes({ authMiddleware, createNotification }) {
  const router = express.Router();
  const controller = createTeacherRequestsController({ createNotification });

  router.get('/teacher-requests', authMiddleware, controller.listTeacherRequests);
  router.post('/teacher-requests', authMiddleware, controller.createTeacherRequest);
  router.patch('/teacher-requests/:id', authMiddleware, controller.updateTeacherRequest);

  return router;
}

module.exports = createTeacherRequestsRoutes;
