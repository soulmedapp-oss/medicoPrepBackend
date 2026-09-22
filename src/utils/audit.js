const AuditLog = require('../models/AuditLog');

// Addendum C: redact by PATTERN, not an exact key list, so it also catches
// this codebase's real secret-shaped keys (passwordHash, openai_api_key,
// zoom_start_url, reset tokens, Authorization headers), not just the brief's
// exact SECRET_KEYS set.
const SECRET_KEY_PATTERN = /pass|secret|token|api_?key|authorization|start_url/i;

// `password_changed` is a deliberate boolean FLAG (usersController writes
// `after: { password_changed: true }` for a password change, per addendum B)
// — it is not a secret value, but its name contains "pass" and would
// otherwise be caught by SECRET_KEY_PATTERN above and turned into the string
// '[redacted]', destroying the very thing that line of the addendum asks for.
const SAFE_KEY_EXCEPTIONS = new Set(['password_changed']);

// Only a plain `{}` object (or one with no prototype) is walked/redacted.
// A Date, a Mongoose ObjectId, a Buffer, etc. have their own prototype and
// must survive unchanged — the brief's plain `Object.entries` recursion would
// otherwise turn a Date into `{}`.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSecretKey(key) {
  if (SAFE_KEY_EXCEPTIONS.has(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}

function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  // Fix round 1, Important 1: a Mongoose document/subdocument (or any class
  // instance exposing toObject) is not a plain object, so the passthrough
  // below would return it — and whatever it holds — verbatim. Walk its plain
  // form instead so any secret-shaped field inside it still gets redacted.
  // Checked before the plain-object test since Date/ObjectId/Buffer have no
  // toObject and fall through to that passthrough unchanged, as before.
  if (typeof value.toObject === 'function') return redact(value.toObject());
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, isSecretKey(k) ? '[redacted]' : redact(v)])
  );
}

// An audit failure must never fail the request it describes, and must never
// hang it either (addendum D) — AuditLog has `bufferCommands: false`, so a
// write attempted without a live connection fails immediately instead of
// buffering for mongoose's default 10s before rejecting.
async function recordAudit(req, entry) {
  try {
    await AuditLog.create({
      actor_id: req?.userId || null,
      actor_name: req?.user?.full_name || req?.user?.email || '',
      action: entry.action,
      target_type: entry.target_type || '',
      target_id: entry.target_id ? String(entry.target_id) : '',
      target_label: entry.target_label || '',
      before: redact(entry.before ?? null),
      after: redact(entry.after ?? null),
    });
  } catch (err) {
    console.error('Failed to write audit log entry', err?.message);
  }
}

// Shared by the nine PATCH routes that can flip `is_active` through an
// update, not just a dedicated delete route (Task 17): test, question,
// question_bank, class, video, coupon, subscription_plan. Compares the
// STORED is_active against the value actually WRITTEN (never the raw body)
// and, when it changed, writes `<resource>.deactivated` / `.reactivated`
// with target_* only — a PATCH that leaves is_active alone writes nothing
// (content edits are not audited in this version).
async function recordActiveStateChange(req, { resource, before, after, targetLabel }) {
  const wasActive = before?.is_active !== false;
  const isActiveNow = after?.is_active !== false;
  if (wasActive === isActiveNow) return;
  await recordAudit(req, {
    action: `${resource}.${isActiveNow ? 'reactivated' : 'deactivated'}`,
    target_type: resource,
    target_id: after?._id,
    target_label: targetLabel,
  });
}

// Shared by every dedicated DELETE/deactivate route (always fires on
// success, target_* only, no before/after) — test, question, question_bank,
// class, video, coupon, subscription_plan, subscription.
async function recordDeactivated(req, { resource, targetId, targetLabel }) {
  await recordAudit(req, {
    action: `${resource}.deactivated`,
    target_type: resource,
    target_id: targetId,
    target_label: targetLabel,
  });
}

module.exports = { recordAudit, redact, recordActiveStateChange, recordDeactivated };
