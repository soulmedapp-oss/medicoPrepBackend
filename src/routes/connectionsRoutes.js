const express = require('express');
const { createConnectionsController } = require('../controllers/connectionsController');

function createConnectionsRoutes({ authMiddleware, createNotification, isStudentUser }) {
  const router = express.Router();
  const controller = createConnectionsController({ createNotification, isStudentUser });

  router.get('/connections/requests', authMiddleware, controller.listRequests);
  router.post('/connections/request', authMiddleware, controller.createRequest);
  router.patch('/connections/requests/:id', authMiddleware, controller.updateRequest);
  router.get('/connections', authMiddleware, controller.listConnections);
  router.get('/students', authMiddleware, controller.listStudents);

  return router;
}

module.exports = createConnectionsRoutes;
