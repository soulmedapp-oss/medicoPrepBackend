const express = require('express');
const { createSubscriptionsController } = require('../controllers/subscriptionsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize, selfService, publicRoute } = require('../rbac/authorize');

function createSubscriptionsRoutes({
  authMiddleware,
  createNotification,
  getPlansCache,
  setPlansCache,
  clearPlansCache,
}) {
  const router = express.Router();
  validateObjectIdParams(router, ["id"]);
  const controller = createSubscriptionsController({
    createNotification,
    getPlansCache,
    setPlansCache,
    clearPlansCache,
  });

  router.get('/subscription-plans', publicRoute, controller.listPlans);
  router.get('/subscription-plans/all', authMiddleware, authorize('CanViewSubscriptionPlans'), controller.listAllPlans);
  router.post('/subscription-plans', authMiddleware, authorize('CanAddSubscriptionPlans'), controller.createPlan);
  router.patch('/subscription-plans/:id', authMiddleware, authorize.any('CanEditSubscriptionPlans', 'CanDeactivateSubscriptionPlans'), controller.updatePlan);
  router.delete('/subscription-plans/:id', authMiddleware, authorize('CanDeactivateSubscriptionPlans'), controller.deletePlan);

  router.get('/subscriptions', authMiddleware, selfService, controller.listSubscriptions);
  router.post('/subscriptions', authMiddleware, authorize('CanAddSubscriptions'), controller.createSubscription);
  router.patch('/subscriptions/:id', authMiddleware, authorize('CanEditSubscriptions'), controller.updateSubscription);
  router.delete('/subscriptions/:id', authMiddleware, authorize('CanDeactivateSubscriptions'), controller.deleteSubscription);
  router.post('/subscriptions/:id/extend', authMiddleware, authorize('CanEditSubscriptions'), controller.extendSubscription);

  return router;
}

module.exports = createSubscriptionsRoutes;
