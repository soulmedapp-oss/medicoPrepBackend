const test = require('node:test');
const assert = require('node:assert/strict');
const { bodyLimits, findOversized, DEFAULT_MAX_STRING, MAX_ARRAY_ITEMS } = require('../src/middlewares/bodyLimits');

function mockRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const run = (body, opts) => {
  const res = mockRes();
  let nexted = false;
  bodyLimits(opts)({ body }, res, () => { nexted = true; });
  return { res, nexted };
};

test('a normal body passes through untouched', () => {
  const { nexted } = run({ title: 'ENT basics', tags: ['a', 'b'], nested: { note: 'x'.repeat(100) } });
  assert.equal(nexted, true);
});

test('a string over the default cap is refused with a 400 naming the field', () => {
  const { res, nexted } = run({ question: 'x'.repeat(DEFAULT_MAX_STRING + 1) });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, `question must be ${DEFAULT_MAX_STRING} characters or less`);
});

test('exactly the cap is allowed', () => {
  assert.equal(run({ q: 'x'.repeat(DEFAULT_MAX_STRING) }).nexted, true);
});

test('nested strings and array items are checked, with a readable path', () => {
  const { res } = run({ options: [{ text: 'ok' }, { text: 'y'.repeat(DEFAULT_MAX_STRING + 5) }] });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /^options\[1\]\.text must be/);
});

test('per-field overrides raise the cap only for that field name', () => {
  const opts = { overrides: { transcript_text: 200000 } };
  assert.equal(run({ transcript_text: 't'.repeat(150000) }, opts).nexted, true);
  assert.equal(run({ description: 'd'.repeat(30000) }, opts).nexted, false);
});

test('oversized arrays are refused', () => {
  const { res } = run({ ids: new Array(MAX_ARRAY_ITEMS + 1).fill('a') });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, `ids may hold at most ${MAX_ARRAY_ITEMS} items`);
});

test('non-object bodies (raw webhooks, GET) are ignored', () => {
  assert.equal(run(undefined).nexted, true);
  assert.equal(run(Buffer.from('raw')).nexted, true);
});

test('findOversized returns null for clean input and the first hit otherwise', () => {
  assert.equal(findOversized({ a: 'b' }, { maxString: 10, overrides: {} }), null);
  assert.deepEqual(findOversized({ a: 'x'.repeat(11) }, { maxString: 10, overrides: {} }), { path: 'body.a', limit: 10, kind: 'string' });
});
