const store = new Map();

const createRateLimiter = ({ windowMs = 60_000, max = 5, message } = {}) => {

  return (req, res, next) => {
    try {
      const key = `${req.ip}:${req.path}`;
      const now = Date.now();
      let entry = store.get(key);

      if (!entry || entry.expiresAt <= now) {
        entry = { count: 0, expiresAt: now + windowMs };
        store.set(key, entry);
        setTimeout(() => store.delete(key), windowMs + 1000);
      }

      entry.count += 1;

      if (entry.count > max) {
        const retryAfter = Math.ceil((entry.expiresAt - now) / 1000);
        res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
        return res.status(429).json({
          error: message || 'Too many requests. Try again later.',
          retry_after_seconds: retryAfter,
        });
      }

      next();
    } catch (err) {
      next();
    }
  };
};

const getRateLimitStats = () => {
  const now = Date.now();
  const entries = [];
  for (const [key, value] of store.entries()) {
    entries.push({
      key,
      count: value.count,
      expires_in_ms: Math.max(0, value.expiresAt - now),
    });
  }
  return {
    total: entries.length,
    entries,
  };
};

module.exports = { createRateLimiter, getRateLimitStats };
