const test = require('node:test');
const assert = require('node:assert/strict');
const { canAccessPlaylist, visibleItems, isLecturePlayable } = require('../src/utils/playlistAccess');

test('is_free wins over allowed_plans', () => {
  assert.equal(canAccessPlaylist({ is_free: true, allowed_plans: ['gold'] }, 'free'), true);
});

test('empty allowed_plans means every plan', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: [] }, 'free'), true);
});

test('a listed plan is allowed and an unlisted one is not', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: ['gold'] }, 'gold'), true);
  assert.equal(canAccessPlaylist({ allowed_plans: ['gold'] }, 'free'), false);
});

// Review Focus #4 — intended, pinned so tightening it is deliberate.
test('a lecture in a free playlist is playable even if also in a paid one', () => {
  const lecture = { _id: 'L1', is_active: true };
  const playlists = [
    { is_published: true, is_active: true, is_free: false, allowed_plans: ['gold'], items: [{ lecture_id: 'L1' }] },
    { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: 'L1' }] },
  ];
  assert.equal(isLecturePlayable(lecture, playlists, 'free'), true);
});

// Review Focus #1
test('a lecture in no playlist is not playable', () => {
  assert.equal(isLecturePlayable({ _id: 'L1', is_active: true }, [], 'gold'), false);
});

test('an inactive lecture is never playable', () => {
  const playlists = [{ is_published: true, is_active: true, is_free: true, items: [{ lecture_id: 'L1' }] }];
  assert.equal(isLecturePlayable({ _id: 'L1', is_active: false }, playlists, 'free'), false);
});

test('an unpublished or inactive playlist does not grant access', () => {
  const l = { _id: 'L1', is_active: true };
  assert.equal(isLecturePlayable(l, [{ is_published: false, is_active: true, is_free: true, items: [{ lecture_id: 'L1' }] }], 'free'), false);
  assert.equal(isLecturePlayable(l, [{ is_published: true, is_active: false, is_free: true, items: [{ lecture_id: 'L1' }] }], 'free'), false);
});

// Review Focus #2
test('visibleItems drops inactive lectures without touching the playlist', () => {
  const playlist = { items: [{ lecture_id: 'A', order: 0 }, { lecture_id: 'B', order: 1 }] };
  const byId = new Map([['A', { _id: 'A', is_active: true }], ['B', { _id: 'B', is_active: false }]]);
  const out = visibleItems(playlist, byId);
  assert.deepEqual(out.map((l) => l._id), ['A']);
  assert.equal(playlist.items.length, 2, 'the playlist itself must not be mutated');
});

// Review Focus #5
test('equal order values keep a stable, repeatable sequence', () => {
  const playlist = { items: [{ lecture_id: 'B', order: 0 }, { lecture_id: 'A', order: 0 }] };
  const byId = new Map([['A', { _id: 'A', is_active: true }], ['B', { _id: 'B', is_active: true }]]);
  const first = visibleItems(playlist, byId).map((l) => l._id);
  const second = visibleItems(playlist, byId).map((l) => l._id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['B', 'A'], 'ties fall back to insertion order');
});

test('a missing lecture is skipped rather than throwing', () => {
  const playlist = { items: [{ lecture_id: 'GONE', order: 0 }] };
  assert.deepEqual(visibleItems(playlist, new Map()), []);
});
