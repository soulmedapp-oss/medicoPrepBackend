const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlaylistPayload, normaliseItems } = require('../src/controllers/playlistsController');

test('payload keeps only the fields a client may set', () => {
  const out = buildPlaylistPayload({ name: 'X', description: 'd', subject_ids: ['s1'], allowed_plans: ['gold'], is_free: true, is_published: true, created_by: 'HACK', items: [] });
  assert.deepEqual(Object.keys(out).sort(), ['allowed_plans', 'description', 'is_free', 'is_published', 'name', 'subject_ids']);
});

test('allowed_plans is trimmed and de-duplicated', () => {
  assert.deepEqual(buildPlaylistPayload({ name: 'X', allowed_plans: [' gold ', 'gold', ''] }).allowed_plans, ['gold']);
});

test('items are renumbered contiguously from zero, preserving given order', () => {
  assert.deepEqual(
    normaliseItems([{ lecture_id: 'B' }, { lecture_id: 'A' }, { lecture_id: 'C' }]),
    [{ lecture_id: 'B', order: 0 }, { lecture_id: 'A', order: 1 }, { lecture_id: 'C', order: 2 }]
  );
});

test('duplicate lectures are collapsed, keeping the first position', () => {
  assert.deepEqual(
    normaliseItems([{ lecture_id: 'A' }, { lecture_id: 'B' }, { lecture_id: 'A' }]),
    [{ lecture_id: 'A', order: 0 }, { lecture_id: 'B', order: 1 }]
  );
});

test('malformed items are dropped rather than stored', () => {
  assert.deepEqual(normaliseItems([{ lecture_id: '' }, null, 'x', { order: 3 }]), []);
});
