const express = require('express');
const { createPaymentsController } = require('../controllers/paymentsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize, selfService } = require('../rbac/authorize');

function createPaymentsRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createPaymentsController();

  router.post('/payments/order', authMiddleware, selfService, controller.createPaymentOrder);
  router.post('/payments/verify', authMiddleware, selfService, controller.verifyPayment);
  router.get('/payments', authMiddleware, selfService, controller.listPayments);
  router.patch('/payments/:id/cancel', authMiddleware, selfService, controller.cancelPayment);
  router.get('/payments/all', authMiddleware, authorize('CanViewAllPayments'), controller.listAllPayments);

  return router;
}

module.exports = createPaymentsRoutes;
