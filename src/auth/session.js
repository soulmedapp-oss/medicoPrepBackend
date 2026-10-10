// Cookie-based sessions.
//
// Three cookies, set together at login and cleared together at logout:
//   mp_access  — the JWT (short-lived). HttpOnly, so a script injected into
//                the page cannot read it. Sent on every same-site request.
//   mp_refresh — an opaque random token (long-lived), stored HASHED on the
//                user, rotated on every use, SameSite=Strict.
//   mp_csrf    — a random value the frontend CAN read and must echo back in
//                the X-CSRF-Token header on every state-changing request.
//                A cross-site page can make the browser send the cookies but
//                cannot read this one, so it cannot produce the header.
//
// The browser only attaches SameSite cookies when the page and the API are
// the same site, which is why the frontend talks to the API through a
// same-origin /api path (Vite proxy in dev, Vercel rewrite in prod).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE = Object.freeze({
  access: 'mp_access',
  refresh: 'mp_refresh',
  csrf: 'mp_csrf',
});
const CSRF_HEADER = 'x-csrf-token';
// The refresh cookie's Path. The browser matches Path against the URL IT
// requests — and in front of this API that URL is `/api/auth/refresh`
// (dev proxy, Vercel rewrite), not `/auth/refresh`, so a route-scoped Path
// would silently never be sent. It defaults to `/`; HttpOnly + SameSite=
// Strict + rotation are the protections that matter, and the token is only
// ever honoured by the refresh route. Set REFRESH_COOKIE_PATH to narrow it
// when the public path is known (e.g. /api/auth/refresh).
const REFRESH_PATH = process.env.REFRESH_COOKIE_PATH || '/';

const ACCESS_TTL = process.env.JWT_EXPIRES_IN || '15m';
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 7);
// How many refresh tokens (devices/browsers) a user may hold at once. The
// oldest is dropped when a new one is issued past this.
const MAX_REFRESH_TOKENS = 10;

const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

function accessTtlMs() {
  const m = /^(\d+)([smhd])$/.exec(ACCESS_TTL);
  if (!m) return 15 * 60 * 1000;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}
const refreshTtlMs = () => REFRESH_TTL_DAYS * 86400000;

// Secure cookies are honoured on http://localhost by every modern browser,
// but not on http://<lan-ip>; so in development follow the request scheme.
function cookieBase(req) {
  return {
    httpOnly: true,
    secure: isProduction || Boolean(req?.secure),
    sameSite: 'lax',
    path: '/',
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function signAccessToken(user, normalizeTokenVersion) {
  return jwt.sign(
    { sub: String(user._id || user.id), tv: normalizeTokenVersion(user.token_version) },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

// The AI service (FastAPI, its own origin — :8100 in dev, App Runner in prod)
// cannot see the HttpOnly session cookie, so the page asks this API for a
// short-lived bearer token and sends that instead. It is readable by scripts,
// which is why it is minutes long and why authMiddleware refuses it here:
// stolen, it reaches the AI service only, and not for long. The scope rides
// in a private claim, not `aud` — PyJWT rejects an `aud` it was not told to
// expect, and the AI service verifies with the shared JWT_SECRET alone.
const AI_TOKEN_SCOPE = 'ai';
const AI_TOKEN_TTL_SECONDS = 300;

function signAiToken(user, normalizeTokenVersion = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0)) {
  // `tv` lets the AI service honour revocation (password reset, forced
  // logout) the same way authMiddleware does, instead of waiting for expiry.
  return jwt.sign(
    { sub: String(user._id || user.id), scope: AI_TOKEN_SCOPE, tv: normalizeTokenVersion(user.token_version) },
    process.env.JWT_SECRET,
    { expiresIn: AI_TOKEN_TTL_SECONDS }
  );
}

/**
 * Pure: given the user's stored refresh tokens, produce the new list after
 * issuing `newHash` — expired entries dropped, capped at MAX_REFRESH_TOKENS.
 */
function addRefreshToken(existing, newHash, now = Date.now()) {
  const alive = (existing || []).filter((t) => t && t.expires_at && new Date(t.expires_at).getTime() > now);
  alive.push({ hash: newHash, created_at: new Date(now), expires_at: new Date(now + refreshTtlMs()) });
  return alive.slice(-MAX_REFRESH_TOKENS);
}

/**
 * Pure: rotate `presentedHash`. Returns { ok, next } where `next` is the list
 * with the presented token removed and a fresh one added, or ok:false when
 * the presented token is unknown or expired (the caller must then treat the
 * session as invalid and clear cookies).
 */
function rotateRefreshToken(existing, presentedHash, newHash, now = Date.now()) {
  const list = existing || [];
  const idx = list.findIndex((t) => t && t.hash === presentedHash);
  if (idx === -1) return { ok: false, next: list };
  const entry = list[idx];
  if (!entry.expires_at || new Date(entry.expires_at).getTime() <= now) {
    return { ok: false, next: list.filter((_, i) => i !== idx) };
  }
  const remaining = list.filter((_, i) => i !== idx);
  return { ok: true, next: addRefreshToken(remaining, newHash, now) };
}

function setSessionCookies(req, res, { accessToken, refreshToken, csrfToken }) {
  const base = cookieBase(req);
  res.cookie(COOKIE.access, accessToken, { ...base, maxAge: accessTtlMs() });
  res.cookie(COOKIE.refresh, refreshToken, { ...base, sameSite: 'strict', path: REFRESH_PATH, maxAge: refreshTtlMs() });
  res.cookie(COOKIE.csrf, csrfToken, { ...base, httpOnly: false, maxAge: refreshTtlMs() });
}

function clearSessionCookies(req, res) {
  const base = cookieBase(req);
  res.clearCookie(COOKIE.access, { ...base });
  res.clearCookie(COOKIE.refresh, { ...base, sameSite: 'strict', path: REFRESH_PATH });
  res.clearCookie(COOKIE.csrf, { ...base, httpOnly: false });
}

/**
 * Pure CSRF decision for one request. Enforced only when the request is
 * authenticated by cookie (a bearer-header client cannot be driven by a
 * cross-site page, and an unauthenticated request has no session to abuse).
 *
 *   { ok: true } | { ok: false, reason }
 */
function checkCsrf({ method, cookies, headers, allowedOrigins }) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase())) return { ok: true };
  const usesCookieAuth = Boolean(cookies?.[COOKIE.access] || cookies?.[COOKIE.refresh]);
  const hasBearer = /^Bearer\s+\S+/i.test(String(headers?.authorization || ''));
  if (!usesCookieAuth || hasBearer) return { ok: true };

  const csrfCookie = cookies?.[COOKIE.csrf];
  const csrfHeader = headers?.[CSRF_HEADER];
  if (!csrfCookie || !csrfHeader || !safeEqual(csrfCookie, csrfHeader)) {
    return { ok: false, reason: 'CSRF token missing or invalid' };
  }
  // Origin (or Referer as a fallback) must be one of ours. Browsers always
  // send Origin on cross-site POSTs; a missing Origin on a same-origin
  // fetch is allowed when no allow-list is configured (development).
  const source = headers?.origin || (headers?.referer ? safeOrigin(headers.referer) : '');
  if (source && Array.isArray(allowedOrigins) && allowedOrigins.length && !allowedOrigins.includes(source)) {
    return { ok: false, reason: 'Origin not allowed' };
  }
  return { ok: true };
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  COOKIE,
  CSRF_HEADER,
  REFRESH_PATH,
  ACCESS_TTL,
  hashToken,
  randomToken,
  signAccessToken,
  AI_TOKEN_SCOPE,
  AI_TOKEN_TTL_SECONDS,
  signAiToken,
  addRefreshToken,
  rotateRefreshToken,
  setSessionCookies,
  clearSessionCookies,
  checkCsrf,
  accessTtlMs,
  refreshTtlMs,
};
