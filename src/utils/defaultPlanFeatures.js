// The one-time seed for a plan's `features` list (spec §2), pulled out of
// server.js so the mapping itself is testable without booting the app.
//
// Final fix wave I1: the seed used to match on the literal `plan_name`, so a
// catalogue that stores the legacy spellings — "medium" (premium) and
// "advance" (ultimate), which normalizePlanName has always mapped everywhere
// ELSE in this codebase — got no features at all, and every student on those
// plans lost AI Tutor / AI Summary / Transcript on deploy until an operator
// ticked the boxes by hand. Lookups are keyed on the normalized name, so
// case and the legacy aliases land on the right set.
const { normalizePlanName } = require('./entitlement');
const { normalizeFeatures } = require('./planFeatures');

// `medium` and `advance` are spelled out for the reader; normalizePlanName
// already folds them into premium/ultimate before the lookup, so they are
// documentation rather than live keys.
const DEFAULT_PLAN_FEATURES = {
  free: ['transcript'],
  basic: ['transcript', 'ai_summary'],
  premium: ['ai_tutor', 'ai_summary', 'transcript'],
  ultimate: ['ai_tutor', 'ai_summary', 'transcript'],
  medium: ['ai_tutor', 'ai_summary', 'transcript'], // legacy name for premium
  advance: ['ai_tutor', 'ai_summary', 'transcript'], // legacy name for ultimate
};

// Pure. The stored plan_name in, a FRESH array in catalogue order out (so what
// is written to Mongo is stable regardless of how the default was typed), or
// null for a name the seed does not recognize — a custom plan is left with no
// `features` field for an operator to fill in, never guessed at.
function defaultFeaturesFor(planName) {
  const defaults = DEFAULT_PLAN_FEATURES[normalizePlanName(planName)];
  if (!defaults) return null;
  const normalized = normalizeFeatures(defaults);
  return normalized.ok ? normalized.value : null;
}

module.exports = { DEFAULT_PLAN_FEATURES, defaultFeaturesFor };
