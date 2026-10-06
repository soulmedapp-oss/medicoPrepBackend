const path = require('path');

// APP_ENV is independent of NODE_ENV (a UAT server can run production Node).
function normalizeEnvironment(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return '';
  const name = { local: 'dev', development: 'dev', prod: 'production' }[raw] || raw;
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(name) || name.endsWith('-')) {
    throw new Error('APP_ENV must be 1-30 letters, digits or hyphens; no paths');
  }
  return name;
}

function uploadsBucket(env = process.env) {
  const name = normalizeEnvironment(env.APP_ENV);
  const configured = String(env.UPLOADS_S3_BUCKET || '').trim();
  const bucket = configured || (name ? `soulmed-${name}-uploads-thumbnails` : '');
  if (bucket.includes('{env}') && !name) throw new Error('APP_ENV is required for a bucket template');
  const resolved = bucket.replaceAll('{env}', name);
  if (resolved && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(resolved) || resolved.includes('..'))) {
    throw new Error('Invalid UPLOADS_S3_BUCKET name');
  }
  return resolved;
}

function logDirectory(env = process.env) {
  const name = normalizeEnvironment(env.APP_ENV);
  return env.LOG_DIR ? (name ? path.join(env.LOG_DIR, name, 'backend') : env.LOG_DIR) : '';
}

module.exports = { normalizeEnvironment, uploadsBucket, logDirectory };
