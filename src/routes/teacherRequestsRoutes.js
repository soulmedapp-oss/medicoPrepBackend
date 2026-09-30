const express = require('express');
const { createTeacherRequestsController } = require('../controllers/teacherRequestsController');
const { authorize } = require('../rbac/authorize');

function createTeacherRequestsRoutes({ authMiddleware, createNotification }) {
  const router = express.Router();
  const controller = createTeacherRequestsController({ createNotification });

  router.get('/teacher-requests', authMiddleware, authorize.any('CanAccessTeacherRequests', 'CanViewAllTeacherRequests'), controller.listTeacherRequests);
  router.post('/teacher-requests', authMiddleware, authorize('CanAccessTeacherRequests'), controller.createTeacherRequest);
  router.patch('/teacher-requests/:id', authMiddleware, authorize('CanEditTeacherRequests'), controller.updateTeacherRequest);

  return router;
}

module.exports = createTeacherRequestsRoutes;
