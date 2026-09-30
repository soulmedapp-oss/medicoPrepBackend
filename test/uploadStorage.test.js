const test = require('node:test');
const assert = require('node:assert/strict');
const { UPLOAD_FOLDERS, buildUploadKey, publicUploadUrl, slugForName } = require('../src/lib/uploadStorage');

const AT = new Date(Date.UTC(2026, 8, 30, 14, 15, 22));

test('buildUploadKey: readable folder/year/month + sortable stamp + random + slug + safe ext', () => {
  const key = buildUploadKey('jpg', UPLOAD_FOLDERS.lectureThumbnail, 'Dr K.K Jindal (final).JPG', AT);
  assert.match(key, /^thumbnails\/lectures\/2026\/09\/20260930-141522-[0-9a-f]{6}-dr-k-k-jindal-final\.jpg$/);
});

test('buildUploadKey: never trusts the client extension or an unknown folder', () => {
  assert.match(buildUploadKey('../../etc', UPLOAD_FOLDERS.profilePhoto, 'x', AT), /\.etc$/);
  assert.match(buildUploadKey('', UPLOAD_FOLDERS.profilePhoto, 'x', AT), /\.bin$/);
  assert.match(buildUploadKey('png', '../../secrets', 'x', AT), /^misc\/2026\/09\//, 'unknown folder lands in misc, never outside');
  assert.match(buildUploadKey('png', UPLOAD_FOLDERS.doubtImage, '', AT), /-[0-9a-f]{6}\.png$/, 'no slug when the name is empty');
});

test('slugForName: lower-case dashes, capped, no extension', () => {
  assert.equal(slugForName('  My   Photo!!.png'), 'my-photo');
  assert.equal(slugForName('x'.repeat(80) + '.jpg').length, 40);
  assert.equal(slugForName('....'), '');
});

test('publicUploadUrl: CloudFront base > bucket URL > local /uploads path', () => {
  const key = 'thumbnails/lectures/2026/09/a.jpg';
  assert.equal(publicUploadUrl(key, { bucket: 'soulmed-uploads', region: 'ap-south-1', publicBaseUrl: 'https://cdn.soulmed.app/' }), 'https://cdn.soulmed.app/thumbnails/lectures/2026/09/a.jpg');
  assert.equal(publicUploadUrl(key, { bucket: 'soulmed-uploads', region: 'ap-south-1' }), 'https://soulmed-uploads.s3.ap-south-1.amazonaws.com/thumbnails/lectures/2026/09/a.jpg');
  assert.equal(publicUploadUrl(key, {}), '/uploads/thumbnails/lectures/2026/09/a.jpg');
});

test('UPLOAD_FOLDERS: every folder is a plain relative path', () => {
  for (const folder of Object.values(UPLOAD_FOLDERS)) assert.match(folder, /^[a-z]+(\/[a-z]+)?$/);
});
