// Where uploaded files live and how they are named.
//
// Two backends, chosen by configuration:
//   - Amazon S3 when UPLOADS_S3_BUCKET is set (required on Lambda/Vercel, which
//     have no persistent disk). Objects are public-read via the bucket policy
//     (or fronted by CloudFront) and the API returns their absolute URL.
//   - Local disk otherwise (UPLOADS_DIR, default <repo>/uploads), served by
//     express.static at /uploads.
//
// Keys are readable on purpose — an operator browsing the bucket should know
// what a file is without opening it:
//   thumbnails/lectures/2026/09/20260930-141522-a1b2c3-dr-jindal.jpg
//   ^ folder (what)   ^ when          ^ sortable stamp ^ random ^ original name
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Every upload route names one of these. Adding a route means adding a
// folder here, so the bucket never grows an unlabelled corner.
const UPLOAD_FOLDERS = Object.freeze({
  lectureThumbnail: 'thumbnails/lectures',
  playlistThumbnail: 'thumbnails/playlists',
  classThumbnail: 'thumbnails/classes',
  planBanner: 'plans/banners',
  profilePhoto: 'profiles',
  doubtImage: 'doubts',
  questionImage: 'questions',
  classRecording: 'recordings/classes',
  lectureVideo: 'videos/uploads',
  classTranscript: 'transcripts/classes',
});

const pad = (n) => String(n).padStart(2, '0');

/** Lower-case, dashes only, ≤ 40 chars, no extension; '' when nothing usable. */
function slugForName(originalName) {
  const base = String(originalName || '').replace(/\.[^.]+$/, '');
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Pure. `folder` must be a value of UPLOAD_FOLDERS; unknown → 'misc' so a
 * mistake shows up in the bucket instead of throwing on a user's upload.
 */
function buildUploadKey(ext, folder, originalName, now = new Date()) {
  const safeExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const safeFolder = Object.values(UPLOAD_FOLDERS).includes(folder) ? folder : 'misc';
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const stamp = `${y}${m}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const random = crypto.randomBytes(3).toString('hex');
  const slug = slugForName(originalName);
  return `${safeFolder}/${y}/${m}/${stamp}-${random}${slug ? `-${slug}` : ''}.${safeExt}`;
}

/**
 * Pure. The URL the browser will use for a stored key.
 *   S3 + UPLOADS_PUBLIC_BASE_URL (CloudFront / custom domain) → base + key
 *   S3 alone → virtual-hosted bucket URL
 *   local → /uploads/<key> (the frontend prefixes its API base)
 */
function publicUploadUrl(key, { bucket = '', region = '', publicBaseUrl = '' } = {}) {
  if (bucket) {
    const base = publicBaseUrl
      ? publicBaseUrl.replace(/\/+$/, '')
      : `https://${bucket}.s3.${region || 'ap-south-1'}.amazonaws.com`;
    return `${base}/${key}`;
  }
  return `/uploads/${key}`;
}

function createUploadStorage({ uploadsDir, bucket, region, publicBaseUrl, s3Client, PutObjectCommand, isInlineSafeExtension }) {
  const config = { bucket, region, publicBaseUrl };

  async function storeUpload(file, { ext, contentType }, folder) {
    const key = buildUploadKey(ext, folder, file?.originalname);
    if (s3Client) {
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: contentType,
        ContentDisposition: isInlineSafeExtension(ext) ? 'inline' : 'attachment',
        CacheControl: 'public, max-age=31536000, immutable', // keys are unique, so cache forever
      }));
    } else {
      const target = path.join(uploadsDir, key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.buffer);
    }
    return publicUploadUrl(key, config);
  }

  return { storeUpload, mode: s3Client ? 's3' : 'disk' };
}

// server.js registers its configured storage here so services (e.g. the Zoom
// recording ingest) can store files without threading it through every call.
let defaultStorage = null;
function setDefaultStorage(storage) { defaultStorage = storage; }
function getDefaultStorage() {
  if (!defaultStorage) throw new Error('Upload storage is not initialised');
  return defaultStorage;
}

module.exports = { UPLOAD_FOLDERS, buildUploadKey, publicUploadUrl, slugForName, createUploadStorage, setDefaultStorage, getDefaultStorage };
