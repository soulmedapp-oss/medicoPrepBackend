const express = require('express');
const { createPermissionsController } = require('../controllers/permissionsController');
const { authorize } = require('../rbac/authorize');

function createPermissionsRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createPermissionsController();

  router.get('/permissions', authMiddleware, authorize.any('CanViewPermissions', 'CanViewRoles'), controller.listPermissions);

  return router;
}

module.exports = createPermissionsRoutes;
