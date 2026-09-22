const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyBunnySignature } = require('../src/utils/bunnyWebhook');

const SECRET = 'readonly-key';
const BODY = '{"VideoLibraryId":12,"VideoGuid":"abc","Status":3}';
const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

test('a correctly signed body is accepted', () => {
  assert.equal(verifyBunnySignature(BODY, sign(BODY), SECRET), true);
});

test('a tampered body is rejected', () => {
  const tampered = BODY.replace('"Status":3', '"Status":5');
  assert.equal(verifyBunnySignature(tampered, sign(BODY), SECRET), false);
});

// Review Focus #3: express.json() discards the raw body. Re-serialising the
// parsed object reorders keys, so the signature fails - which is exactly the
// silent bug this test exists to prevent.
test('a re-serialised body does not verify', () => {
  const reserialised = JSON.stringify({ Status: 3, VideoGuid: 'abc', VideoLibraryId: 12 });
  assert.notEqual(reserialised, BODY, 'precondition: re-serialising changes the bytes');
  assert.equal(verifyBunnySignature(reserialised, sign(BODY), SECRET), false);
});

test('a missing signature or secret is rejected rather than throwing', () => {
  assert.equal(verifyBunnySignature(BODY, undefined, SECRET), false);
  assert.equal(verifyBunnySignature(BODY, sign(BODY), ''), false);
  assert.equal(verifyBunnySignature(undefined, sign(BODY), SECRET), false);
});
