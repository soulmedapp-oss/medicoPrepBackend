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
// Default TTL (4h = 14400s) dominates here: duration + 900 = 11700 < 14400, so
// this pins the ttl-dominant branch of Math.max(ttl, duration + 900) exactly —
// not just "greater than or equal", which an equality regression would still pass.
test('playback token TTL: default ttl dominates a 3-hour lecture', () => {
  const now = 1800000000;
  const video = { bunny_video_id: 'GUID', duration_seconds: 3 * 60 * 60 };
  const result = getPlaybackToken(video, { now });
  assert.equal(result.expires_at, now + 4 * 60 * 60);
});

// A 5-hour lecture pushes duration + 900 (18900) past the default ttl (14400),
// so this pins the OTHER branch of Math.max — the one the 3-hour case above
// never exercises. Together the two cases pin both arms exactly, so silently
// dropping the +900 safety buffer (i.e. regressing to expires = now + duration)
// would fail this test even though it still satisfies a ">=" check.
test('playback token TTL: long lecture duration dominates the default ttl', () => {
  const now = 1800000000;
  const video = { bunny_video_id: 'GUID', duration_seconds: 5 * 60 * 60 };
  const result = getPlaybackToken(video, { now });
  assert.equal(result.expires_at, now + video.duration_seconds + 900);
});

test('getPlaybackToken returns exactly hls_url, token, token_path and expires_at', () => {
  const result = getPlaybackToken({ bunny_video_id: 'GUID', duration_seconds: 60 }, { now: 1800000000 });
  assert.deepEqual(Object.keys(result).sort(), ['expires_at', 'hls_url', 'token', 'token_path']);
});

// A bunny row mid-upload can have bunny_video_id === '' (the model default).
// Without a guard this silently builds a token over "//" and a URL with a
// double slash — no exception, no log, just a 403/404 in a student's player.
test('getPlaybackToken throws when bunny_video_id is missing or empty', () => {
  assert.throws(() => getPlaybackToken({ bunny_video_id: '', duration_seconds: 60 }, { now: 1800000000 }));
  assert.throws(() => getPlaybackToken({ duration_seconds: 60 }, { now: 1800000000 }));
  assert.throws(() => getPlaybackToken(undefined, { now: 1800000000 }));
});

const { buildUploadPayload } = require('../src/services/video/bunnyProvider');

test('upload payload carries a signature but never the api key', () => {
  const payload = buildUploadPayload({
    libraryId: '12', apiKey: 'SECRET-API-KEY', videoId: 'GUID', now: 1800000000,
  });
  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes('SECRET-API-KEY'), 'api key must not reach the client');
  assert.equal(payload.video_id, 'GUID');
  assert.equal(payload.library_id, '12');
  assert.ok(payload.expires > 1800000000, 'signature must have a future expiry');
  assert.match(payload.signature, /^[0-9a-f]{64}$/);
});
