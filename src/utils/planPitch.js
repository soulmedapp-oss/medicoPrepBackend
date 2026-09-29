// The per-plan "upgrade pitch" shown in the student Upgrade dialog, and the
// tier that orders plans for entitlement (spec §4). Pure validation so the
// controller stays a thin pass-through.
const PITCH_ICONS = ['video', 'notes', 'questions', 'live', 'doubt', 'ai', 'analytics', 'star', 'check'];
const PITCH_MAX_HIGHLIGHTS = 6;
const PITCH_TEXT_MAX = 120;

function validatePlanFields(body) {
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
  return { ok: true, value };
}

module.exports = { PITCH_ICONS, PITCH_MAX_HIGHLIGHTS, PITCH_TEXT_MAX, validatePlanFields };
