// The feature catalogue gating AI Tutor / AI Summary / Transcript (spec §2).
// Extensible — nothing else is feature-gated yet. Kept separate from
// entitlement.js so the pure catalogue/validation logic has no dependency on
// plans or viewers.
const PLAN_FEATURES = ['ai_tutor', 'ai_summary', 'transcript'];

const PLAN_FEATURE_LABELS = {
  ai_tutor: 'AI Tutor',
  ai_summary: 'AI Summary',
  transcript: 'Transcript',
};

// Pure: validates a plan's `features` list against the catalogue. Dedupes,
// re-orders to the catalogue order (so storage and comparisons are stable
// regardless of the order an admin ticked boxes in), and rejects anything
// that isn't an array or that names a key outside PLAN_FEATURES.
function normalizeFeatures(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'features must be an array' };
  const seen = new Set();
  for (const item of list) {
    const key = String(item ?? '').trim();
    if (!PLAN_FEATURES.includes(key)) return { ok: false, error: `Unknown feature "${key}"` };
    seen.add(key);
  }
  return { ok: true, value: PLAN_FEATURES.filter((f) => seen.has(f)) };
}

module.exports = { PLAN_FEATURES, PLAN_FEATURE_LABELS, normalizeFeatures };
