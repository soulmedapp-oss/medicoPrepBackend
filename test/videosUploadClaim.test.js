const test = require('node:test');
const assert = require('node:assert/strict');
const { decideUploadClaim } = require('../src/controllers/videosController');

// decideUploadClaim is a pure mirror of the Mongo filter createUploadUrl uses
// to atomically claim the "no Bunny video yet" slot. It doesn't touch a
// database, so these pin the staleness/status boundary math without
// mongodb-memory-server. The actual atomicity guarantee still comes from
// Mongo evaluating the equivalent filter+update as a single operation in the
// controller — this only pins that the two agree on the same decision.

const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms
const STALE_MS = 5 * 60 * 1000;

test('decideUploadClaim: reuses whenever bunny_video_id is already set, regardless of status', () => {
  assert.equal(
    decideUploadClaim({ bunnyVideoId: 'GUID', processingStatus: 'ready', updatedAt: NOW, now: NOW }),
    'reuse'
  );
  assert.equal(
    decideUploadClaim({ bunnyVideoId: 'GUID', processingStatus: 'uploading', updatedAt: NOW, now: NOW }),
    'reuse'
  );
});

test('decideUploadClaim: claims a fresh row (never uploaded, not currently uploading)', () => {
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'ready', updatedAt: NOW, now: NOW }),
    'claim'
  );
});

test('decideUploadClaim: waits when another claim is live (uploading, not yet stale)', () => {
  const justClaimed = NOW - 1000; // 1s ago — well inside the staleness window
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'uploading', updatedAt: justClaimed, now: NOW, staleMs: STALE_MS }),
    'wait'
  );
});

test('decideUploadClaim: pins the exact staleness boundary — 1ms short of stale still waits, exactly at staleMs is stale', () => {
  // The guard is `now - updatedAtMs >= staleMs`, so staleMs itself already
  // counts as stale (claimable) and only staleMs-1 is still a live claim.
  // This pins that exact edge rather than just ">= roughly stale".
  const oneMsBeforeStale = NOW - (STALE_MS - 1);
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'uploading', updatedAt: oneMsBeforeStale, now: NOW, staleMs: STALE_MS }),
    'wait'
  );

  const exactlyStale = NOW - STALE_MS;
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'uploading', updatedAt: exactlyStale, now: NOW, staleMs: STALE_MS }),
    'claim'
  );
});

test('decideUploadClaim: reclaims a stale row (uploading, older than staleMs — a crashed attempt)', () => {
  const longAgo = NOW - STALE_MS - 1;
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'uploading', updatedAt: longAgo, now: NOW, staleMs: STALE_MS }),
    'claim'
  );
});

test('decideUploadClaim: treats a missing/unparseable updatedAt as stale rather than throwing', () => {
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'uploading', updatedAt: undefined, now: NOW, staleMs: STALE_MS }),
    'claim'
  );
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'uploading', updatedAt: 'not-a-date', now: NOW, staleMs: STALE_MS }),
    'claim'
  );
});

test('decideUploadClaim: accepts a Date instance for updatedAt, not just a timestamp', () => {
  const justClaimed = new Date(NOW - 1000);
  assert.equal(
    decideUploadClaim({ bunnyVideoId: '', processingStatus: 'uploading', updatedAt: justClaimed, now: NOW, staleMs: STALE_MS }),
    'wait'
  );
});
