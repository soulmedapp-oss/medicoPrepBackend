const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COOKIE, CSRF_HEADER, hashToken, randomToken, addRefreshToken, rotateRefreshToken, checkCsrf,
  setSessionCookies, clearSessionCookies, REFRESH_PATH,
} = require('../src/auth/session');
const { csrfProtection } = require('../src/middlewares/csrf');

const DAY = 86400000;

test('refresh tokens are random, distinct and stored only as hashes', () => {
  const a = randomToken(); const b = randomToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), a);
});

test('addRefreshToken drops expired entries and caps the list at the most recent 10', () => {
  const now = Date.now();
  const existing = [
    { hash: 'old', created_at: new Date(now - 30 * DAY), expires_at: new Date(now - DAY) },
    ...Array.from({ length: 10 }, (_, i) => ({ hash: `h${i}`, created_at: new Date(now - i), expires_at: new Date(now + DAY) })),
  ];
  const next = addRefreshToken(existing, 'new', now);
  assert.equal(next.length, 10);
  assert.ok(!next.some((t) => t.hash === 'old'), 'expired entry removed');
  assert.equal(next[next.length - 1].hash, 'new');
  assert.ok(next[next.length - 1].expires_at.getTime() > now + 6 * DAY);
});

test('rotateRefreshToken: a known live token is replaced; unknown or expired ends the session', () => {
  const now = Date.now();
  const list = [{ hash: 'live', expires_at: new Date(now + DAY) }, { hash: 'dead', expires_at: new Date(now - 1) }];
  const ok = rotateRefreshToken(list, 'live', 'fresh', now);
  assert.equal(ok.ok, true);
  assert.ok(!ok.next.some((t) => t.hash === 'live'));
  assert.ok(ok.next.some((t) => t.hash === 'fresh'));
  assert.equal(rotateRefreshToken(list, 'nope', 'fresh', now).ok, false);
  const expired = rotateRefreshToken(list, 'dead', 'fresh', now);
  assert.equal(expired.ok, false);
  assert.ok(!expired.next.some((t) => t.hash === 'dead'), 'expired presented token is pruned');
});

test('checkCsrf: safe methods and non-cookie requests always pass', () => {
  assert.equal(checkCsrf({ method: 'GET', cookies: { [COOKIE.access]: 'x' }, headers: {} }).ok, true);
  assert.equal(checkCsrf({ method: 'POST', cookies: {}, headers: {} }).ok, true, 'no session, nothing to forge');
  assert.equal(checkCsrf({ method: 'POST', cookies: { [COOKIE.access]: 'x' }, headers: { authorization: 'Bearer abc' } }).ok, true, 'bearer clients are exempt');
});

test('checkCsrf: a cookie-authenticated write needs a matching X-CSRF-Token', () => {
  const cookies = { [COOKIE.access]: 'jwt', [COOKIE.csrf]: 'tok123' };
  assert.equal(checkCsrf({ method: 'POST', cookies, headers: {} }).ok, false);
  assert.equal(checkCsrf({ method: 'DELETE', cookies, headers: { [CSRF_HEADER]: 'wrong' } }).ok, false);
  assert.equal(checkCsrf({ method: 'PATCH', cookies, headers: { [CSRF_HEADER]: 'tok123' } }).ok, true);
});

test('checkCsrf: when an origin allow-list is configured, a foreign Origin is refused even with the token', () => {
  const cookies = { [COOKIE.access]: 'jwt', [COOKIE.csrf]: 't' };
  const headers = { [CSRF_HEADER]: 't', origin: 'https://evil.example' };
  const allowed = ['https://app.example'];
  assert.equal(checkCsrf({ method: 'POST', cookies, headers, allowedOrigins: allowed }).ok, false);
  assert.equal(checkCsrf({ method: 'POST', cookies, headers: { ...headers, origin: 'https://app.example' }, allowedOrigins: allowed }).ok, true);
  assert.equal(checkCsrf({ method: 'POST', cookies, headers: { [CSRF_HEADER]: 't', referer: 'https://app.example/page' }, allowedOrigins: allowed }).ok, true);
  assert.equal(checkCsrf({ method: 'POST', cookies, headers: { [CSRF_HEADER]: 't' }, allowedOrigins: allowed }).ok, true, 'same-origin fetches may omit Origin');
});

test('csrfProtection middleware: 403 with a reason, otherwise next()', () => {
  const mw = csrfProtection({ allowedOrigins: [] });
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  mw({ method: 'POST', cookies: { [COOKIE.access]: 'jwt', [COOKIE.csrf]: 'a' }, headers: {} }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'CSRF token missing or invalid');
  mw({ method: 'POST', cookies: { [COOKIE.access]: 'jwt', [COOKIE.csrf]: 'a' }, headers: { [CSRF_HEADER]: 'a' } }, res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('session cookies: access and csrf on /, refresh path-scoped and strict, only csrf readable by scripts', () => {
  const set = []; const cleared = [];
  const res = { cookie: (n, v, o) => set.push({ n, v, o }), clearCookie: (n, o) => cleared.push({ n, o }) };
  setSessionCookies({ secure: false }, res, { accessToken: 'A', refreshToken: 'R', csrfToken: 'C' });
  const byName = Object.fromEntries(set.map((c) => [c.n, c]));
  assert.equal(byName[COOKIE.access].o.httpOnly, true);
  assert.equal(byName[COOKIE.access].o.sameSite, 'lax');
  assert.equal(byName[COOKIE.refresh].o.httpOnly, true);
  assert.equal(byName[COOKIE.refresh].o.sameSite, 'strict');
  assert.equal(byName[COOKIE.refresh].o.path, REFRESH_PATH);
  assert.equal(byName[COOKIE.csrf].o.httpOnly, false);
  assert.ok(byName[COOKIE.access].o.maxAge < byName[COOKIE.refresh].o.maxAge, 'access token is the short-lived one');
  clearSessionCookies({ secure: false }, res);
  assert.deepEqual(cleared.map((c) => c.n).sort(), [COOKIE.access, COOKIE.csrf, COOKIE.refresh].sort());
});
