const test = require('node:test');
const assert = require('node:assert/strict');
const Video = require('../src/models/Video');

test('existing link videos default to the youtube provider and are ready', () => {
  const doc = new Video({ title: 'T', subject: 'Anatomy', teacher_name: 'Dr A', video_url: 'https://y/1' });
  assert.equal(doc.provider, 'youtube');
  assert.equal(doc.processing_status, 'ready');
  assert.equal(doc.validateSync(), undefined);
});

test('a youtube video without a url is invalid', () => {
  const doc = new Video({ title: 'T', subject: 'Anatomy', teacher_name: 'Dr A' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.video_url, 'video_url should be required for youtube');
});

test('a bunny video is valid without a video_url', () => {
  const doc = new Video({
    title: 'T', subject: 'Anatomy', teacher_name: 'Dr A',
    provider: 'bunny', bunny_video_id: 'guid', processing_status: 'uploading',
  });
  assert.equal(doc.validateSync(), undefined);
});
