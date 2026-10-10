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
  const shared = sharedBucket(env);
  if (shared) return shared;
  const configured = String(env.UPLOADS_S3_BUCKET || '').trim();
  const bucket = configured || (name ? `soulmed-${name}-uploads-thumbnails` : '');
  if (bucket.includes('{env}') && !name) throw new Error('APP_ENV is required for a bucket template');
  const resolved = bucket.replaceAll('{env}', name);
  if (resolved && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(resolved) || resolved.includes('..'))) {
    throw new Error('Invalid UPLOADS_S3_BUCKET name');
  }
  return resolved;
}

function sharedBucket(env = process.env) {
  const name = normalizeEnvironment(env.APP_ENV);
  const account = String(env.AWS_ACCOUNT_ID || '').trim();
  const template = String(env.S3_BUCKET || '').trim() || (account ? 'soulmed-{env}-{account_id}' : '');
  if (!template) return '';
  if (!name) throw new Error('APP_ENV is required for shared S3 storage');
  if (account && !/^\d{12}$/.test(account)) throw new Error('AWS_ACCOUNT_ID must contain 12 digits');
  if (template.includes('{account_id}') && !account) throw new Error('AWS_ACCOUNT_ID is required for the S3_BUCKET template');
  const bucket = template.replaceAll('{env}', name).replaceAll('{account_id}', account);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) throw new Error('Invalid S3_BUCKET');
  return bucket;
}

function uploadsPrefix(env = process.env) {
  return sharedBucket(env) ? `soulmed-${normalizeEnvironment(env.APP_ENV)}-uploads-question` : '';
}

function logDirectory(env = process.env) {
  const name = normalizeEnvironment(env.APP_ENV);
  return env.LOG_DIR ? (name ? path.join(env.LOG_DIR, name, 'backend') : env.LOG_DIR) : '';
}

module.exports = { normalizeEnvironment, uploadsBucket, uploadsPrefix, sharedBucket, logDirectory };
