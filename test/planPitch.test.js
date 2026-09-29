const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlanFields, PITCH_ICONS } = require('../src/utils/planPitch');

test('validatePlanFields: passes through a body without tier/pitch untouched', () => {
  const r = validatePlanFields({ display_name: 'Elite', price: 999 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { display_name: 'Elite', price: 999 });
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
