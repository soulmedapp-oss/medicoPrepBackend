const test = require('node:test');
const assert = require('node:assert');
const {
  checkFileAllowed,
  detectImageType,
  validateUploadedFile,
  buildUploadKey,
  isInlineSafeExtension,
  createFileFilter,
} = require('../src/utils/uploadValidation');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');

test('detectImageType recognises jpg/png/gif/webp only', () => {
  assert.strictEqual(detectImageType(PNG), 'png');
  assert.strictEqual(detectImageType(JPG), 'jpg');
  assert.strictEqual(detectImageType(GIF), 'gif');
  assert.strictEqual(detectImageType(WEBP), 'webp');
  assert.strictEqual(detectImageType(SVG), null);
  assert.strictEqual(detectImageType(HTML), null);
  assert.strictEqual(detectImageType(Buffer.alloc(3)), null);
  assert.strictEqual(detectImageType(null), null);
});

test('checkFileAllowed rejects svg/html regardless of kind', () => {
  assert.strictEqual(checkFileAllowed('image', { originalname: 'x.svg', mimetype: 'image/svg+xml' }).ok, false);
  assert.strictEqual(checkFileAllowed('image', { originalname: 'x.png', mimetype: 'image/svg+xml' }).ok, false);
  assert.strictEqual(checkFileAllowed('image', { originalname: 'x.html', mimetype: 'image/png' }).ok, false);
  assert.strictEqual(checkFileAllowed('transcript', { originalname: 'x.html', mimetype: 'text/html' }).ok, false);
});

test('checkFileAllowed derives extension from whitelist', () => {
  assert.deepStrictEqual(
    checkFileAllowed('image', { originalname: 'Photo.JPEG', mimetype: 'image/jpeg' }),
    { ok: true, ext: 'jpg', contentType: 'image/jpeg' }
  );
  assert.strictEqual(checkFileAllowed('image', { originalname: 'blob', mimetype: 'image/png' }).ext, 'png');
  assert.strictEqual(checkFileAllowed('image', { originalname: 'a.exe', mimetype: 'image/png' }).ok, false);
  assert.strictEqual(checkFileAllowed('video', { originalname: 'lecture.mp4', mimetype: 'video/mp4' }).ext, 'mp4');
  assert.strictEqual(checkFileAllowed('video', { originalname: 'lecture.php', mimetype: 'video/mp4' }).ok, false);
  assert.strictEqual(checkFileAllowed('transcript', { originalname: 'a.vtt', mimetype: 'application/octet-stream' }).ext, 'vtt');
  assert.strictEqual(checkFileAllowed('transcript', { originalname: 'a.pdf', mimetype: 'text/plain' }).ok, false);
  assert.strictEqual(checkFileAllowed('spreadsheet', { originalname: 'q.xlsx', mimetype: 'application/octet-stream' }).ok, true);
  assert.strictEqual(checkFileAllowed('nope', { originalname: 'a.png' }).ok, false);
});

test('validateUploadedFile: image content must match magic bytes; ext comes from content', () => {
  const lyingPng = validateUploadedFile('image', { originalname: 'a.png', mimetype: 'image/png', buffer: JPG });
  assert.deepStrictEqual(lyingPng, { ok: true, ext: 'jpg', contentType: 'image/jpeg' });
  const html = validateUploadedFile('image', { originalname: 'a.png', mimetype: 'image/png', buffer: HTML });
  assert.strictEqual(html.ok, false);
  const svg = validateUploadedFile('image', { originalname: 'a.gif', mimetype: 'image/gif', buffer: SVG });
  assert.strictEqual(svg.ok, false);
  assert.strictEqual(validateUploadedFile('image', null).ok, false);
});

test('validateUploadedFile: transcripts must be text', () => {
  const ok = validateUploadedFile('transcript', { originalname: 'a.vtt', mimetype: 'text/vtt', buffer: Buffer.from('WEBVTT\n\nhello') });
  assert.strictEqual(ok.ok, true);
  const bin = validateUploadedFile('transcript', { originalname: 'a.txt', mimetype: 'text/plain', buffer: Buffer.from([0x41, 0, 0x42]) });
  assert.strictEqual(bin.ok, false);
});

test('buildUploadKey never uses client filename and keeps safe ext', () => {
  const key = buildUploadKey('png');
  assert.match(key, /^\d+_[a-f0-9]{16}\.png$/);
  assert.match(buildUploadKey('../../etc'), /\.etc$/);
  assert.match(buildUploadKey(''), /\.bin$/);
});

test('isInlineSafeExtension only for raster images', () => {
  assert.strictEqual(isInlineSafeExtension('png'), true);
  assert.strictEqual(isInlineSafeExtension('JPG'), true);
  assert.strictEqual(isInlineSafeExtension('svg'), false);
  assert.strictEqual(isInlineSafeExtension('html'), false);
  assert.strictEqual(isInlineSafeExtension('mp4'), false);
});

test('createFileFilter passes a 400-style error to multer', () => {
  const filter = createFileFilter('image');
  filter({}, { originalname: 'x.svg', mimetype: 'image/svg+xml' }, (err, accepted) => {
    assert.ok(err);
    assert.strictEqual(err.code, 'INVALID_FILE_TYPE');
    assert.strictEqual(err.status, 400);
    assert.strictEqual(accepted, undefined);
  });
  filter({}, { originalname: 'x.png', mimetype: 'image/png' }, (err, accepted) => {
    assert.strictEqual(err, null);
    assert.strictEqual(accepted, true);
  });
});
