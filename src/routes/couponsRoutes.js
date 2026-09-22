const express = require('express');
const { createCouponsController } = require('../controllers/couponsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize, selfService } = require('../rbac/authorize');

function createCouponsRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createCouponsController();

  router.post('/coupons/validate', authMiddleware, selfService, controller.validateCoupon);
  router.get('/coupons', authMiddleware, authorize('CanViewCoupons'), controller.listCoupons);
  router.post('/coupons', authMiddleware, authorize('CanAddCoupons'), controller.createCoupon);
  router.patch('/coupons/:id', authMiddleware, authorize.any('CanEditCoupons', 'CanDeactivateCoupons'), controller.updateCoupon);
  router.delete('/coupons/:id', authMiddleware, authorize('CanDeactivateCoupons'), controller.deleteCoupon);

  return router;
}

module.exports = createCouponsRoutes;
