const test = require('node:test');
const assert = require('node:assert/strict');
const { playbackResponse } = require('../src/controllers/videosController');

test('a youtube video returns its stored url and no token', () => {
  const result = playbackResponse({ provider: 'youtube', video_url: 'https://y/1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.video_url, 'https://y/1');
  assert.equal(result.body.token, undefined);
});

// Review Focus #2: a lecture published before encoding finished must not hand
// out a token for an asset that cannot play.
test('a bunny video still processing returns 409 rather than a dead token', () => {
  const result = playbackResponse({
    provider: 'bunny', bunny_video_id: 'g', processing_status: 'processing',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.token, undefined);
  assert.match(result.body.error, /still being processed/i);
});

test('a failed bunny video returns 409', () => {
  const result = playbackResponse({
    provider: 'bunny', bunny_video_id: 'g', processing_status: 'failed',
  });
  assert.equal(result.status, 409);
});

test('a ready bunny video returns a token and expiry', () => {
  const result = playbackResponse({
    provider: 'bunny', bunny_video_id: 'g', processing_status: 'ready', duration_seconds: 60,
  });
  assert.equal(result.status, 200);
  // Brief's original regex (/^[0-9a-f]{64}$/) assumed a raw sha256 hex
  // digest; Task 5's shipped bunnyProvider.buildPlaybackToken actually
  // returns an "HS256-<base64url>" directory token (see
  // test/bunnyProvider.test.js), which this matches instead.
  assert.match(result.body.token, /^HS256-[A-Za-z0-9_-]+$/);
  assert.ok(result.body.expires_at > Math.floor(Date.now() / 1000));
});

// Amendment: a freshly created bunny row takes the schema default
// processing_status: 'ready' while bunny_video_id is still '' — nothing has
// been uploaded yet. That must not reach getPlaybackToken (which throws on
// an empty bunny_video_id); it must return the same 409 "still processing"
// response, checked before the processing_status test.
test('a bunny video with no bunny_video_id yet returns 409 and does not throw, even though processing_status reads ready', () => {
  assert.doesNotThrow(() => {
    const result = playbackResponse({
      provider: 'bunny', bunny_video_id: '', processing_status: 'ready',
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.token, undefined);
    assert.match(result.body.error, /still being processed/i);
  });
});
