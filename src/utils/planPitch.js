// The per-plan "upgrade pitch" shown in the student Upgrade dialog, and the
// tier that orders plans for entitlement (spec §4). Pure validation so the
// controller stays a thin pass-through.
const { normalizeFeatures } = require('./planFeatures');

const PITCH_ICONS = ['video', 'notes', 'questions', 'live', 'doubt', 'ai', 'analytics', 'star', 'check'];
const PITCH_MAX_HIGHLIGHTS = 6;
const PITCH_TEXT_MAX = 120;

// Final fix wave C1: a plan "has no tier" only when the field is absent or
// null. `tier` carries a schema default of 0, so a document that has been
// through Mongo always has one — which is exactly why the startup backfill
// alone cannot be the whole guard (see validatePlanFields and
// entitlement.tierOf for the other two layers).
function hasTier(plan) {
  const tier = plan?.tier;
  return tier !== undefined && tier !== null && Number.isFinite(Number(tier));
}

// Pure: the tier to write for every plan that has none yet, as
// [{ _id, tier }]. Free plans (price <= 0) rank 0; paid plans rank 1, 2, 3…
// ordered by (sort_order, then price), so the cheaper plan always ends up
// strictly below the dearer one. Plans that already have a tier are preserved
// untouched and are not re-ranked, which makes this idempotent: run it again
// after applying its output and it returns nothing.
//
// Replaces "copy sort_order into tier", which put every plan sharing the
// default sort_order 0 — including paid ones — at tier 0, i.e. unlocked for
// every free student.
function assignMissingTiers(plans) {
  const missing = (plans || []).filter((plan) => plan && !hasTier(plan));
  const priceOf = (plan) => (Number.isFinite(Number(plan.price)) ? Number(plan.price) : 0);
  const free = missing.filter((plan) => priceOf(plan) <= 0).map((plan) => ({ _id: plan._id, tier: 0 }));
  const paid = missing
    .filter((plan) => priceOf(plan) > 0)
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : 0;
      const orderB = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0;
      return orderA - orderB || priceOf(a) - priceOf(b);
    })
    .map((plan, index) => ({ _id: plan._id, tier: index + 1 }));
  return [...free, ...paid];
}

// `existing` is the stored plan a PATCH is being merged onto — null on create,
// where the absent fields take their schema defaults (price 0, tier 0).
function validatePlanFields(body, existing) {
  const value = { ...(body || {}) };
  if (Object.prototype.hasOwnProperty.call(value, 'tier')) {
    const tier = Number(value.tier);
    if (!Number.isInteger(tier) || tier < 0) return { ok: false, error: 'tier must be a whole number of 0 or more' };
    value.tier = tier;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'pitch')) {
    const pitch = value.pitch;
    if (!pitch || typeof pitch !== 'object' || Array.isArray(pitch)) return { ok: false, error: 'pitch must be an object' };
    const headline = String(pitch.headline || '').trim();
    if (headline.length > PITCH_TEXT_MAX) return { ok: false, error: `pitch headline must be ${PITCH_TEXT_MAX} characters or fewer` };
    const rawHighlights = Array.isArray(pitch.highlights) ? pitch.highlights : [];
    if (rawHighlights.length > PITCH_MAX_HIGHLIGHTS) return { ok: false, error: `pitch may have at most ${PITCH_MAX_HIGHLIGHTS} highlights` };
    const highlights = [];
    for (const item of rawHighlights) {
      const icon = String(item?.icon || '');
      const text = String(item?.text || '').trim();
      if (!PITCH_ICONS.includes(icon)) return { ok: false, error: `Unknown highlight icon "${icon}"` };
      if (!text || text.length > PITCH_TEXT_MAX) return { ok: false, error: `Each highlight needs text of 1–${PITCH_TEXT_MAX} characters` };
      highlights.push({ icon, text });
    }
    value.pitch = { headline, highlights, banner_url: String(pitch.banner_url || '').trim() };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'features')) {
    const result = normalizeFeatures(value.features);
    if (!result.ok) return { ok: false, error: result.error };
    value.features = result.value;
  }
  // C1: refuse a paid plan at tier 0, judged on the MERGED document — a patch
  // that only drops the tier, and a patch that only adds a price, are both the
  // same mistake. A field absent from both body and `existing` takes the
  // schema default (0), so creating a paid plan without touching Tier is
  // refused rather than silently stored at tier 0.
  const merged = (field, fallback) => {
    if (Object.prototype.hasOwnProperty.call(value, field)) return value[field];
    if (existing && Object.prototype.hasOwnProperty.call(existing, field) && existing[field] !== undefined && existing[field] !== null) {
      return existing[field];
    }
    return fallback;
  };
  if (Number(merged('price', 0)) > 0 && Number(merged('tier', 0)) === 0) {
    return { ok: false, error: 'A paid plan needs a tier of 1 or more' };
  }
  return { ok: true, value };
}

module.exports = { PITCH_ICONS, PITCH_MAX_HIGHLIGHTS, PITCH_TEXT_MAX, validatePlanFields, assignMissingTiers };
