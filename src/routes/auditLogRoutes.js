const express = require('express');
const { createAuditLogController } = require('../controllers/auditLogController');
const { authorize } = require('../rbac/authorize');

function createAuditLogRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createAuditLogController();

  router.get('/audit-log', authMiddleware, authorize('CanViewAuditLog'), controller.listAuditLog);

  return router;
}

module.exports = createAuditLogRoutes;
