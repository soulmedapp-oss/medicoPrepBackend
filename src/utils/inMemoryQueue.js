const queue = [];
let isProcessing = false;

function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  const next = () => {
    const job = queue.shift();
    if (!job) {
      isProcessing = false;
      return;
    }
    Promise.resolve()
      .then(job)
      .catch((err) => {
        try {
          // eslint-disable-next-line no-console
          console.error('Background job failed:', err);
        } catch (innerErr) {
          // ignore logging failures
        }
      })
      .finally(() => {
        setImmediate(next);
      });
  };

  setImmediate(next);
}

function enqueueJob(job) {
  if (typeof job !== 'function') return;
  queue.push(job);
  processQueue();
}

module.exports = { enqueueJob };
