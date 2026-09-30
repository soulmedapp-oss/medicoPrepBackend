const test = require('node:test');
const assert = require('node:assert/strict');
const { PLAN_FEATURES, PLAN_FEATURE_LABELS, normalizeFeatures } = require('../src/utils/planFeatures');

test('normalizeFeatures: dedupes, keeps catalogue order, rejects unknown keys and non-arrays', () => {
  assert.deepEqual(normalizeFeatures(['transcript', 'ai_tutor', 'transcript']).value, ['ai_tutor', 'transcript']);
  assert.deepEqual(normalizeFeatures([]).value, []);
  assert.match(normalizeFeatures(['downloads']).error, /Unknown feature/);
  assert.equal(normalizeFeatures('ai_tutor').ok, false);
  assert.deepEqual(PLAN_FEATURES, ['ai_tutor', 'ai_summary', 'transcript']);
});

test('PLAN_FEATURE_LABELS: a label for every catalogue feature', () => {
  assert.deepEqual(PLAN_FEATURE_LABELS, { ai_tutor: 'AI Tutor', ai_summary: 'AI Summary', transcript: 'Transcript' });
});

// Final fix wave I1: the startup seed keys DEFAULT_PLAN_FEATURES on the
// NORMALIZED plan name, so a catalogue that stores the legacy spellings
// ("medium" = premium, "advance" = ultimate) or a different case still gets
// the right set instead of silently getting nothing.
const { DEFAULT_PLAN_FEATURES, defaultFeaturesFor } = require('../src/utils/defaultPlanFeatures');

test('defaultFeaturesFor: normalizes the plan name — legacy aliases and case included', () => {
  assert.deepEqual(defaultFeaturesFor('free'), ['transcript']);
  assert.deepEqual(defaultFeaturesFor('basic'), ['ai_summary', 'transcript']);
  assert.deepEqual(defaultFeaturesFor('premium'), ['ai_tutor', 'ai_summary', 'transcript']);
  assert.deepEqual(defaultFeaturesFor('ultimate'), ['ai_tutor', 'ai_summary', 'transcript']);
  // The two that used to fall through to nothing.
  assert.deepEqual(defaultFeaturesFor('medium'), defaultFeaturesFor('premium'), 'medium is premium');
  assert.deepEqual(defaultFeaturesFor('advance'), defaultFeaturesFor('ultimate'), 'advance is ultimate');
  // Case and surrounding space are normalized away too.
  assert.deepEqual(defaultFeaturesFor('Premium'), ['ai_tutor', 'ai_summary', 'transcript']);
  assert.deepEqual(defaultFeaturesFor('  MEDIUM '), ['ai_tutor', 'ai_summary', 'transcript']);
});

test('defaultFeaturesFor: an unrecognized or missing name seeds nothing, and every default is a catalogue feature', () => {
  assert.equal(defaultFeaturesFor('gold'), null);
  assert.equal(defaultFeaturesFor(''), null);
  assert.equal(defaultFeaturesFor(undefined), null);
  // A fresh array every call — the caller writes it into Mongo.
  assert.notEqual(defaultFeaturesFor('free'), defaultFeaturesFor('free'));
  for (const [name, features] of Object.entries(DEFAULT_PLAN_FEATURES)) {
    assert.deepEqual(normalizeFeatures(features).ok, true, `${name}'s defaults are catalogue features`);
  }
  assert.ok(DEFAULT_PLAN_FEATURES.medium && DEFAULT_PLAN_FEATURES.advance, 'the legacy names are spelled out for the reader');
});
