const express = require('express');
const { createDoubtsController } = require('../controllers/doubtsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize } = require('../rbac/authorize');

function createDoubtsRoutes({ authMiddleware, createNotification }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createDoubtsController({ createNotification });

  router.get('/doubts', authMiddleware, authorize.any('CanAccessDoubts', 'CanViewAllDoubts'), controller.listDoubts);
  router.post('/doubts', authMiddleware, authorize('CanAccessDoubts'), controller.createDoubt);
  router.patch('/doubts/:id', authMiddleware, authorize.any('CanAccessDoubts', 'CanAnswerDoubts'), controller.updateDoubt);

  return router;
}

module.exports = createDoubtsRoutes;
