const Settings = require('../models/Settings');
const { decryptValue, encryptValue } = require('../utils/encryption');

const CACHE_TTL_MS = 30000;
const cache = new Map();

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function getSettingValue(key) {
  const cached = getFromCache(key);
  if (cached) return cached;
  const setting = await Settings.findOne({ key }).lean();
  if (!setting) return null;
  const value = setting.is_encrypted ? decryptValue(setting.value) : setting.value;
  const payload = { value, source: 'db' };
  setCache(key, payload);
  return payload;
}

async function setSettingValue({ key, value, encrypt = false, updatedBy }) {
  const payloadValue = encrypt ? encryptValue(value) : value;
  const setting = await Settings.findOneAndUpdate(
    { key },
    {
      $set: {
        value: payloadValue,
        is_encrypted: encrypt,
        updated_by: updatedBy,
      },
    },
    { new: true, upsert: true }
  ).lean();
  cache.delete(key);
  return setting;
}

async function clearSetting(key) {
  await Settings.deleteOne({ key });
  cache.delete(key);
}

async function getOpenAiKey() {
  const fromDb = await getSettingValue('openai_api_key');
  if (fromDb && fromDb.value) return { value: fromDb.value, source: fromDb.source };
  const envValue = process.env.OPENAI_API_KEY || '';
  if (!envValue) return { value: '', source: 'none' };
  return { value: envValue, source: 'env' };
}

module.exports = {
  getSettingValue,
  setSettingValue,
  clearSetting,
  getOpenAiKey,
};
