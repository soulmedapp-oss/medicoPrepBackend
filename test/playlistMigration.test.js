const test = require('node:test');
const assert = require('node:assert/strict');
const { planPlaylistsFromVideos } = require('../src/utils/playlistMigration');

test('an empty input yields no playlists and no unmigrated rows, without throwing', () => {
  assert.deepEqual(planPlaylistsFromVideos([]), { playlists: [], unmigrated: [] });
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

test('unpublished videos join no playlist and are reported in unmigrated', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: false, order: 0 },
  ]);
  assert.equal(out.playlists.length, 0);
  assert.equal(out.unmigrated.length, 1);
  assert.equal(out.unmigrated[0]._id, 'a');
  assert.ok(out.unmigrated[0].reason);
});

test('a published video with no subject_id is reported with a reason, not placed', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject: 'ENT', is_published: true, order: 0 },
  ]);
  assert.equal(out.playlists.length, 0);
  assert.equal(out.unmigrated.length, 1);
  assert.equal(out.unmigrated[0]._id, 'a');
  assert.ok(out.unmigrated[0].reason);
});

test('a mix of unpublished and no-subject_id rows are both reported, with distinct reasons', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: false, order: 0 },
    { _id: 'b', subject: 'ENT', is_published: true, order: 0 },
  ]);
  assert.equal(out.playlists.length, 0);
  assert.equal(out.unmigrated.length, 2);
  const reasons = out.unmigrated.map((row) => row.reason);
  assert.notEqual(reasons[0], reasons[1]);
});

// Deactivation is a read-time filter, never a write to playlist membership
// (spec §2.2) — an inactive-but-published video must still get an item.
test('an inactive but published video is still placed, since deactivation is a read-time filter', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, is_active: false, order: 0 },
  ]);
  assert.equal(out.playlists.length, 1);
  assert.equal(out.playlists[0].items.length, 1);
  assert.equal(out.unmigrated.length, 0);
});

test('a created playlist carries the expected publication and activation defaults', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', subject: 'ENT', is_published: true, order: 0 },
  ]);
  assert.equal(out.playlists[0].is_published, true);
  assert.equal(out.playlists[0].is_active, true);
});
