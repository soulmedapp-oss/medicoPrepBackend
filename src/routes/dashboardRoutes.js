const express = require('express');
const { createDashboardController } = require('../controllers/dashboardController');
const { authorize } = require('../rbac/authorize');

function createDashboardRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createDashboardController();

  router.get('/dashboard/admin', authMiddleware, authorize('CanViewAdminDashboard'), controller.getAdminDashboard);
  router.get('/dashboard/student', authMiddleware, authorize('CanAccessDashboard'), controller.getStudentDashboard);

  return router;
}

module.exports = createDashboardRoutes;
