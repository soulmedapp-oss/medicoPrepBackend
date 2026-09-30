const test = require('node:test');
const assert = require('node:assert/strict');
const { attachActorNames } = require('../src/controllers/videosController');

// attachActorNames is the pure core of listVideos' staff-path enrichment:
// given the page of videos and a Map of userId string -> { _id, full_name },
// it returns new objects carrying created_by_name/updated_by_name/
// updated_by_at without a database. The controller itself only builds the
// Map (one `User.find({ _id: { $in: ids } })`) and calls this.

test('attachActorNames: both created_by and updated_by present resolve to their names', () => {
  const userMap = new Map([
    ['u1', { _id: 'u1', full_name: 'Alice Admin' }],
    ['u2', { _id: 'u2', full_name: 'Bob Editor' }],
  ]);
  const videos = [
    { _id: 'v1', title: 'Lecture 1', created_by: 'u1', updated_by: 'u2', updated_by_at: new Date('2026-01-01') },
  ];
  const [result] = attachActorNames(videos, userMap);
  assert.equal(result.created_by_name, 'Alice Admin');
  assert.equal(result.updated_by_name, 'Bob Editor');
  assert.deepEqual(result.updated_by_at, new Date('2026-01-01'));
});

test('attachActorNames: updated_by absent yields null updated_by_name and null updated_by_at', () => {
  const userMap = new Map([['u1', { _id: 'u1', full_name: 'Alice Admin' }]]);
  const videos = [{ _id: 'v1', title: 'Lecture 1', created_by: 'u1' }];
  const [result] = attachActorNames(videos, userMap);
  assert.equal(result.created_by_name, 'Alice Admin');
  assert.equal(result.updated_by_name, null);
  assert.equal(result.updated_by_at, null);
});

test('attachActorNames: a created_by whose user is missing from the map yields null, not a throw', () => {
  const userMap = new Map(); // deleted/missing user
  const videos = [{ _id: 'v1', title: 'Lecture 1', created_by: 'ghost-id' }];
  assert.doesNotThrow(() => attachActorNames(videos, userMap));
  const [result] = attachActorNames(videos, userMap);
  assert.equal(result.created_by_name, null);
});

test('attachActorNames: no email or extra user field leaks into the output', () => {
  const userMap = new Map([
    ['u1', { _id: 'u1', full_name: 'Alice Admin', email: 'alice@example.com', role: 'admin' }],
  ]);
  const videos = [{ _id: 'v1', title: 'Lecture 1', created_by: 'u1' }];
  const [result] = attachActorNames(videos, userMap);
  assert.equal(result.created_by_name, 'Alice Admin');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'email'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'created_by_email'), false);
  assert.deepEqual(Object.keys(result).sort(), [
    '_id', 'created_by', 'created_by_name', 'title', 'updated_by_at', 'updated_by_name',
  ]);
});

test('attachActorNames: does not mutate the input video objects', () => {
  const userMap = new Map([['u1', { _id: 'u1', full_name: 'Alice Admin' }]]);
  const original = { _id: 'v1', title: 'Lecture 1', created_by: 'u1' };
  const videos = [original];
  attachActorNames(videos, userMap);
  assert.equal(Object.prototype.hasOwnProperty.call(original, 'created_by_name'), false);
});
