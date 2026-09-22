const { isValidTextLength } = require('../utils/validation');
const { getOpenAiKey, setSettingValue, clearSetting } = require('../services/settingsService');
const { maskSecret } = require('../utils/security');
const { recordAudit } = require('../utils/audit');

function createSettingsController() {
  async function getOpenAiKeySetting(req, res) {
    try {
      if (!process.env.APP_ENCRYPTION_KEY) {
        return res.status(400).json({ error: 'APP_ENCRYPTION_KEY is not configured' });
      }
      const { value, source } = await getOpenAiKey();
      // Never return the stored key; only whether it exists and a masked hint.
      return res.json({
        configured: Boolean(value),
        masked: maskSecret(value),
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
        // Addendum B: no before/after value, only whether a key is configured.
        await recordAudit(req, { action: 'settings.openai_key_changed', target_type: 'settings', target_label: 'openai_api_key', after: { configured: false } });
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
      await recordAudit(req, { action: 'settings.openai_key_changed', target_type: 'settings', target_label: 'openai_api_key', after: { configured: true } });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Failed to update OpenAI key setting', err);
      return res.status(500).json({ error: 'Failed to update settings' });
    }
  }

  return { getOpenAiKeySetting, updateOpenAiKeySetting };
}

module.exports = { createSettingsController };
