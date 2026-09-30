const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const jwt = require('jsonwebtoken');
const { signAiToken, AI_TOKEN_SCOPE, AI_TOKEN_TTL_SECONDS } = require('../src/auth/session');
const { authMiddleware } = require('../src/middlewares/auth');

const fakeRes = () => ({
  statusCode: 200,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

test('signAiToken: carries only the user id and the ai scope, and is short-lived', () => {
  const token = signAiToken({ _id: '64b000000000000000000001', token_version: 3 });
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(payload.sub, '64b000000000000000000001');
  assert.equal(payload.scope, AI_TOKEN_SCOPE);
  assert.equal(payload.exp - payload.iat, AI_TOKEN_TTL_SECONDS);
  assert.ok(AI_TOKEN_TTL_SECONDS <= 600, 'a script-readable token must not live long');
  // PyJWT refuses a token with an `aud` claim unless the verifier names one;
  // the AI service does not, so the scope must not travel as `aud`.
  assert.equal(payload.aud, undefined);
});

test('authMiddleware: an AI-scoped token is refused by this API, as a header or as a cookie', async () => {
  const token = signAiToken({ _id: '64b000000000000000000001' });
  for (const req of [
    { headers: { authorization: `Bearer ${token}` }, cookies: {} },
    { headers: {}, cookies: { mp_access: token } },
  ]) {
    const res = fakeRes();
    let nexted = false;
    await authMiddleware(req, res, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Invalid token');
  }
});
