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
