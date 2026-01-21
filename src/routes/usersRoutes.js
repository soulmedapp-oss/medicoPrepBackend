const express = require('express');
const { createUsersController } = require('../controllers/usersController');

function createUsersRoutes({ authMiddleware, requireAdmin }) {
  const router = express.Router();
  const controller = createUsersController();

  router.get('/users', authMiddleware, controller.listUsers);
  router.post('/users', authMiddleware, requireAdmin, controller.createUser);
  router.patch('/users/:id', authMiddleware, requireAdmin, controller.updateUser);
  router.delete('/users/:id', authMiddleware, requireAdmin, controller.deleteUser);

  return router;
}

module.exports = createUsersRoutes;
