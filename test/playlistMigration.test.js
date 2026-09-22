const test = require('node:test');
const assert = require('node:assert/strict');
const { planPlaylistsFromVideos, classifyLogInsertError } = require('../src/utils/playlistMigration');

test('an empty input yields no playlists and no unplaced rows, without throwing', () => {
  assert.deepEqual(planPlaylistsFromVideos([]), {
    playlists: [],
    unpublished: [],
    missingSubjectId: [],
    grants: [],
  });
});

test('one playlist per distinct subject_id, built only from published videos', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, order: 0 },
    { _id: 'b', subject_id: 's2', subject: 'Pharmacology', is_published: true, order: 0 },
    { _id: 'c', subject_id: 's1', subject: 'ENT', is_published: true, order: 1 },
  ]);
  assert.equal(out.playlists.length, 2);
  const byName = new Map(out.playlists.map((p) => [p.name, p]));
  assert.deepEqual(byName.get('ENT').subject_ids, ['s1']);
  assert.equal(byName.get('ENT').items.length, 2);
  assert.deepEqual(byName.get('Pharmacology').subject_ids, ['s2']);
  assert.equal(byName.get('Pharmacology').items.length, 1);
});

test('plans are UNIONED across member videos, never intersected', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 0 },
    { _id: 'b', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['silver'], order: 1 },
  ]);
  assert.equal(out.playlists.length, 1);
  assert.deepEqual(out.playlists[0].allowed_plans.sort(), ['gold', 'silver']);
});

// Fix round 1, Minor 5: allowed_plans: null must contribute nothing to the
// union, never be read as "all plans".
test('a member with allowed_plans: null contributes no plans to the union', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: null, order: 0 },
    { _id: 'b', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 1 },
  ]);
  assert.equal(out.playlists.length, 1);
  assert.deepEqual(out.playlists[0].allowed_plans, ['gold']);
});

// Fix round 1, Minor 6: the same plan on two members must appear once.
test('the union de-duplicates a plan shared by two members', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 0 },
    { _id: 'b', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 1 },
  ]);
  assert.deepEqual(out.playlists[0].allowed_plans, ['gold']);
});

// Fix round 1, Minor 7: grouping is by subject_id, never by the display
// string — two distinct subjects that happen to share a name (a renamed
// or duplicate Subject row) must never be merged into one playlist.
test('two distinct subject_ids sharing one display string produce two playlists, never a merge', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, order: 0 },
    { _id: 'b', subject_id: 's2', subject: 'ENT', is_published: true, order: 0 },
  ]);
  assert.equal(out.playlists.length, 2);
  assert.deepEqual(out.playlists.map((p) => p.subject_ids[0]).sort(), ['s1', 's2']);
});

test('any is_free member makes the whole playlist free', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, is_free: false, order: 0 },
    { _id: 'b', subject_id: 's1', subject: 'ENT', is_published: true, is_free: true, order: 1 },
  ]);
  assert.equal(out.playlists[0].is_free, true);
});

test('a playlist with no free member stays paid', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, is_free: false, order: 0 },
  ]);
  assert.equal(out.playlists[0].is_free, false);
});

test('items are ordered by order then created_date, renumbered contiguously from 0', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, order: 5, created_date: '2026-01-01' },
    { _id: 'b', subject_id: 's1', subject: 'ENT', is_published: true, order: 1, created_date: '2026-01-02' },
    { _id: 'c', subject_id: 's1', subject: 'ENT', is_published: true, order: 1, created_date: '2026-01-01' },
  ]);
  assert.deepEqual(out.playlists[0].items, [
    { lecture_id: 'c', order: 0 },
    { lecture_id: 'b', order: 1 },
    { lecture_id: 'a', order: 2 },
  ]);
});

// Fix round 3, Important 3: the two "not placed" outcomes are NOT the same
// news. An unpublished video staying out of every playlist is the expected
// result of spec §6 step 4; a published video with no subject_id means the
// subject backfill has not finished and an operator must act. They used to
// share one `unmigrated` list and one non-zero exit, so the run that needed
// attention looked exactly like the run that did not.
test('unpublished videos join no playlist and are reported as unpublished, not as a problem', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: false, order: 0 },
  ]);
  assert.equal(out.playlists.length, 0);
  assert.deepEqual(out.unpublished, [{ _id: 'a', subject: 'ENT' }]);
  assert.deepEqual(out.missingSubjectId, []);
});

test('a published video with no subject_id is reported separately, as the case needing action', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject: 'ENT', is_published: true, order: 0 },
  ]);
  assert.equal(out.playlists.length, 0);
  assert.deepEqual(out.missingSubjectId, [{ _id: 'a', subject: 'ENT' }]);
  assert.deepEqual(out.unpublished, []);
});

test('a mix of unpublished and no-subject_id rows lands one row in each list, never pooled', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: false, order: 0 },
    { _id: 'b', subject: 'ENT', is_published: true, order: 0 },
  ]);
  assert.equal(out.playlists.length, 0);
  assert.deepEqual(out.unpublished.map((row) => row._id), ['a']);
  assert.deepEqual(out.missingSubjectId.map((row) => row._id), ['b']);
});

// An unpublished video with no subject_id is reported once, as unpublished:
// its missing subject_id is not an operator problem while it is out of
// every playlist anyway, and double-reporting it would make the exit code
// non-zero for a run that needs nothing.
test('an unpublished video with no subject_id is counted once, as unpublished only', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject: 'ENT', is_published: false, order: 0 },
  ]);
  assert.deepEqual(out.unpublished.map((row) => row._id), ['a']);
  assert.deepEqual(out.missingSubjectId, []);
});

// Deactivation is a read-time filter, never a write to playlist membership
// (spec §2.2) — an inactive-but-published video must still get an item.
test('an inactive but published video is still placed, since deactivation is a read-time filter', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, is_active: false, order: 0 },
  ]);
  assert.equal(out.playlists.length, 1);
  assert.equal(out.playlists[0].items.length, 1);
  assert.equal(out.unpublished.length, 0);
  assert.equal(out.missingSubjectId.length, 0);
});

test('a created playlist carries the expected publication and activation defaults', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, order: 0 },
  ]);
  assert.equal(out.playlists[0].is_published, true);
  assert.equal(out.playlists[0].is_active, true);
});

// Fix round 2: classifyLogInsertError decides whether a failed
// PlaylistMigration.create during --execute is a genuine duplicate-key
// race (safe to treat as "someone else already migrated this subject") or
// something else that must never be treated as benign.
test('classifyLogInsertError treats a MongoDB duplicate-key error (code 11000) as a duplicate', () => {
  assert.equal(classifyLogInsertError({ code: 11000 }), 'duplicate');
});

test('classifyLogInsertError treats any other error as "other", never assumed benign', () => {
  assert.equal(classifyLogInsertError(new Error('network blip')), 'other');
  assert.equal(classifyLogInsertError({ code: 121 }), 'other');
  assert.equal(classifyLogInsertError({ code: '11000' }), 'other', 'a string code is not the real error');
});

test('classifyLogInsertError treats a missing or malformed error as "other" rather than throwing', () => {
  assert.equal(classifyLogInsertError(undefined), 'other');
  assert.equal(classifyLogInsertError(null), 'other');
});


// --- Fix round 3, Rec 2: what the union rule GRANTS -------------------
// The union-of-plans and any-free-makes-free rules only ever widen access,
// which means --execute can hand a student a lecture they could not reach
// the day before. The dry run must say so before anyone types --execute, so
// the planner computes it: per planned playlist, which member lectures come
// out more reachable than they went in.

test('a member whose own plans were narrower than the union is listed as a grant', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 0 },
    { _id: 'b', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold', 'silver'], order: 1 },
  ]);
  assert.equal(out.grants.length, 1);
  assert.equal(out.grants[0].name, 'ENT');
  assert.equal(out.grants[0].subject_id, 's1');
  assert.deepEqual(out.grants[0].lectures, [{ _id: 'a', gains_plans: ['silver'], gains_free: false }]);
});

test('members with identical plans grant nothing, so the dry run reports no grants at all', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 0 },
    { _id: 'b', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 1 },
  ]);
  assert.equal(out.playlists.length, 1);
  assert.deepEqual(out.grants, []);
});

test('one free member makes the playlist free, and every non-free member is listed as gaining that', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'free-one', subject_id: 's1', subject: 'ENT', is_published: true, is_free: true, order: 0 },
    { _id: 'paid-one', subject_id: 's1', subject: 'ENT', is_published: true, is_free: false, allowed_plans: ['gold'], order: 1 },
  ]);
  assert.equal(out.playlists[0].is_free, true);
  assert.equal(out.grants.length, 1);
  assert.deepEqual(out.grants[0].lectures, [{ _id: 'paid-one', gains_plans: [], gains_free: true }]);
});

// A member with an EMPTY allowed_plans was already reachable on every plan
// (that is how canAccessPlaylist and the old canAccessVideo both read it),
// so the union cannot grant it anything -- it can only narrow it, which is
// a different report and not what --execute's operator is being warned
// about here.
test('a member that was already open to every plan is not reported as gaining plans', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'open', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: [], order: 0 },
    { _id: 'gold', subject_id: 's1', subject: 'ENT', is_published: true, allowed_plans: ['gold'], order: 1 },
  ]);
  assert.deepEqual(out.grants, []);
});
