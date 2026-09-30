const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canAccessPlaylist,
  visibleItems,
  isLecturePlayable,
  countVisibleItems,
} = require('../src/utils/playlistAccess');
const { buildViewer } = require('../src/utils/entitlement');

// Entitlement is decided from the plans' admin-set `tier` (Task 2), so these
// fixtures stand in for the active SubscriptionPlan rows a request would load.
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'basic', display_name: 'Basic', tier: 1, is_active: true },
  { plan_name: 'gold', display_name: 'Gold', tier: 2, is_active: true },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
  { plan_name: 'ultimate', display_name: 'Ultimate', tier: 3, is_active: true },
];
const viewer = (subscription_plan) => buildViewer({ subscription_plan }, PLANS);

test('is_free wins over allowed_plans', () => {
  assert.equal(canAccessPlaylist({ is_free: true, allowed_plans: ['gold'] }, viewer('free')), true);
});

test('empty allowed_plans means every plan', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: [] }, viewer('free')), true);
});

// Task 2: the rule is tier-based, not an exact name match — an `ultimate`
// (tier 3) viewer now opens a `premium` (tier 2) playlist, and a plan the
// admin never defined ("gold" absent from PLANS) still locks rather than
// silently unlocking.
test('a higher tier includes every lower one: an ultimate viewer opens a premium playlist', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: ['premium'] }, viewer('ultimate')), true);
  assert.equal(canAccessPlaylist({ allowed_plans: ['premium'] }, viewer('premium')), true);
  assert.equal(canAccessPlaylist({ allowed_plans: ['premium'] }, viewer('basic')), false);
});

// A required plan no active SubscriptionPlan row defines falls back to
// tier 1 — "a paid plan" — so it locks for free viewers instead of silently
// unlocking, but any paying viewer still gets in.
test('an unknown required plan locks for a free viewer and never silently unlocks', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: ['platinum'] }, viewer('free')), false);
  assert.equal(canAccessPlaylist({ allowed_plans: ['platinum'] }, viewer('basic')), true);
});

test('a listed plan is allowed and an unlisted one is not', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: ['gold'] }, viewer('gold')), true);
  assert.equal(canAccessPlaylist({ allowed_plans: ['gold'] }, viewer('free')), false);
});

// Review Focus #4 — intended, pinned so tightening it is deliberate.
test('a lecture in a free playlist is playable even if also in a paid one', () => {
  const lecture = { _id: 'L1', is_active: true };
  const playlists = [
    { is_published: true, is_active: true, is_free: false, allowed_plans: ['gold'], items: [{ lecture_id: 'L1' }] },
    { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: 'L1' }] },
  ];
  assert.equal(isLecturePlayable(lecture, playlists, viewer('free')), true);
});

// Review Focus #1
test('a lecture in no playlist is not playable', () => {
  assert.equal(isLecturePlayable({ _id: 'L1', is_active: true }, [], viewer('gold')), false);
});

test('an inactive lecture is never playable', () => {
  const playlists = [{ is_published: true, is_active: true, is_free: true, items: [{ lecture_id: 'L1' }] }];
  assert.equal(isLecturePlayable({ _id: 'L1', is_active: false }, playlists, viewer('free')), false);
});

test('an unpublished or inactive playlist does not grant access', () => {
  const l = { _id: 'L1', is_active: true };
  assert.equal(isLecturePlayable(l, [{ is_published: false, is_active: true, is_free: true, items: [{ lecture_id: 'L1' }] }], viewer('free')), false);
  assert.equal(isLecturePlayable(l, [{ is_published: true, is_active: false, is_free: true, items: [{ lecture_id: 'L1' }] }], viewer('free')), false);
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

test('countVisibleItems counts every item whose lecture is in the active set', () => {
  const playlist = { items: [{ lecture_id: 'A' }, { lecture_id: 'B' }] };
  const activeLectureIds = new Set(['A', 'B']);
  assert.equal(countVisibleItems(playlist, activeLectureIds), 2);
});

test('countVisibleItems excludes an item whose lecture is inactive', () => {
  const playlist = { items: [{ lecture_id: 'A' }, { lecture_id: 'B' }] };
  const activeLectureIds = new Set(['A']); // B is inactive, so it's absent from the set
  assert.equal(countVisibleItems(playlist, activeLectureIds), 1);
});

test('countVisibleItems excludes an item whose lecture is missing from the set', () => {
  const playlist = { items: [{ lecture_id: 'A' }, { lecture_id: 'GONE' }] };
  const activeLectureIds = new Set(['A']);
  assert.equal(countVisibleItems(playlist, activeLectureIds), 1);
});

test('countVisibleItems is 0 for an empty items array', () => {
  const playlist = { items: [] };
  assert.equal(countVisibleItems(playlist, new Set(['A'])), 0);
});

test('countVisibleItems is 0 when playlist.items is undefined', () => {
  assert.equal(countVisibleItems({}, new Set(['A'])), 0);
});

// Matches visibleItems: it de-dupes nothing, so a lecture listed twice in
// items renders (and counts) twice.
test('countVisibleItems counts a duplicated lecture_id twice, matching visibleItems', () => {
  const playlist = { items: [{ lecture_id: 'A' }, { lecture_id: 'A' }] };
  assert.equal(countVisibleItems(playlist, new Set(['A'])), 2);
});
