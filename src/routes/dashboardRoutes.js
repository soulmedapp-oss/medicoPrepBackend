const express = require('express');
const { createDashboardController } = require('../controllers/dashboardController');

function createDashboardRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createDashboardController();

  router.get('/dashboard/admin', authMiddleware, controller.getAdminDashboard);
  router.get('/dashboard/student', authMiddleware, controller.getStudentDashboard);

  return router;
}

module.exports = createDashboardRoutes;
