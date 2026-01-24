const express = require('express');
const { createSettingsController } = require('../controllers/settingsController');

function createSettingsRoutes({ authMiddleware, requireAdmin }) {
  const router = express.Router();
  const controller = createSettingsController();

  router.get('/settings/openai-key', authMiddleware, requireAdmin, controller.getOpenAiKeySetting);
  router.put('/settings/openai-key', authMiddleware, requireAdmin, controller.updateOpenAiKeySetting);

  return router;
}

module.exports = createSettingsRoutes;
