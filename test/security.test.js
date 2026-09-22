const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  safeCompare,
  capLimit,
  isHttpUrl,
  truncateText,
  isValidObjectId,
  isTokenVersionCurrent,
  normalizeTokenVersion,
  maskSecret,
} = require('../src/utils/security');

test('safeCompare: equal strings match', () => {
  const sig = crypto.createHmac('sha256', 'secret').update('a|b').digest('hex');
  assert.strictEqual(safeCompare(sig, sig), true);
});

test('safeCompare: different/short/missing inputs never throw and return false', () => {
  assert.strictEqual(safeCompare('abc', 'abd'), false);
  assert.strictEqual(safeCompare('abc', 'abcd'), false);
  assert.strictEqual(safeCompare('', ''), false);
  assert.strictEqual(safeCompare(undefined, 'x'), false);
  assert.strictEqual(safeCompare('x', ['x']), false);
});

test('capLimit: defaults, caps and rejects garbage', () => {
  assert.strictEqual(capLimit(undefined, 100, 200), 100);
  assert.strictEqual(capLimit('', 50, 200), 50);
  assert.strictEqual(capLimit('abc', 50, 200), 50);
  assert.strictEqual(capLimit('-5', 50, 200), 50);
  assert.strictEqual(capLimit('0', 50, 200), 50);
  assert.strictEqual(capLimit('10', 50, 200), 10);
  assert.strictEqual(capLimit('100000', 50, 200), 200);
  assert.strictEqual(capLimit('12.9', 50, 200), 12);
  assert.strictEqual(capLimit(undefined, 500, 200), 200);
});

test('isHttpUrl: only http/https absolute URLs', () => {
  assert.strictEqual(isHttpUrl('https://example.com/a?b=1'), true);
  assert.strictEqual(isHttpUrl('http://localhost:3000'), true);
  assert.strictEqual(isHttpUrl('javascript:alert(1)'), false);
  assert.strictEqual(isHttpUrl('JaVaScRiPt:alert(1)'), false);
  assert.strictEqual(isHttpUrl('data:text/html,<script>'), false);
  assert.strictEqual(isHttpUrl('ftp://example.com'), false);
  assert.strictEqual(isHttpUrl('/relative/path'), false);
  assert.strictEqual(isHttpUrl(''), false);
  assert.strictEqual(isHttpUrl(null), false);
});

test('truncateText: leaves short text, truncates long text', () => {
  assert.strictEqual(truncateText('hello', 10), 'hello');
  const out = truncateText('x'.repeat(100), 10);
  assert.ok(out.startsWith('x'.repeat(10)));
  assert.ok(out.length < 30);
  assert.strictEqual(truncateText(undefined, 10), '');
});

test('isValidObjectId: strict 24-hex', () => {
  assert.strictEqual(isValidObjectId('507f1f77bcf86cd799439011'), true);
  assert.strictEqual(isValidObjectId('507F1F77BCF86CD799439011'), true);
  assert.strictEqual(isValidObjectId('123456789012'), false);
  assert.strictEqual(isValidObjectId('not-an-id'), false);
  assert.strictEqual(isValidObjectId(undefined), false);
});

test('token version: missing claim treated as 0', () => {
  assert.strictEqual(normalizeTokenVersion(undefined), 0);
  assert.strictEqual(normalizeTokenVersion('3'), 3);
  assert.strictEqual(normalizeTokenVersion(-1), 0);
  assert.strictEqual(isTokenVersionCurrent({ sub: 'u' }, {}), true);
  assert.strictEqual(isTokenVersionCurrent({ sub: 'u' }, { token_version: 0 }), true);
  assert.strictEqual(isTokenVersionCurrent({ sub: 'u', tv: 0 }, { token_version: 0 }), true);
  assert.strictEqual(isTokenVersionCurrent({ sub: 'u' }, { token_version: 1 }), false);
  assert.strictEqual(isTokenVersionCurrent({ sub: 'u', tv: 1 }, { token_version: 2 }), false);
  assert.strictEqual(isTokenVersionCurrent({ sub: 'u', tv: 2 }, { token_version: 2 }), true);
  assert.strictEqual(isTokenVersionCurrent({ sub: 'u', tv: 0 }, null), false);
});

test('maskSecret: never returns the full key', () => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234';
  const masked = maskSecret(key);
  assert.strictEqual(masked, 'sk-...1234');
  assert.ok(!masked.includes('abcdef'));
  assert.strictEqual(maskSecret(''), '');
  assert.strictEqual(maskSecret('short'), '****');
});
