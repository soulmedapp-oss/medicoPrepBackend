const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlanFields, PITCH_ICONS } = require('../src/utils/planPitch');

// Final fix wave C1 changed the fixture here from `{ display_name, price: 999 }`
// to a body that also carries a tier: a paid plan with no tier is now refused
// (the schema default would store it at tier 0 — see the C1 tests below). The
// point of this test is unchanged: fields other than tier/pitch pass through
// exactly as given.
test('validatePlanFields: passes through a body without pitch untouched', () => {
  const r = validatePlanFields({ display_name: 'Elite', price: 999, tier: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { display_name: 'Elite', price: 999, tier: 2 });
});

test('validatePlanFields: tier must be an integer >= 0', () => {
  assert.equal(validatePlanFields({ tier: -1 }).ok, false);
  assert.equal(validatePlanFields({ tier: 1.5 }).ok, false);
  assert.equal(validatePlanFields({ tier: 'x' }).ok, false);
  const r = validatePlanFields({ tier: '2' });
  assert.equal(r.ok, true);
  assert.equal(r.value.tier, 2, 'numeric strings from a form are coerced');
});

test('validatePlanFields: pitch shape — headline length, <=6 highlights, known icons, trimmed text', () => {
  const good = validatePlanFields({ pitch: {
    headline: '  Everything you need  ',
    highlights: [{ icon: 'video', text: ' 500+ lectures ' }, { icon: 'live', text: 'Weekly live classes' }],
    banner_url: 'https://cdn/x.png',
  } });
  assert.equal(good.ok, true, good.error);
  assert.equal(good.value.pitch.headline, 'Everything you need');
  assert.deepEqual(good.value.pitch.highlights[0], { icon: 'video', text: '500+ lectures' });

  assert.match(validatePlanFields({ pitch: { headline: 'x'.repeat(121) } }).error, /headline/i);
  assert.match(validatePlanFields({ pitch: { highlights: Array.from({ length: 7 }, () => ({ icon: 'star', text: 'a' })) } }).error, /6/);
  assert.match(validatePlanFields({ pitch: { highlights: [{ icon: 'rocket', text: 'a' }] } }).error, /icon/i);
  assert.match(validatePlanFields({ pitch: { highlights: [{ icon: 'star', text: '' }] } }).error, /text/i);
  assert.match(validatePlanFields({ pitch: { highlights: [{ icon: 'star', text: 'x'.repeat(121) }] } }).error, /text/i);
  assert.equal(validatePlanFields({ pitch: 'nope' }).ok, false);
  assert.ok(PITCH_ICONS.includes('check'));
});

// Final fix wave C1 — a paid plan must never sit at tier 0. `tier` has a
// schema default of 0, so a paid plan created without touching the Tier field
// would otherwise be stored at tier 0 and unlock every gated thing it names
// for every free student (fail-open paywall). Three layers guard it:
// assignMissingTiers (startup backfill), validatePlanFields (the API refusal),
// and entitlement.tierOf (the runtime safety net, in entitlement.test.js).
const { assignMissingTiers } = require('../src/utils/planPitch');

test('assignMissingTiers: a free plan with no tier is ranked 0', () => {
  assert.deepEqual(
    assignMissingTiers([{ _id: 'f', plan_name: 'free', price: 0, sort_order: 0 }]),
    [{ _id: 'f', tier: 0 }]
  );
});

test('assignMissingTiers: three paid plans sharing sort_order 0 are ranked 1,2,3 by price', () => {
  const out = assignMissingTiers([
    { _id: 'c', plan_name: 'ultimate', price: 2999, sort_order: 0 },
    { _id: 'a', plan_name: 'basic', price: 499, sort_order: 0 },
    { _id: 'b', plan_name: 'premium', price: 1499, sort_order: 0 },
  ]);
  assert.deepEqual(out, [{ _id: 'a', tier: 1 }, { _id: 'b', tier: 2 }, { _id: 'c', tier: 3 }]);
});

test('assignMissingTiers: sort_order leads, price only breaks ties', () => {
  const out = assignMissingTiers([
    { _id: 'late', price: 100, sort_order: 5 },
    { _id: 'early', price: 9999, sort_order: 1 },
  ]);
  assert.deepEqual(out, [{ _id: 'early', tier: 1 }, { _id: 'late', tier: 2 }]);
});

test('assignMissingTiers: an existing tier is untouched and never re-ranked', () => {
  const out = assignMissingTiers([
    { _id: 'keep', price: 999, sort_order: 0, tier: 7 },
    { _id: 'fill', price: 499, sort_order: 0 },
  ]);
  assert.deepEqual(out, [{ _id: 'fill', tier: 1 }]);
});

test('assignMissingTiers: idempotent — nothing to fill once every plan has a tier', () => {
  const plans = [
    { _id: 'f', price: 0, tier: 0 },
    { _id: 'p', price: 999, tier: 1 },
  ];
  assert.deepEqual(assignMissingTiers(plans), []);
  assert.deepEqual(assignMissingTiers([]), []);
  assert.deepEqual(assignMissingTiers(null), []);
});

test('validatePlanFields: a paid plan at tier 0 is refused (create — tier defaults to 0)', () => {
  const r = validatePlanFields({ plan_name: 'elite', price: 999, tier: 0 }, null);
  assert.equal(r.ok, false);
  assert.match(r.error, /paid plan needs a tier of 1 or more/i);
  // No tier in the body at all is the same thing: the schema default is 0.
  assert.equal(validatePlanFields({ plan_name: 'elite', price: 999 }, null).ok, false);
  // A free plan at tier 0 is exactly right, and a tiered paid plan passes.
  assert.equal(validatePlanFields({ plan_name: 'free', price: 0, tier: 0 }, null).ok, true);
  assert.equal(validatePlanFields({ plan_name: 'elite', price: 999, tier: 2 }, null).ok, true);
});

test('validatePlanFields: the refusal reads the MERGED document, not just the patch', () => {
  // Dropping an existing paid plan to tier 0.
  assert.equal(validatePlanFields({ tier: 0 }, { price: 999, tier: 2 }).ok, false);
  // Putting a price on a plan that is still sitting at tier 0.
  assert.equal(validatePlanFields({ price: 999 }, { price: 0, tier: 0 }).ok, false);
  // An unrelated edit to an already-valid paid plan is left alone.
  assert.equal(validatePlanFields({ display_name: 'Elite' }, { price: 999, tier: 2 }).ok, true);
  // Making a paid plan free at the same time is fine.
  assert.equal(validatePlanFields({ price: 0, tier: 0 }, { price: 999, tier: 2 }).ok, true);
});

test('validatePlanFields: features validated via normalizeFeatures — dedupe/reorder on success, 400 on an unknown key or non-array', () => {
  const r = validatePlanFields({ features: ['transcript', 'ai_tutor', 'transcript'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.features, ['ai_tutor', 'transcript']);
  assert.match(validatePlanFields({ features: ['downloads'] }).error, /Unknown feature/);
  assert.equal(validatePlanFields({ features: 'ai_tutor' }).ok, false);
  // A body without `features` at all passes through untouched, same as tier/pitch.
  assert.equal(Object.prototype.hasOwnProperty.call(validatePlanFields({ display_name: 'Elite' }).value, 'features'), false);
});

test('validatePlanFields: card_points are trimmed, blanks dropped, capped at 12 lines of 120 chars; mode must be append|replace', () => {
  const ok = validatePlanFields({ card_points: ['  Doubt answers within 24h ', '', 'Weekly live revision'], card_points_mode: 'replace' });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.value.card_points, ['Doubt answers within 24h', 'Weekly live revision']);
  assert.equal(ok.value.card_points_mode, 'replace');
  assert.match(validatePlanFields({ card_points: 'x' }).error, /list/);
  assert.match(validatePlanFields({ card_points: Array.from({ length: 13 }, () => 'a') }).error, /12/);
  assert.match(validatePlanFields({ card_points: ['x'.repeat(121)] }).error, /120/);
  assert.match(validatePlanFields({ card_points_mode: 'only' }).error, /append or replace/);
});
