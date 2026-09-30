// A safety net under the per-field length checks in the controllers: no
// string anywhere in a JSON body may exceed DEFAULT_MAX_STRING characters,
// and no array may hold more than MAX_ARRAY_ITEMS entries. Controllers still
// enforce their own, tighter limits ("question must be 2-4000 characters");
// this middleware exists so a field nobody thought to check cannot arrive
// as a megabyte of text, today or in a route added next year.
//
// Routes with a legitimately large field (a lecture transcript, rich-text
// question explanation) mount `bodyLimits({ overrides: { transcript_text: 200000 } })`
// themselves; the app-level instance uses the defaults.

const DEFAULT_MAX_STRING = 20000;
const MAX_ARRAY_ITEMS = 2000;
const MAX_DEPTH = 12;

// Walks the body and returns { path, limit } for the first violation, or null.
function findOversized(value, { maxString, overrides, path = 'body', depth = 0 }) {
  if (depth > MAX_DEPTH) return { path, limit: MAX_DEPTH, kind: 'depth' };
  if (typeof value === 'string') {
    const key = path.split('.').pop().replace(/\[\d+\]$/, '');
    const limit = overrides[key] ?? maxString;
    return value.length > limit ? { path, limit, kind: 'string' } : null;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) return { path, limit: MAX_ARRAY_ITEMS, kind: 'array' };
    for (let i = 0; i < value.length; i += 1) {
      const hit = findOversized(value[i], { maxString, overrides, path: `${path}[${i}]`, depth: depth + 1 });
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findOversized(v, { maxString, overrides, path: `${path}.${k}`, depth: depth + 1 });
      if (hit) return hit;
    }
  }
  return null;
}

function describe(hit) {
  const field = hit.path.replace(/^body\.?/, '') || 'body';
  if (hit.kind === 'array') return `${field} may hold at most ${hit.limit} items`;
  if (hit.kind === 'depth') return 'Request body is nested too deeply';
  return `${field} must be ${hit.limit} characters or less`;
}

function bodyLimits({ maxString = DEFAULT_MAX_STRING, overrides = {} } = {}) {
  return function bodyLimitsMiddleware(req, res, next) {
    if (!req.body || typeof req.body !== 'object') return next();
    const hit = findOversized(req.body, { maxString, overrides });
    if (!hit) return next();
    return res.status(400).json({ error: describe(hit) });
  };
}

module.exports = { bodyLimits, findOversized, DEFAULT_MAX_STRING, MAX_ARRAY_ITEMS };
