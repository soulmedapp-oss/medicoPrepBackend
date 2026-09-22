const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Playlist = require('../src/models/Playlist');

test('a minimal playlist is valid and defaults sensibly', () => {
  const p = new Playlist({ name: 'ENT revision' });
  assert.equal(p.validateSync(), undefined);
  assert.equal(p.is_published, false);
  assert.equal(p.is_active, true);
  assert.equal(p.is_free, false);
  assert.deepEqual(p.allowed_plans.toObject(), []);
  assert.deepEqual([...p.subject_ids], []);
  assert.deepEqual([...p.items], []);
});

test('a playlist requires a name', () => {
  assert.ok(new Playlist({}).validateSync()?.errors?.name);
});

test('a playlist may span several subjects', () => {
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();
  const p = new Playlist({ name: 'Final year crash course', subject_ids: [a, b] });
  assert.equal(p.validateSync(), undefined);
  assert.equal(p.subject_ids.length, 2);
});

test('an item requires a lecture_id', () => {
  const p = new Playlist({ name: 'X', items: [{ order: 1 }] });
  assert.ok(p.validateSync());
});
