const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildPlaybackToken,
  buildUploadSignature,
  getPlaybackToken,
} = require('../src/services/video/bunnyProvider');

// Formula verified against the live library — see the spec's
// "Verified against the live library" table. Do not substitute the embed-view
// token (sha256 hex of key+guid+expires); that protects Bunny's iframe player,
// not the HLS playlist and segments we serve ourselves.
test('playback token is a base64url HS256 directory token over the signed message', () => {
  const dir = '/GUID/';
  const expires = 1800000000;
  const expected = 'HS256-' + crypto
    .createHmac('sha256', 'KEY')
    .update(`${dir}${expires}token_path=${dir}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  assert.equal(buildPlaybackToken({ tokenKey: 'KEY', videoId: 'GUID', expires }), expected);
});

test('playback token is base64url — no +, / or = survive', () => {
  // Any of those three characters breaks the token as a query parameter.
  for (let i = 0; i < 50; i += 1) {
    const token = buildPlaybackToken({ tokenKey: `k${i}`, videoId: `v${i}`, expires: 1800000000 + i });
    assert.match(token, /^HS256-[A-Za-z0-9_-]+$/, `token ${i} is not base64url: ${token}`);
  }
});

test('upload signature is sha256(libraryId + apiKey + expires + videoId)', () => {
  const expected = crypto.createHash('sha256').update('12' + 'API' + '1800000000' + 'GUID').digest('hex');
  assert.equal(
    buildUploadSignature({ libraryId: '12', apiKey: 'API', expires: 1800000000, videoId: 'GUID' }),
    expected
  );
});

// Review Focus #4: a 3-hour lecture watched with pauses must not outlive its token.
test('playback token TTL covers a long lecture', () => {
  const now = 1800000000;
  const video = { bunny_video_id: 'GUID', duration_seconds: 3 * 60 * 60 };
  const result = getPlaybackToken(video, { now });
  assert.ok(
    result.expires_at - now >= video.duration_seconds,
    'token must outlive the video it unlocks'
  );
});

test('playback token result never leaks the signing key', () => {
  const result = getPlaybackToken({ bunny_video_id: 'GUID', duration_seconds: 60 }, { now: 1800000000 });
  assert.deepEqual(Object.keys(result).sort(), ['expires_at', 'hls_url', 'token', 'token_path']);
});
