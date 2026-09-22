const crypto = require('crypto');

// Per-upload-type whitelist: extension -> content type we store/serve with.
const UPLOAD_KINDS = {
  image: {
    label: 'image',
    extensions: {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    },
  },
  video: {
    label: 'video',
    extensions: {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
    },
  },
  transcript: {
    label: 'transcript',
    extensions: {
      vtt: 'text/vtt; charset=utf-8',
      srt: 'text/plain; charset=utf-8',
      txt: 'text/plain; charset=utf-8',
    },
  },
  spreadsheet: {
    label: 'spreadsheet',
    extensions: {
      csv: 'text/csv',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  },
};

// Claimed mimetype -> canonical extension, used when the filename has no usable extension.
const MIME_TO_EXT = {
  image: { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' },
  video: { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v' },
  transcript: { 'text/vtt': 'vtt', 'text/plain': 'txt', 'application/x-subrip': 'srt' },
  spreadsheet: {
    'text/csv': 'csv',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  },
};

const INLINE_SAFE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function getExtension(filename) {
  const name = String(filename || '').toLowerCase().trim();
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1);
}

function invalidTypeError(message) {
  const err = new Error(message);
  err.code = 'INVALID_FILE_TYPE';
  err.status = 400;
  return err;
}

/**
 * Pre-upload check (multer fileFilter): decides from the claimed name/mimetype
 * only. Returns { ok, ext, contentType } or { ok: false, error }.
 */
function checkFileAllowed(kind, { originalname, mimetype } = {}) {
  const rules = UPLOAD_KINDS[kind];
  if (!rules) return { ok: false, error: 'Unknown upload type' };
  const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
  const nameExt = getExtension(originalname);

  // Never accept active content, whatever the upload type.
  if (/svg|html|xml|javascript/.test(mime) || ['svg', 'svgz', 'html', 'htm', 'xhtml', 'xml', 'js', 'mjs'].includes(nameExt)) {
    return { ok: false, error: `Only ${rules.label} uploads are allowed` };
  }

  let ext = '';
  if (nameExt && rules.extensions[nameExt]) {
    ext = nameExt;
  } else if (!nameExt || nameExt === 'blob') {
    ext = MIME_TO_EXT[kind][mime] || '';
  }
  if (!ext) {
    return { ok: false, error: `Only ${Object.keys(rules.extensions).join(', ')} files are allowed` };
  }
  if (ext === 'jpeg') ext = 'jpg';
  return { ok: true, ext, contentType: rules.extensions[ext] };
}

/** Detects jpg/png/gif/webp from magic bytes; returns the canonical extension or null. */
function detectImageType(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'png';
  const head6 = buffer.toString('latin1', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function looksLikeText(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

/**
 * Post-upload check on the in-memory buffer. For images the stored extension
 * and content type come from the detected magic bytes, not the client.
 */
function validateUploadedFile(kind, file) {
  if (!file || !file.buffer) return { ok: false, error: 'File is required' };
  const claimed = checkFileAllowed(kind, file);
  if (!claimed.ok) return claimed;
  if (kind === 'image') {
    const detected = detectImageType(file.buffer);
    if (!detected) {
      return { ok: false, error: 'File content is not a supported image (jpg, png, gif, webp)' };
    }
    return { ok: true, ext: detected, contentType: UPLOAD_KINDS.image.extensions[detected] };
  }
  if (kind === 'transcript' && !looksLikeText(file.buffer)) {
    return { ok: false, error: 'Transcript must be a text file' };
  }
  return claimed;
}

function buildUploadKey(ext) {
  const safeExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${safeExt}`;
}

function isInlineSafeExtension(ext) {
  return INLINE_SAFE_EXTENSIONS.has(String(ext || '').toLowerCase());
}

/** multer fileFilter factory for a given upload kind. */
function createFileFilter(kind) {
  return (req, file, cb) => {
    const result = checkFileAllowed(kind, file);
    if (!result.ok) return cb(invalidTypeError(result.error));
    return cb(null, true);
  };
}

module.exports = {
  UPLOAD_KINDS,
  getExtension,
  checkFileAllowed,
  detectImageType,
  validateUploadedFile,
  buildUploadKey,
  isInlineSafeExtension,
  createFileFilter,
  invalidTypeError,
};
