const express = require('express');
const { createSettingsController } = require('../controllers/settingsController');
const { authorize } = require('../rbac/authorize');

function createSettingsRoutes({ authMiddleware }) {
  const router = express.Router();
  const controller = createSettingsController();

  router.get('/settings/openai-key', authMiddleware, authorize('CanViewSettings'), controller.getOpenAiKeySetting);
  router.put('/settings/openai-key', authMiddleware, authorize('CanEditSettings'), controller.updateOpenAiKeySetting);

  return router;
}

module.exports = createSettingsRoutes;
