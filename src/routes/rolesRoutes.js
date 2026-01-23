const express = require('express');
const { createRolesController } = require('../controllers/rolesController');

function createRolesRoutes({ authMiddleware, requireAdmin }) {
  const router = express.Router();
  const controller = createRolesController();

  router.get('/roles', authMiddleware, requireAdmin, controller.listRoles);
  router.post('/roles', authMiddleware, requireAdmin, controller.createRole);
  router.patch('/roles/:id', authMiddleware, requireAdmin, controller.updateRole);
  router.delete('/roles/:id', authMiddleware, requireAdmin, controller.deleteRole);

  return router;
}

module.exports = createRolesRoutes;
