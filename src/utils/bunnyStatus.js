// Bunny status codes: 0 Queued, 1 Processing, 2 Encoding, 3 Finished,
// 4 Resolution finished, 5 Failed, 9 Captions generated.
//
// Verified live against real Bunny Stream: a video reporting status 4
// ("Resolution finished") with encodeProgress 100% already has a resolving
// HLS master playlist listing every available rendition and is genuinely
// playable. Treating 4 as still in-progress left those rows stuck at
// `processing` forever - nothing (webhook or refresh-status) could ever move
// them again, because the code that would normally advance them was itself
// the code they were stuck on. 3 and 4 are therefore both success states.
const IN_PROGRESS = new Set([0, 1, 2]);
const TERMINAL = new Set(['ready', 'failed']);

// Webhooks arrive out of order and are retried, so the same video can receive a
// stale or duplicate callback at any time. `ready` and `failed` are terminal:
// once reached, NOTHING moves the video again. Guarding only the in-progress
// codes is not enough - a duplicate Failed webhook would revoke a student's
// access mid-lecture, and a late Finished webhook would resurrect a failed
// encode as playable.
function nextProcessingStatus(current, bunnyStatus) {
  if (TERMINAL.has(current)) return null;
  const code = Number(bunnyStatus);
  if (code === 3 || code === 4) return 'ready';
  if (code === 5) return 'failed';
  if (IN_PROGRESS.has(code)) return current === 'processing' ? null : 'processing';
  return null;
}

module.exports = { nextProcessingStatus };
