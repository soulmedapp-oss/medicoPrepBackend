const express = require('express');
const { createUsersController } = require('../controllers/usersController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize, selfService } = require('../rbac/authorize');

function createUsersRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createUsersController();

  router.get('/users', authMiddleware, selfService, controller.listUsers);
  router.post('/users', authMiddleware, authorize('CanAddUsers'), controller.createUser);
  router.put('/users/:id/roles', authMiddleware, authorize('CanAssignUserRoles'), controller.setUserRoles);
  router.patch('/users/:id', authMiddleware, authorize.any('CanEditUsers', 'CanDeactivateUsers'), controller.updateUser);
  router.delete('/users/:id', authMiddleware, authorize('CanDeactivateUsers'), controller.deleteUser);

  return router;
}

module.exports = createUsersRoutes;
