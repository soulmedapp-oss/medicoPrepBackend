const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPlaylistPayload,
  normaliseItems,
  normaliseSubjectIds,
  invalidSubjectIds,
  onlyTogglesActive,
  browseFilter,
  playlistsForLecture,
  requiresDeactivatePermission,
} = require('../src/controllers/playlistsController');
const { STUDENT_LECTURE_FIELDS, studentPlaylistView } = require('../src/utils/studentProjection');

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


// --- Final fix wave, B8: the student-facing response shapes, pinned ---

// B8 (i). The one allowlist every student lecture read projects through. A
// field added to the Video schema is invisible to students until someone
// adds it here on purpose, and these four are the ones that must never
// arrive: the transcript (large), the Bunny identifiers (internal), staff
// provenance, and per-video entitlement (the playlist is the gate).
test('the student lecture allowlist exposes no transcript, bunny id, provenance or per-video entitlement', () => {
  ['transcript_text', 'bunny_', '_by', 'allowed_plans'].forEach((forbidden) => {
    assert.ok(
      !STUDENT_LECTURE_FIELDS.includes(forbidden),
      `student lecture projection must not mention ${forbidden}`
    );
  });
});

// B6/B8 (ii). browsePlaylists used to spread the whole lean document and
// getPlaylist returned it raw, so students received items (the full lecture
// id list), created_by/updated_by/updated_by_at (staff provenance) and the
// is_published/is_active/created_date/updated_date curation state.
test('studentPlaylistView keeps exactly the six student fields and drops the rest', () => {
  const view = studentPlaylistView({
    _id: 'p1',
    name: 'ENT',
    description: 'd',
    subject_ids: ['s1'],
    allowed_plans: ['gold'],
    is_free: false,
    items: [{ lecture_id: 'L1', order: 0 }],
    created_by: 'admin-1',
    updated_by: 'admin-2',
    updated_by_at: '2026-09-01',
    is_published: true,
    is_active: true,
    created_date: '2026-08-01',
    updated_date: '2026-09-01',
    __v: 3,
  });
  assert.deepEqual(
    Object.keys(view).sort(),
    ['_id', 'allowed_plans', 'description', 'is_free', 'name', 'subject_ids']
  );
});

test('studentPlaylistView carries lecture_count through when the browse read supplies one', () => {
  const view = studentPlaylistView({ _id: 'p1', name: 'ENT' }, { lecture_count: 4 });
  assert.equal(view.lecture_count, 4);
  assert.deepEqual(
    Object.keys(view).sort(),
    ['_id', 'allowed_plans', 'description', 'is_free', 'lecture_count', 'name', 'subject_ids']
  );
});

test('studentPlaylistView never lets an extra field smuggle items or provenance back in', () => {
  const view = studentPlaylistView({ _id: 'p1', name: 'ENT', items: [{ lecture_id: 'L1' }] }, { items: 'x', created_by: 'admin' });
  assert.equal(view.items, undefined);
  assert.equal(view.created_by, undefined);
});

test('studentPlaylistView tolerates a missing playlist rather than throwing', () => {
  assert.doesNotThrow(() => assert.equal(studentPlaylistView(null), null));
});

// B5/B8 (iii). A deactivate-only role (CanDeactivateVideos without
// CanAddVideos/CanEditVideos) may flip is_active and nothing else, so the
// PATCH route can admit it without also handing it the edit surface.
test('onlyTogglesActive accepts a body that changes is_active alone', () => {
  assert.equal(onlyTogglesActive({ is_active: true }), true);
  assert.equal(onlyTogglesActive({ is_active: false }), true);
});

test('onlyTogglesActive rejects a body that changes anything besides is_active', () => {
  assert.equal(onlyTogglesActive({ is_active: true, name: 'x' }), false);
  assert.equal(onlyTogglesActive({ name: 'x' }), false);
  assert.equal(onlyTogglesActive({ is_published: true }), false);
});

test('onlyTogglesActive rejects an empty or missing body rather than treating it as a toggle', () => {
  assert.equal(onlyTogglesActive({}), false);
  assert.equal(onlyTogglesActive(null), false);
  assert.equal(onlyTogglesActive(undefined), false);
});

// B11. subject_ids is ObjectId-typed: an element like 'abc' reached Mongoose
// as a cast attempt and surfaced as a CastError 500. The array shape was
// validated; its elements were not.
test('normaliseSubjectIds drops an element that is not a well-formed ObjectId', () => {
  const valid = '507f1f77bcf86cd799439011';
  assert.deepEqual(normaliseSubjectIds([valid, 'abc', '']), [valid]);
});

test('normaliseSubjectIds still trims, de-duplicates and preserves order', () => {
  const a = '507f1f77bcf86cd799439011';
  const b = '507f1f77bcf86cd799439012';
  assert.deepEqual(normaliseSubjectIds([` ${b} `, a, b]), [b, a]);
});

test('invalidSubjectIds names the malformed elements so the controller can answer 400, not 500', () => {
  const valid = '507f1f77bcf86cd799439011';
  assert.deepEqual(invalidSubjectIds(['abc']), ['abc']);
  assert.deepEqual(invalidSubjectIds([valid]), []);
  assert.deepEqual(invalidSubjectIds(undefined), []);
  assert.deepEqual(invalidSubjectIds('not-an-array'), []);
});
