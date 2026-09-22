const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPlaylistPayload,
  normaliseItems,
  browseFilter,
  playlistsForLecture,
  requiresDeactivatePermission,
} = require('../src/controllers/playlistsController');

const user = (...perms) => ({ effective_permissions: perms });

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

// Task 4 — student browsing. Entitlement (is_free / allowed_plans) is
// applied in code via canAccessPlaylist after the query, never folded into
// this filter — see browseFilter's own comment for why.
test('browse filter always constrains to published and active', () => {
  const f = browseFilter(null);
  assert.equal(f.is_published, true);
  assert.deepEqual(f.is_active, { $ne: false });
});

test('a subject filter narrows by subject_ids', () => {
  const validId = '507f1f77bcf86cd799439011';
  assert.deepEqual(browseFilter(validId).subject_ids, validId);
});

test('no subject filter leaves subject_ids unconstrained', () => {
  assert.ok(!('subject_ids' in browseFilter(null)));
});

// Fix round 1, Minor 2: subject_ids is ObjectId-typed — an unresolvable/
// malformed subject_id must filter to NOTHING, never throw a CastError at
// query time and never silently drop the filter (which would show every
// playlist). Same fail-closed contract as subjectResolution.js's
// buildSubjectFilter.
test('a malformed subject_id filters to nothing rather than throwing', () => {
  assert.deepEqual(browseFilter('not-an-object-id'), { _id: null });
  assert.deepEqual(browseFilter('s1'), { _id: null });
});

// Task 6 — "Also in". Review Focus #3: a playlist the student cannot access
// must not appear, even though it contains the lecture. Mixed set: one free
// (accessible), one paid the student lacks (inaccessible), one unpublished
// (inaccessible regardless of plan).
test('playlistsForLecture keeps only the free, published, entitled playlist from a mixed set', () => {
  const playlists = [
    { _id: 'free-pl', name: 'Free playlist', is_published: true, is_active: true, is_free: true, allowed_plans: [] },
    { _id: 'gold-pl', name: 'Gold playlist', is_published: true, is_active: true, is_free: false, allowed_plans: ['gold'] },
    { _id: 'draft-pl', name: 'Draft playlist', is_published: false, is_active: true, is_free: true, allowed_plans: [] },
  ];
  const out = playlistsForLecture(playlists, 'free');
  assert.deepEqual(out, [{ _id: 'free-pl', name: 'Free playlist' }]);
});

test('playlistsForLecture drops an inactive playlist even if published and free', () => {
  const playlists = [
    { _id: 'inactive-pl', name: 'Retired', is_published: true, is_active: false, is_free: true, allowed_plans: [] },
  ];
  assert.deepEqual(playlistsForLecture(playlists, 'free'), []);
});

test('playlistsForLecture projects only _id and name, nothing else', () => {
  const playlists = [
    { _id: 'p1', name: 'P1', is_published: true, is_active: true, is_free: true, allowed_plans: [], description: 'secret', items: [{ lecture_id: 'x' }] },
  ];
  assert.deepEqual(Object.keys(playlistsForLecture(playlists, 'free')[0]).sort(), ['_id', 'name']);
});

test('playlistsForLecture handles an empty or missing list without throwing', () => {
  assert.deepEqual(playlistsForLecture([], 'free'), []);
  assert.deepEqual(playlistsForLecture(undefined, 'free'), []);
});

// Fix round 1, Important 1 — permission parity with videos. updatePlaylist's
// own PATCH-vs-CanDeactivateVideos decision, exercised directly with plain
// objects (missingUpdatePermissions is already pure — no req/res needed —
// see test/rbacUpdatePermissions.test.js for its own exhaustive coverage of
// the fail-closed comparison this delegates to).
test('requiresDeactivatePermission: editing other fields never needs CanDeactivateVideos', () => {
  assert.equal(
    requiresDeactivatePermission(user('CanEditVideos'), { name: 'x' }, { is_active: true }),
    false
  );
  assert.equal(
    requiresDeactivatePermission(user(), { name: 'x' }, { is_active: true }),
    false
  );
});

test('requiresDeactivatePermission: flipping is_active needs CanDeactivateVideos, in both directions', () => {
  assert.equal(
    requiresDeactivatePermission(user('CanEditVideos'), { is_active: false }, { is_active: true }),
    true
  );
  assert.equal(
    requiresDeactivatePermission(user('CanEditVideos'), { is_active: true }, { is_active: false }),
    true
  );
  assert.equal(
    requiresDeactivatePermission(user('CanDeactivateVideos'), { is_active: false }, { is_active: true }),
    false
  );
});

test('requiresDeactivatePermission: a strict-boolean echo of the stored value needs nothing extra', () => {
  assert.equal(
    requiresDeactivatePermission(user('CanEditVideos'), { name: 'x', is_active: true }, { is_active: true }),
    false
  );
});

test('requiresDeactivatePermission: a non-strict-boolean is_active still fails closed', () => {
  assert.equal(
    requiresDeactivatePermission(user('CanEditVideos'), { is_active: 'false' }, { is_active: true }),
    true
  );
});
