const test = require('node:test');
const assert = require('node:assert/strict');
const { applyBunnyStatusTransition } = require('../src/services/video/statusTransition');

// applyBunnyStatusTransition is the logic shared by the webhook handler
// (server.js) and the admin refresh-status endpoint (I2) so the two can
// never disagree about what a given Bunny status code means for a given
// row. A fake video with a save() spy stands in for the Mongoose document —
// no database needed, since the function only reads/writes plain fields and
// calls .save().
function fakeVideo(overrides = {}) {
  const video = {
    processing_status: 'processing',
    transcript_status: 'none',
    saveCount: 0,
    ...overrides,
  };
  video.save = async function save() {
    this.saveCount += 1;
  };
  return video;
}

test('applyBunnyStatusTransition: encoding-finished (3) moves the row to ready and persists once', async () => {
  const video = fakeVideo({ processing_status: 'processing' });
  const next = await applyBunnyStatusTransition(video, 3);
  assert.equal(next, 'ready');
  assert.equal(video.processing_status, 'ready');
  assert.equal(video.saveCount, 1);
});

test('applyBunnyStatusTransition: failure code (5) moves the row to failed', async () => {
  const video = fakeVideo({ processing_status: 'processing' });
  const next = await applyBunnyStatusTransition(video, 5);
  assert.equal(next, 'failed');
  assert.equal(video.processing_status, 'failed');
});

// Same terminal guard as nextProcessingStatus — this function must not weaken
// it, only reuse it.
test('applyBunnyStatusTransition: terminal states never move again and never save', async () => {
  const ready = fakeVideo({ processing_status: 'ready' });
  assert.equal(await applyBunnyStatusTransition(ready, 5), null);
  assert.equal(ready.processing_status, 'ready');
  assert.equal(ready.saveCount, 0);

  const failed = fakeVideo({ processing_status: 'failed' });
  assert.equal(await applyBunnyStatusTransition(failed, 3), null);
  assert.equal(failed.processing_status, 'failed');
  assert.equal(failed.saveCount, 0);
});

// D: code 9 ("captions generated") must not claim transcript_status: 'ready'
// — no transcript is actually fetched here (deferred to a later phase), so
// that would tell buildVideoContext a transcript exists when it doesn't.
test('applyBunnyStatusTransition: caption-generated (9) sets transcript_status to pending, never ready', async () => {
  const video = fakeVideo({ processing_status: 'ready', transcript_status: 'none' });
  await applyBunnyStatusTransition(video, 9);
  assert.equal(video.transcript_status, 'pending');
});

test('applyBunnyStatusTransition: a duplicate caption-generated webhook does not reset an already-settled transcript_status', async () => {
  const video = fakeVideo({ processing_status: 'ready', transcript_status: 'pending' });
  const next = await applyBunnyStatusTransition(video, 9);
  assert.equal(video.transcript_status, 'pending');
  assert.equal(next, null);
  assert.equal(video.saveCount, 0);
});

test('applyBunnyStatusTransition: in-progress codes move uploading to processing exactly once', async () => {
  const video = fakeVideo({ processing_status: 'uploading' });
  const next = await applyBunnyStatusTransition(video, 2);
  assert.equal(next, 'processing');
  assert.equal(video.saveCount, 1);
});

test('applyBunnyStatusTransition: an unknown code with nothing to change does not call save', async () => {
  const video = fakeVideo({ processing_status: 'processing' });
  const next = await applyBunnyStatusTransition(video, 99);
  assert.equal(next, null);
  assert.equal(video.saveCount, 0);
});
