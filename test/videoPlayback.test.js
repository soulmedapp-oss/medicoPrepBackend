const test = require('node:test');
const assert = require('node:assert/strict');
const { playbackResponse, resolvePlaybackAccess } = require('../src/controllers/videosController');

test('a youtube video returns its stored url and no token', () => {
  const result = playbackResponse({ provider: 'youtube', video_url: 'https://y/1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.video_url, 'https://y/1');
  assert.equal(result.body.token, undefined);
  // C: the bunny 200 body's key set is already pinned below; the youtube one
  // never was, so a field rename here would break Videos.jsx (it reads
  // playback.video_url to know whether to render the iframe or the raw
  // <video> element) without failing any test.
  assert.deepEqual(Object.keys(result.body).sort(), ['provider', 'video_url']);
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

test('a ready bunny video returns a token, token_path and expiry', () => {
  const result = playbackResponse({
    provider: 'bunny', bunny_video_id: 'g', processing_status: 'ready', duration_seconds: 60,
  });
  assert.equal(result.status, 200);
  // Brief's original regex (/^[0-9a-f]{64}$/) assumed a raw sha256 hex
  // digest; Task 5's shipped bunnyProvider.buildPlaybackToken actually
  // returns an "HS256-<base64url>" directory token (see
  // test/bunnyProvider.test.js), which this matches instead.
  assert.match(result.body.token, /^HS256-[A-Za-z0-9_-]+$/);
  // Fix round 1: Bunny's CDN token is a directory token — the signed
  // message covers token_path, and the player must send it back as a query
  // parameter on every request or playback 403s (live-CDN verified). A
  // response missing token_path breaks playback entirely, so pin both the
  // value and the full key set of the 200 body, so a future refactor that
  // drops a field fails a test instead of failing silently in a player.
  assert.match(result.body.token_path, /\/g\//);
  assert.ok(result.body.expires_at > Math.floor(Date.now() / 1000));
  assert.deepEqual(
    Object.keys(result.body).sort(),
    ['expires_at', 'hls_url', 'provider', 'token', 'token_path']
  );
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

// Task 5 — resolvePlaybackAccess is the pure decision loadVideoForPlayback
// hands to getPlayback; these pin the entitlement gate without a database.

// Review Focus #1: a lecture in no playlist is a clean refusal, never a
// thrown error and never anything resembling a token.
test('a lecture in no playlist is refused cleanly, not thrown, and carries no token', () => {
  assert.doesNotThrow(() => {
    const result = resolvePlaybackAccess({
      lecture: { _id: 'L1', is_active: true },
      playlists: [],
      planName: 'free',
      isStaff: false,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'Upgrade required');
    assert.equal(result.token, undefined);
  });
});

test('a lecture in a published, entitled playlist is allowed', () => {
  const lecture = { _id: 'L1', is_active: true };
  const playlists = [
    { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: 'L1' }] },
  ];
  const result = resolvePlaybackAccess({ lecture, playlists, planName: 'free', isStaff: false });
  assert.equal(result.allowed, true);
  assert.equal(result.error, undefined);
});

test('a lecture only in a playlist for another plan is refused with the same shape as an unentitled video', () => {
  const lecture = { _id: 'L1', is_active: true };
  const playlists = [
    { is_published: true, is_active: true, is_free: false, allowed_plans: ['gold'], items: [{ lecture_id: 'L1' }] },
  ];
  const result = resolvePlaybackAccess({ lecture, playlists, planName: 'free', isStaff: false });
  assert.deepEqual(result, { allowed: false, status: 403, error: 'Upgrade required' });
});

// Staff bypass stays exactly as today: CanViewVideos may preview any active
// lecture regardless of playlist membership.
test('staff may play an active lecture that is in no playlist at all', () => {
  const result = resolvePlaybackAccess({
    lecture: { _id: 'L1', is_active: true },
    playlists: [],
    planName: 'free',
    isStaff: true,
  });
  assert.equal(result.allowed, true);
});

test('an inactive lecture is never playable, even for staff', () => {
  const result = resolvePlaybackAccess({
    lecture: { _id: 'L1', is_active: false },
    playlists: [],
    planName: 'free',
    isStaff: true,
  });
  assert.deepEqual(result, { allowed: false, status: 404, error: 'Video not found' });
});

test('a missing lecture returns "Video not found" rather than throwing', () => {
  assert.doesNotThrow(() => {
    const result = resolvePlaybackAccess({ lecture: null, playlists: [], planName: 'free', isStaff: false });
    assert.deepEqual(result, { allowed: false, status: 404, error: 'Video not found' });
  });
});

// Final fix wave, B1: the playlist gate is the SINGLE entitlement gate (spec
// §5) — the lecture's own `is_published` is not part of it. A lecture left
// unpublished but placed in a published playlist is reachable, and a lecture
// whose only playlist has been unpublished is not, whatever the lecture says
// about itself. Pinned here because getVideoSummary/chatAboutVideo now route
// through this same decision instead of the old per-video gate.
test('a lecture with is_published:false is still playable when a published playlist carries it', () => {
  const lecture = { _id: 'L1', is_active: true, is_published: false };
  const playlists = [
    { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: 'L1' }] },
  ];
  const result = resolvePlaybackAccess({ lecture, playlists, planName: 'free', isStaff: false });
  assert.equal(result.allowed, true);
});

test('a lecture whose only playlist was unpublished is refused, even though the lecture itself is published', () => {
  const lecture = { _id: 'L1', is_active: true, is_published: true };
  const playlists = [
    { is_published: false, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: 'L1' }] },
  ];
  const result = resolvePlaybackAccess({ lecture, playlists, planName: 'free', isStaff: false });
  assert.deepEqual(result, { allowed: false, status: 403, error: 'Upgrade required' });
});
