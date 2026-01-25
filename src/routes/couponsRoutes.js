const express = require('express');
const { createCouponsController } = require('../controllers/couponsController');

function createCouponsRoutes({ authMiddleware, requireAdmin }) {
  const router = express.Router();
  const controller = createCouponsController();

  router.post('/coupons/validate', authMiddleware, controller.validateCoupon);
  router.get('/coupons', authMiddleware, requireAdmin, controller.listCoupons);
  router.post('/coupons', authMiddleware, requireAdmin, controller.createCoupon);
  router.patch('/coupons/:id', authMiddleware, requireAdmin, controller.updateCoupon);
  router.delete('/coupons/:id', authMiddleware, requireAdmin, controller.deleteCoupon);

  return router;
}

module.exports = createCouponsRoutes;
