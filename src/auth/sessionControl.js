const jwt = require('jsonwebtoken');
const s = require('./session');
const TAKEOVER_COOKIE = 'mp_session_confirmation';
const integer = (value, fallback, min, max) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
const enabled = value => String(value ?? 'true').trim().toLowerCase() !== 'false';
function policy(env = process.env) {
  const idleMinutes = integer(env.SESSION_IDLE_MINUTES, 20, 1, 1440);
  const warningSeconds = integer(env.SESSION_WARNING_SECONDS, 120, 15, 600);
  return { idle_minutes: idleMinutes, warning_seconds: warningSeconds, timeout_seconds: idleMinutes * 60 + warningSeconds,
    idle_timeout_enabled: enabled(env.SESSION_IDLE_TIMEOUT_ENABLED), single_device_enabled: enabled(env.SESSION_SINGLE_DEVICE_ENABLED) };
}
function deadline(active, p = policy()) {
  if (!p.idle_timeout_enabled) return new Date(active?.absolute_expires_at).getTime();
  const idle = active?.idle_timeout_enabled === false
    ? new Date(active.last_active_at).getTime() + p.timeout_seconds * 1000 : new Date(active?.expires_at).getTime();
  return Math.min(idle, new Date(active?.absolute_expires_at).getTime());
}
function live(active, now = Date.now(), p = policy()) { return Boolean(active?.id && deadline(active, p) > now); }
function records(user) {
  const tv = Number(user?.token_version || 0);
  const result = (user?.browser_sessions || []).filter(a => a?.id && Number(a.token_version) === tv);
  const legacy = user?.active_session;
  if (legacy?.id && !result.some(a => a.id === legacy.id) && (legacy.token_version == null || Number(legacy.token_version) === tv)) result.push({ ...legacy, token_version: tv });
  return result;
}
function findSession(user, sid, p = policy()) {
  if (!sid || (p.single_device_enabled && sid !== user?.active_session?.id)) return null;
  return records(user).find(a => a.id === sid) || null;
}
function current(user, sid, now = Date.now()) {
  const p = policy();
  if (!sid && !p.idle_timeout_enabled && !p.single_device_enabled) return true; // Legacy short-lived tokens still require JWT/tv validation.
  return live(findSession(user, sid, p), now, p);
}
function selectedUser(user, sid) { return { ...user, active_session: findSession(user, sid) }; }
async function privateQuery(query, refresh = true) {
  if (typeof query?.select === 'function') query = query.select('+browser_sessions +session_revision' + (refresh ? ' +refresh_tokens' : ''));
  return typeof query?.lean === 'function' ? query.lean() : query;
}
class SessionControlError extends Error {
  constructor(status, code, message, detail = {}) { super(message); this.status = status; this.code = code; this.detail = detail; }
}
function respond(error, res) {
  if (!(error instanceof SessionControlError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code, ...error.detail }); return true;
}
function createSessionControl({ User, secret = process.env.JWT_SECRET }) {
  const clear = res => res.clearCookie(TAKEOVER_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
  const fail = () => new SessionControlError(401, 'SESSION_EXPIRED', 'Your session ended. Please sign in again.');
  const revision = user => Number(user.session_revision || 0);
  async function save(user, sessions, tokens, tv = Number(user.token_version || 0), lastSeen) {
    const active = sessions.find(a => a.id === user.active_session?.id) || sessions.at(-1) || null;
    return privateQuery(User.findOneAndUpdate({ _id: user._id || user.id, is_active: { $ne: false }, $expr: { $and: [
      { $eq: [{ $ifNull: ['$token_version', 0] }, Number(user.token_version || 0)] },
      { $eq: [{ $ifNull: ['$session_revision', 0] }, revision(user)] },
    ] } }, { $set: { browser_sessions: sessions, active_session: active, refresh_tokens: tokens,
      token_version: tv, session_revision: revision(user) + 1, ...(lastSeen ? { last_seen_date: lastSeen } : {}) } }, { new: true, lean: true }));
  }
  async function claim(req, res, user, method, confirmed = false) {
    const expectedVersion = Number(user.token_version || 0);
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = Date.now(), p = policy();
      if (!user || user.is_active === false || Number(user.token_version || 0) !== expectedVersion) throw fail();
      const existing = records(user), previous = user.active_session;
      const hash = req.cookies?.[s.COOKIE.refresh] ? s.hashToken(req.cookies[s.COOKIE.refresh]) : '';
      let browserId = (user.refresh_tokens || []).find(t => t.hash === hash)?.session_id;
      try {
        const token = jwt.verify(req.cookies?.[s.COOKIE.access] || '', secret, { algorithms: ['HS256'], ignoreExpiration: true });
        if (!token.scope && token.sub === String(user._id || user.id) && token.tv === expectedVersion) browserId ||= token.sid;
      } catch { /* Credential proof is required before this method. */ }
      if (p.single_device_enabled && !confirmed && live(previous, now, p) && browserId !== previous.id) {
        const browser = s.randomToken();
        const ticket = jwt.sign({ uid: String(user._id || user.id), tv: expectedVersion, sid: previous.id, method, bh: s.hashToken(browser) }, secret,
          { algorithm: 'HS256', issuer: 'soulmed-session-confirmation', audience: 'session-takeover', expiresIn: '3m' });
        res.cookie(TAKEOVER_COOKIE, browser, { ...s.cookieBase(req), sameSite: 'strict', maxAge: 180000 });
        throw new SessionControlError(409, 'ACTIVE_SESSION', 'You are already signed in on another browser or device.',
          { ticket, device: { last_active_at: previous.last_active_at, browser: String(previous.user_agent || 'Another browser').slice(0, 180) } });
      }
      const sid = s.randomToken(24), refresh = s.randomToken(), tv = expectedVersion + (p.single_device_enabled ? 1 : 0);
      const absolute = new Date(now + s.refreshTtlMs());
      const active = { id: sid, token_version: tv, idle_timeout_enabled: p.idle_timeout_enabled, idle_minutes: p.idle_minutes, warning_seconds: p.warning_seconds,
        last_active_at: new Date(now), expires_at: p.idle_timeout_enabled ? new Date(Math.min(now + p.timeout_seconds * 1000, absolute.getTime())) : absolute,
        absolute_expires_at: absolute, user_agent: String(req.headers?.['user-agent'] || '').slice(0, 512) };
      // Preserve other browsers in multi-device mode; replace only this browser on reauthentication.
      const kept = p.single_device_enabled ? [] : existing.filter(a => a.id !== browserId && live(a, now, p));
      const next = [...kept, active];
      const ids = new Set(next.map(a => a.id));
      const tokens = [...(p.single_device_enabled ? [] : (user.refresh_tokens || []).filter(t => t.session_id !== browserId && (!t.session_id || ids.has(t.session_id)) && new Date(t.expires_at).getTime() > now)),
        { hash: s.hashToken(refresh), session_id: sid, created_at: new Date(now), expires_at: absolute }];
      // Do not evict an active device silently. An excessive account session count requires explicit sign-out.
      if (next.length > 50 || tokens.filter(t => !t.is_grace).length > 50) throw new SessionControlError(409, 'SESSION_LIMIT', 'Please sign out an unused browser before signing in again.');
      const changed = await save({ ...user, active_session: active }, next, tokens, tv);
      if (!changed) {
        user = await privateQuery(User.findById(user._id || user.id));
        if (confirmed || p.single_device_enabled) throw new SessionControlError(409, 'SESSION_CHANGED', 'Your account/session changed. Please sign in again.');
        continue;
      }
      Object.assign(user, changed); user.active_session = active;
      const token = s.signAccessToken({ ...changed, active_session: active }, v => Number(v || 0));
      s.setSessionCookies(req, res, { accessToken: token, refreshToken: refresh, csrfToken: s.randomToken(16) }); clear(res);
      return { token, user };
    }
    throw new SessionControlError(409, 'SESSION_CHANGED', 'Your account/session changed. Please sign in again.');
  }
  async function issue(req, res, user, method) {
    const fresh = await privateQuery(User.findById(user._id || user.id));
    if (!fresh || Number(fresh.token_version || 0) !== Number(user.token_version || 0)) throw fail();
    const result = await claim(req, res, fresh, method);
    user.token_version = result.user.token_version; user.active_session = result.user.active_session;
    return result.token;
  }
  async function confirm(req, res) {
    let data;
    try {
      data = jwt.verify(req.body?.ticket || '', secret, { algorithms: ['HS256'], issuer: 'soulmed-session-confirmation', audience: 'session-takeover' });
      if (!['google', 'password'].includes(data.method) || !req.cookies?.[TAKEOVER_COOKIE] || data.bh !== s.hashToken(req.cookies[TAKEOVER_COOKIE])) throw Error();
    } catch { throw new SessionControlError(401, 'CONFIRMATION_EXPIRED', 'Confirmation expired. Please sign in again.'); }
    const user = await privateQuery(User.findById(data.uid));
    if (!user || Number(user.token_version || 0) !== data.tv || user.active_session?.id !== data.sid) throw fail();
    const result = await claim(req, res, user, data.method, true); return { ...result, method: data.method };
  }
  async function refresh(req, res) {
    const hash = s.hashToken(req.cookies?.[s.COOKIE.refresh] || '');
    for (let attempt = 0; attempt < 4; attempt++) {
      const user = await privateQuery(User.findOne({ $or: [{ 'refresh_tokens.hash': hash }, { 'active_session.previous_refresh_hash': hash }] }));
      const now = Date.now(), p = policy();
      if (!user || user.is_active === false) throw fail();
      const list = records(user), entry = (user.refresh_tokens || []).find(t => t.hash === hash && new Date(t.expires_at).getTime() > now);
      let active = entry?.session_id ? findSession(user, entry.session_id, p) : list.find(a => a.previous_refresh_hash === hash && new Date(a.previous_refresh_until).getTime() > now);
      // Upgrade an old refresh credential without changing other browsers or global revocation.
      if (entry && !entry.session_id && !p.single_device_enabled) {
        active = { id: s.randomToken(24), token_version: Number(user.token_version || 0), idle_timeout_enabled: p.idle_timeout_enabled,
          idle_minutes: p.idle_minutes, warning_seconds: p.warning_seconds, last_active_at: new Date(now), expires_at: new Date(Math.min(now + p.timeout_seconds * 1000, new Date(entry.expires_at).getTime())), absolute_expires_at: entry.expires_at };
        list.push(active);
      }
      if (!live(active, now, p) || (p.single_device_enabled && active.id !== user.active_session?.id)) throw fail();
      let refreshToken;
      if (entry && !entry.is_grace) {
        refreshToken = s.randomToken();
        const updatedActive = { ...active, previous_refresh_hash: hash, previous_refresh_until: new Date(now + 30000) };
        const sessions = list.map(a => a.id === active.id ? updatedActive : a);
        const tokens = [...(user.refresh_tokens || []).filter(t => t.hash !== hash && !(t.session_id === active.id && t.is_grace) && new Date(t.expires_at).getTime() > now),
          { hash: s.hashToken(refreshToken), session_id: active.id, created_at: entry.created_at, expires_at: entry.expires_at },
          { hash, session_id: active.id, is_grace: true, created_at: entry.created_at, expires_at: new Date(now + 30000) }];
        const updated = await save(user, sessions, tokens);
        if (!updated) continue;
        active = updatedActive;
      }
      s.setSessionCookies(req, res, { accessToken: s.signAccessToken({ ...user, active_session: active }, v => Number(v || 0)), refreshToken, csrfToken: s.randomToken(16) });
      return;
    }
    throw fail();
  }
  function status(user, sid = user.active_session?.id) {
    const p = policy(), active = findSession(user, sid, p);
    const timing = active?.idle_timeout_enabled !== false && active?.idle_minutes && active?.warning_seconds
      ? { idle_minutes: active.idle_minutes, warning_seconds: active.warning_seconds } : p;
    return { ...p, ...timing, session_id: active?.id, last_activity_at: active?.last_active_at,
      warning_at: p.idle_timeout_enabled && active?.last_active_at ? new Date(new Date(active.last_active_at).getTime() + timing.idle_minutes * 60000) : null,
      expires_at: active ? new Date(deadline(active, p)) : null, server_now: new Date() };
  }
  async function activity(req) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const user = await privateQuery(User.findById(req.userId));
      const sid = req.sessionId || req.user.active_session?.id, p = policy(), active = findSession(user, sid, p), now = new Date();
      if (!user || user.is_active === false || Number(user.token_version || 0) !== Number(req.user.token_version || 0) || !live(active, now.getTime(), p)) throw fail();
      if (!p.idle_timeout_enabled) return status(user, sid);
      const updated = { ...active, idle_timeout_enabled: true, last_active_at: now, expires_at: new Date(Math.min(now.getTime() + p.timeout_seconds * 1000, new Date(active.absolute_expires_at).getTime())), idle_minutes: p.idle_minutes, warning_seconds: p.warning_seconds };
      const changed = await save(user, records(user).map(a => a.id === sid ? updated : a), user.refresh_tokens || [], Number(user.token_version || 0), now);
      if (changed) return status(changed, sid);
    }
    throw fail();
  }
  async function logout(req) {
    const hash = req.cookies?.[s.COOKIE.refresh] ? s.hashToken(req.cookies[s.COOKIE.refresh]) : '';
    if (!hash) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const user = await privateQuery(User.findOne({ $or: [{ 'refresh_tokens.hash': hash }, { 'active_session.previous_refresh_hash': hash }] }));
      if (!user) return;
      const entry = (user.refresh_tokens || []).find(t => t.hash === hash);
      const sid = entry?.session_id || records(user).find(a => a.previous_refresh_hash === hash && new Date(a.previous_refresh_until).getTime() > Date.now())?.id;
      if (!entry && !sid) return;
      const sessions = records(user).filter(a => a.id !== sid);
      const tokens = (user.refresh_tokens || []).filter(t => t.hash !== hash && (!sid || t.session_id !== sid));
      if (await save(user, sessions, tokens)) return;
    }
    throw fail();
  }
  return { issue, confirm, refresh, status, activity, logout };
}
module.exports = { policy, live, current, records, findSession, selectedUser, privateQuery, createSessionControl, SessionControlError, respond, TAKEOVER_COOKIE };
