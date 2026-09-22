// Bunny status codes: 0 Queued, 1 Processing, 2 Encoding, 3 Finished,
// 4 Resolution finished, 5 Failed, 9 Captions generated.
const IN_PROGRESS = new Set([0, 1, 2, 4]);

// Webhooks arrive out of order. Once a video is ready, an older in-progress
// webhook must not demote it - that would revoke access for students mid-watch.
function nextProcessingStatus(current, bunnyStatus) {
  const code = Number(bunnyStatus);
  if (code === 3) return current === 'ready' ? null : 'ready';
  if (code === 5) return current === 'failed' ? null : 'failed';
  if (IN_PROGRESS.has(code)) {
    if (current === 'ready' || current === 'failed') return null;
    return current === 'processing' ? null : 'processing';
  }
  return null;
}

module.exports = { nextProcessingStatus };
