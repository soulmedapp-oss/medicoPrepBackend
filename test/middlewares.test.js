const test = require('node:test');
const assert = require('node:assert');
const multer = require('multer');
const express = require('express');
const { errorHandler, mapError, createCorsError } = require('../src/middlewares/errorHandler');
const { validateObjectIdParams } = require('../src/middlewares/validateObjectId');
const { createRateLimiter, resetMemoryStore, userOrIpKey } = require('../src/middlewares/rateLimit');

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    locals: {},
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
  return res;
}

test('mapError: multer size -> 413, other multer -> 400', () => {
  assert.strictEqual(mapError(new multer.MulterError('LIMIT_FILE_SIZE')).status, 413);
  assert.strictEqual(mapError(new multer.MulterError('LIMIT_UNEXPECTED_FILE')).status, 400);
});

test('mapError: fileFilter / CORS / JSON parse / generic', () => {
  const fileErr = Object.assign(new Error('Only image uploads are allowed'), { code: 'INVALID_FILE_TYPE' });
  assert.deepStrictEqual(mapError(fileErr), { status: 400, message: 'Only image uploads are allowed' });
  assert.strictEqual(mapError(createCorsError()).status, 403);
  assert.strictEqual(mapError(Object.assign(new Error('x'), { type: 'entity.parse.failed', status: 400 })).status, 400);
  assert.strictEqual(mapError(Object.assign(new Error('x'), { type: 'entity.too.large', status: 413 })).status, 413);
  assert.deepStrictEqual(mapError(new Error('secret db detail')), { status: 500, message: 'Internal server error' });
});

test('errorHandler never leaks message or stack on 500', () => {
  const res = mockRes();
  const err = new Error('mongo://user:pass@host exploded');
  errorHandler(err, { correlationId: 'c1' }, res, () => {});
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: 'Internal server error', correlationId: 'c1' });
  assert.ok(!JSON.stringify(res.body).includes('mongo'));
});

test('validateObjectIdParams: 400 on bad id, passes good id', async () => {
  const router = express.Router();
  validateObjectIdParams(router, ['id']);
  router.get('/things/:id', (req, res) => res.json({ ok: true }));
  const app = express();
  app.use(router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const bad = await fetch(`http://127.0.0.1:${port}/things/not-an-id`);
    assert.strictEqual(bad.status, 400);
    const good = await fetch(`http://127.0.0.1:${port}/things/507f1f77bcf86cd799439011`);
    assert.strictEqual(good.status, 200);
  } finally {
    server.close();
  }
});

test('rate limiter (memory store) returns 429 after max', async () => {
  process.env.RATE_LIMIT_STORE = 'memory';
  resetMemoryStore();
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, name: 'unit', keyGenerator: userOrIpKey });
  const run = async (req) => {
    const res = mockRes();
    let nextCalled = false;
    await limiter(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
  };
  const req = { ip: '1.2.3.4', path: '/x', userId: 'user-a' };
  assert.strictEqual((await run(req)).nextCalled, true);
  assert.strictEqual((await run(req)).nextCalled, true);
  const third = await run(req);
  assert.strictEqual(third.nextCalled, false);
  assert.strictEqual(third.res.statusCode, 429);
  assert.ok(Number(third.res.headers['retry-after']) >= 1);
  // Different user on the same IP is independent.
  assert.strictEqual((await run({ ...req, userId: 'user-b' })).nextCalled, true);
});
