const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const pino = require('pino');

const { reportError, isEnabled, contextFrom, flush } = require('../src/lib/errorReporter');
const { logger, REDACT_PATHS } = require('../src/lib/logger');

// Capture what a pino logger writes, as parsed JSON lines.
function captureLogger() {
  const lines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { log: pino({ level: 'trace', redact: ['*.password', 'req.headers.authorization'] }, sink), lines };
}

test('the test suite runs with the root logger silenced', () => {
  assert.equal(logger.level, 'silent');
});

test('without SENTRY_DSN error reporting is disabled and reportError still logs', () => {
  assert.equal(isEnabled(), false);
  const { log, lines } = captureLogger();
  const req = { log, correlationId: 'c-1', userId: 'u-1', method: 'GET', originalUrl: '/videos/1' };
  reportError(req, new Error('boom'), 'loading video', { video_id: '1' });
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.level, 50); // error
  assert.equal(line.msg, 'loading video');
  assert.equal(line.err.message, 'boom');
  assert.ok(line.err.stack.includes('boom'));
  assert.equal(line.correlationId, 'c-1');
  assert.equal(line.userId, 'u-1');
  assert.equal(line.path, '/videos/1');
  assert.equal(line.video_id, '1');
});

test('reportError tolerates a missing request and a non-Error value', () => {
  assert.doesNotThrow(() => reportError(null, 'plain string failure'));
  assert.doesNotThrow(() => reportError(undefined, undefined, 'nothing at all'));
  assert.doesNotThrow(() => reportError({}, { code: 'E_WEIRD' }));
});

test('the message defaults to the error message when none is given', () => {
  const { log, lines } = captureLogger();
  reportError({ log }, new Error('exact text'));
  assert.equal(lines[0].msg, 'exact text');
});

test('contextFrom never includes email or bodies, only ids and the route', () => {
  const ctx = contextFrom({
    correlationId: 'c',
    userId: { toString: () => 'u' },
    user: { email: 'x@y.z', password: 'nope' },
    body: { password: 'nope' },
    method: 'POST',
    originalUrl: '/auth/login',
  });
  assert.deepEqual(ctx, { correlationId: 'c', userId: 'u', method: 'POST', path: '/auth/login' });
});

test('flush resolves immediately when reporting is disabled', async () => {
  await flush(10);
});

test('the root logger redacts auth headers and secret-shaped keys', () => {
  for (const p of ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.api_key']) {
    assert.ok(REDACT_PATHS.includes(p), p);
  }
  const { log, lines } = captureLogger();
  log.info({ user: { password: 'hunter2' }, req: { headers: { authorization: 'Bearer x' } } }, 'x');
  assert.equal(lines[0].user.password, '[Redacted]');
  assert.equal(lines[0].req.headers.authorization, '[Redacted]');
});
