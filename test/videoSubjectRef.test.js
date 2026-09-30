const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Video = require('../src/models/Video');

test('a video accepts a subject_id referencing Subject', () => {
  const id = new mongoose.Types.ObjectId();
  const doc = new Video({
    title: 'T', subject: 'ENT', teacher_name: 'Dr A',
    video_url: 'https://y/1', subject_id: id,
  });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(String(doc.subject_id), String(id));
});

test('subject_id is optional while the backfill has not run', () => {
  const doc = new Video({ title: 'T', subject: 'ENT', teacher_name: 'Dr A', video_url: 'https://y/1' });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.subject_id, undefined);
});
