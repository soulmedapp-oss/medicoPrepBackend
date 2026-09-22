const mongoose = require('mongoose');
const RateLimitEntry = require('../models/RateLimitEntry');

// Fixed-window rate limiter.
// Store: MongoDB (collection `rate_limits`, TTL-indexed) whenever a connection
// is available, so limits are shared across Lambda instances. Falls back to a
// per-process in-memory Map when Mongo is not connected, on DB errors, or when
// RATE_LIMIT_STORE=memory.
const store = new Map();

function useMongoStore() {
  const configured = String(process.env.RATE_LIMIT_STORE || 'mongo').toLowerCase();
  return configured !== 'memory' && mongoose.connection.readyState === 1;
}

function getWindow(now, windowMs) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  return { windowStart, windowEnd: windowStart + windowMs };
}

function incrementMemory(id, windowEnd) {
  const now = Date.now();
  let entry = store.get(id);
  if (!entry || entry.expiresAt <= now) {
    entry = { count: 0, expiresAt: windowEnd };
    store.set(id, entry);
    const timer = setTimeout(() => store.delete(id), Math.max(0, windowEnd - now) + 1000);
    if (timer.unref) timer.unref();
  }
  entry.count += 1;
  return entry.count;
}

async function incrementMongo(id, windowEnd) {
  const update = { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date(windowEnd) } };
  const options = { upsert: true, new: true, lean: true, maxTimeMS: 2000 };
  try {
    const doc = await RateLimitEntry.findOneAndUpdate({ _id: id }, update, options);
    return doc.count;
  } catch (err) {
    // Concurrent upsert of the same key: retry once (the doc now exists).
    if (err && err.code === 11000) {
      const doc = await RateLimitEntry.findOneAndUpdate({ _id: id }, update, options);
      return doc.count;
    }
    throw err;
  }
}

async function hit(id, windowMs) {
  const { windowStart, windowEnd } = getWindow(Date.now(), windowMs);
  const windowId = `${id}:${windowStart}`;
  if (useMongoStore()) {
    try {
      return { count: await incrementMongo(windowId, windowEnd), windowEnd };
    } catch (err) {
      // Fall through to memory so a DB hiccup never blocks requests.
    }
  }
  return { count: incrementMemory(windowId, windowEnd), windowEnd };
}

const ipKey = (req) => String(req.ip || req.socket?.remoteAddress || 'unknown');
// Must run after authMiddleware to key by user.
const userOrIpKey = (req) => (req.userId ? `u:${req.userId}` : `ip:${ipKey(req)}`);

/**
 * @param {object} opts
 * @param {number} [opts.windowMs]
 * @param {number} [opts.max] allowed requests per window
 * @param {string} [opts.message]
 * @param {string} [opts.name] limiter namespace; defaults to the request path
 * @param {(req) => string} [opts.keyGenerator] defaults to client IP
 */
const createRateLimiter = ({ windowMs = 60_000, max = 5, message, name, keyGenerator } = {}) => {
  const getKey = keyGenerator || ipKey;

  return async (req, res, next) => {
    let result;
    try {
      const scope = name || `path:${req.path}`;
      result = await hit(`${scope}:${getKey(req)}`, windowMs);
    } catch (err) {
      return next();
    }
    if (result.count > max) {
      const retryAfter = Math.max(1, Math.ceil((result.windowEnd - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || 'Too many requests. Try again later.',
        retry_after_seconds: retryAfter,
      });
    }
    return next();
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
    store: useMongoStore() ? 'mongo' : 'memory',
    total: entries.length,
    entries,
  };
};

function resetMemoryStore() {
  store.clear();
}

module.exports = {
  createRateLimiter,
  getRateLimitStats,
  ipKey,
  userOrIpKey,
  resetMemoryStore,
};
