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

test('uploadKeyFromUrl: only our own question uploads map back to a key', () => {
  const { uploadKeyFromUrl } = require('../src/lib/uploadStorage');
  const s3 = { bucket: 'soulmed-uploads', region: 'ap-south-1' };
  const cdn = { ...s3, publicBaseUrl: 'https://cdn.soulmed.app/' };
  const key = 'questions/2026/10/20261001-120000-abcdef-fig.png';
  assert.equal(uploadKeyFromUrl(`https://soulmed-uploads.s3.ap-south-1.amazonaws.com/${key}`, s3, 'questions'), key);
  assert.equal(uploadKeyFromUrl(`https://cdn.soulmed.app/${key}?v=1`, cdn, 'questions'), key);
  assert.equal(uploadKeyFromUrl(`/uploads/${key}`, {}, 'questions'), key, 'disk mode');
  assert.equal(uploadKeyFromUrl(`http://localhost:4001/uploads/${key}`, {}, 'questions'), key, 'disk mode, prefixed by the browser');
  assert.equal(uploadKeyFromUrl('https://evil.example/questions/x.png', s3, 'questions'), null, 'another host');
  assert.equal(uploadKeyFromUrl('https://soulmed-uploads.s3.ap-south-1.amazonaws.com/profiles/x.png', s3, 'questions'), null, 'another folder');
  assert.equal(uploadKeyFromUrl('/uploads/questions/../../etc/passwd', {}, 'questions'), null, 'no climbing out');
  assert.equal(uploadKeyFromUrl('/uploads/questions/%2e%2e/x.png', {}, 'questions'), null, 'no encoded climbing out');
  assert.equal(uploadKeyFromUrl(`/uploads/${key}`, s3, 'questions'), null, 'a disk link is not an S3 upload');
});

test('readUpload (disk): reads a stored file back and refuses paths outside the folder', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { createUploadStorage } = require('../src/lib/uploadStorage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  const store = createUploadStorage({ uploadsDir: dir, isInlineSafeExtension: () => true });
  const url = await store.storeUpload({ buffer: Buffer.from('png-bytes'), originalname: 'fig.png' }, { ext: 'png', contentType: 'image/png' }, 'questions');
  const key = url.replace('/uploads/', '');
  const { body, contentType } = await store.readUpload(key);
  assert.equal(body.toString(), 'png-bytes');
  assert.equal(contentType, 'image/png');
  await assert.rejects(() => store.readUpload('../outside.png'));
});
