const crypto = require('crypto');

// Shared limits for user/AI-facing text.
const MAX_CHAT_MESSAGE_LENGTH = 4000;
const MAX_TRANSCRIPT_CHARS = 60000;
const MAX_CHAT_CONTEXT_CHARS = 20000;

/**
 * Constant-time string comparison. Returns false (instead of throwing) when the
 * inputs are missing or have different lengths.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Normalises a `limit` query param: falls back to `defaultValue` when missing or
 * invalid, and never exceeds `max`.
 */
function capLimit(value, defaultValue = 100, max = 200) {
  const fallback = Math.min(defaultValue, max);
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** True only for absolute http: / https: URLs. */
function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function truncateText(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated]`;
}

/** Strict 24-hex ObjectId check (mongoose.isValidObjectId also accepts any 12-char string). */
function isValidObjectId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

function normalizeTokenVersion(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Tokens issued before token_version existed carry no `tv` claim; they are
 * treated as version 0 so existing sessions keep working until the user's
 * version is bumped (password reset/change).
 */
function isTokenVersionCurrent(payload, user) {
  if (!user) return false;
  return normalizeTokenVersion(payload && payload.tv) === normalizeTokenVersion(user.token_version);
}

function maskSecret(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length < 12) return '****';
  const prefix = value.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}...${value.slice(-4)}`;
}

module.exports = {
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_TRANSCRIPT_CHARS,
  MAX_CHAT_CONTEXT_CHARS,
  safeCompare,
  capLimit,
  isHttpUrl,
  truncateText,
  isValidObjectId,
  normalizeTokenVersion,
  isTokenVersionCurrent,
  maskSecret,
};
