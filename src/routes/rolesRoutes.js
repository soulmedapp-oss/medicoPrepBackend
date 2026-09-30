const express = require('express');
const { createRolesController } = require('../controllers/rolesController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize } = require('../rbac/authorize');

function createRolesRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createRolesController();

  router.get('/roles', authMiddleware, authorize.any('CanViewRoles', 'CanAssignUserRoles'), controller.listRoles);
  router.post('/roles', authMiddleware, authorize('CanAddRoles'), controller.createRole);
  router.patch('/roles/:id', authMiddleware, authorize.any('CanEditRoles', 'CanDeactivateRoles'), controller.updateRole);
  router.delete('/roles/:id', authMiddleware, authorize('CanDeactivateRoles'), controller.deleteRole);

  return router;
}

module.exports = createRolesRoutes;
