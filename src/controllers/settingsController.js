const { isValidTextLength } = require('../utils/validation');
const { getOpenAiKey, setSettingValue, clearSetting } = require('../services/settingsService');

function createSettingsController() {
  async function getOpenAiKeySetting(req, res) {
    try {
      if (!process.env.APP_ENCRYPTION_KEY) {
        return res.status(400).json({ error: 'APP_ENCRYPTION_KEY is not configured' });
      }
      const { value, source } = await getOpenAiKey();
      return res.json({
        api_key: value || '',
        configured: Boolean(value),
        source,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load settings' });
    }
  }

  async function updateOpenAiKeySetting(req, res) {
    try {
      if (!process.env.APP_ENCRYPTION_KEY) {
        return res.status(400).json({ error: 'APP_ENCRYPTION_KEY is not configured' });
      }
      const { api_key } = req.body || {};
      if (api_key === undefined || api_key === null || String(api_key).trim() === '') {
        await clearSetting('openai_api_key');
        return res.json({ ok: true, cleared: true });
      }
      if (!isValidTextLength(String(api_key), 20, 200)) {
        return res.status(400).json({ error: 'api_key must be between 20 and 200 characters' });
      }
      await setSettingValue({
        key: 'openai_api_key',
        value: String(api_key).trim(),
        encrypt: true,
        updatedBy: req.userId,
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to update settings' });
    }
  }

  return { getOpenAiKeySetting, updateOpenAiKeySetting };
}

module.exports = { createSettingsController };
