const express = require('express');
const { createPaymentsController } = require('../controllers/paymentsController');

function createPaymentsRoutes({ authMiddleware, requireAdmin }) {
  const router = express.Router();
  const controller = createPaymentsController();

  router.post('/payments/order', authMiddleware, controller.createPaymentOrder);
  router.post('/payments/verify', authMiddleware, controller.verifyPayment);
  router.get('/payments', authMiddleware, controller.listPayments);
  router.patch('/payments/:id/cancel', authMiddleware, controller.cancelPayment);
  router.get('/payments/all', authMiddleware, requireAdmin, controller.listAllPayments);

  return router;
}

module.exports = createPaymentsRoutes;
