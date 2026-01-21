const express = require('express');
const { createSubscriptionsController } = require('../controllers/subscriptionsController');

function createSubscriptionsRoutes({
  authMiddleware,
  requireAdmin,
  createNotification,
  getPlansCache,
  setPlansCache,
  clearPlansCache,
}) {
  const router = express.Router();
  const controller = createSubscriptionsController({
    createNotification,
    getPlansCache,
    setPlansCache,
    clearPlansCache,
  });

  router.get('/subscription-plans', controller.listPlans);
  router.get('/subscription-plans/all', authMiddleware, requireAdmin, controller.listAllPlans);
  router.post('/subscription-plans', authMiddleware, requireAdmin, controller.createPlan);
  router.patch('/subscription-plans/:id', authMiddleware, requireAdmin, controller.updatePlan);
  router.delete('/subscription-plans/:id', authMiddleware, requireAdmin, controller.deletePlan);

  router.get('/subscriptions', authMiddleware, controller.listSubscriptions);
  router.post('/subscriptions', authMiddleware, controller.createSubscription);
  router.patch('/subscriptions/:id', authMiddleware, controller.updateSubscription);
  router.delete('/subscriptions/:id', authMiddleware, controller.deleteSubscription);

  return router;
}

module.exports = createSubscriptionsRoutes;
