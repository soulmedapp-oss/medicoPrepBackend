const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSubjectIds } = require('../src/utils/subjectResolution');

const subjects = [
  { _id: 's1', name: 'ENT', slug: 'ent' },
  { _id: 's2', name: 'Pharmacology', slug: 'pharmacology' },
];

test('resolves a subject string to its subject id', () => {
  const out = resolveSubjectIds([{ _id: 'v1', subject: 'ENT' }], subjects);
  assert.deepEqual(out.updates, [{ _id: 'v1', subject_id: 's1' }]);
  assert.deepEqual(out.unresolved, []);
});

// Review Focus #2: casing and whitespace must not split one subject into three.
test('resolves regardless of case and surrounding whitespace', () => {
  const out = resolveSubjectIds(
    [{ _id: 'a', subject: 'ent' }, { _id: 'b', subject: '  ENT  ' }, { _id: 'c', subject: 'ENT' }],
    subjects
  );
  assert.deepEqual(out.updates.map((u) => u.subject_id), ['s1', 's1', 's1']);
});

// Review Focus #1: an unmatched subject is reported, never defaulted.
test('reports an unmatched subject instead of assigning a default', () => {
  const out = resolveSubjectIds([{ _id: 'v9', subject: 'Astrology' }], subjects);
  assert.deepEqual(out.updates, []);
  assert.deepEqual(out.unresolved, [{ _id: 'v9', subject: 'Astrology' }]);
});

// Review Focus #3: idempotent.
test('skips videos that already carry a subject_id', () => {
  const out = resolveSubjectIds([{ _id: 'v1', subject: 'ENT', subject_id: 's1' }], subjects);
  assert.deepEqual(out.updates, []);
  assert.deepEqual(out.unresolved, []);
});

test('reports a video with no subject string rather than throwing', () => {
  const out = resolveSubjectIds([{ _id: 'v0', subject: '' }], subjects);
  assert.deepEqual(out.updates, []);
  assert.deepEqual(out.unresolved, [{ _id: 'v0', subject: '' }]);
});

const { subjectWriteFields } = require('../src/utils/subjectResolution');

test('a resolved subject writes both the id and the canonical name', () => {
  assert.deepEqual(
    subjectWriteFields({ _id: 's1', name: 'ENT' }),
    { subject_id: 's1', subject: 'ENT' }
  );
});

// Review Focus #4: an unresolved subject must not be written at all.
test('an unresolved subject yields no write fields', () => {
  assert.deepEqual(subjectWriteFields(null), {});
  assert.deepEqual(subjectWriteFields(undefined), {});
});

const { buildSubjectFilter } = require('../src/utils/subjectResolution');

// Review Focus #5: a filter that silently matches nothing is worse than an error.
test('subject filter uses subject_id when the subject resolves', () => {
  assert.deepEqual(buildSubjectFilter({ _id: 's1', name: 'ENT' }), { subject_id: 's1' });
});

test('an unresolvable subject filter matches nothing explicitly, not everything', () => {
  assert.deepEqual(buildSubjectFilter(null), { _id: null });
});
