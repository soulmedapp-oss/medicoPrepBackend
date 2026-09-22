// Bunny status codes: 0 Queued, 1 Processing, 2 Encoding, 3 Finished,
// 4 Resolution finished, 5 Failed, 9 Captions generated.
const IN_PROGRESS = new Set([0, 1, 2, 4]);
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
  if (code === 3) return 'ready';
  if (code === 5) return 'failed';
  if (IN_PROGRESS.has(code)) return current === 'processing' ? null : 'processing';
  return null;
}

module.exports = { nextProcessingStatus };
