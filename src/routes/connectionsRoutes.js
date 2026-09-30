const express = require('express');
const { createConnectionsController } = require('../controllers/connectionsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize } = require('../rbac/authorize');

function createConnectionsRoutes({ authMiddleware, createNotification, isStudentUser }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createConnectionsController({ createNotification, isStudentUser });

  router.get('/connections/requests', authMiddleware, authorize('CanAccessCommunity'), controller.listRequests);
  router.post('/connections/request', authMiddleware, authorize('CanAccessCommunity'), controller.createRequest);
  router.patch('/connections/requests/:id', authMiddleware, authorize('CanAccessCommunity'), controller.updateRequest);
  router.get('/connections', authMiddleware, authorize('CanAccessCommunity'), controller.listConnections);
  router.get('/students', authMiddleware, authorize('CanAccessCommunity'), controller.listStudents);

  return router;
}

module.exports = createConnectionsRoutes;
