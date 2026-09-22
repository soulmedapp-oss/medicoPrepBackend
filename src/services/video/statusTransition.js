const { nextProcessingStatus } = require('../../utils/bunnyStatus');

// Applies a raw Bunny status code to an already-loaded video document and
// persists any resulting transition. Shared by the webhook handler
// (server.js) and the admin refresh-status endpoint
// (videosController.js#refreshVideoStatus) so the terminal-state guard, the
// transcript_status bookkeeping, and the persistence order can never drift
// between the two entry points — one caller reaching a different verdict
// than the other for the same (processing_status, bunnyStatusCode) pair
// would be exactly the kind of bug this file exists to prevent.
//
// Deliberately does NOT fetch or persist duration_seconds: the two callers
// differ in how cheaply they already have that value (the webhook must make
// a second Bunny call; refresh-status already has it from the getStatus call
// that produced bunnyStatusCode), so fetching it stays the caller's job.
//
// Returns the transition applied (same as nextProcessingStatus: the new
// status, or null if nothing changed) so callers can decide whether to fetch
// duration.
async function applyBunnyStatusTransition(video, bunnyStatusCode) {
  const next = nextProcessingStatus(video.processing_status, bunnyStatusCode);
  let dirty = false;
  if (next) {
    video.processing_status = next;
    dirty = true;
  }
  // Bunny code 9 ("Captions generated") only means captions exist upstream —
  // nothing here fetches or stores the transcript itself (deferred to a
  // later phase). Recording 'ready' would tell buildVideoContext a
  // transcript is available when it isn't; 'pending' records the upstream
  // event without overclaiming. Guarded on the current value staying 'none'
  // so a later, more specific status (e.g. a real fetch failure) is never
  // clobbered back to 'pending' by a stale/duplicate code-9 webhook.
  if (Number(bunnyStatusCode) === 9 && video.transcript_status === 'none') {
    video.transcript_status = 'pending';
    dirty = true;
  }
  if (dirty) {
    await video.save();
  }
  return next;
}

module.exports = { applyBunnyStatusTransition };
