// One-time move of locally stored uploads to S3, rewriting every database
// field that points at them.
//
//   node src/scripts/migrate-uploads-to-s3.js --dry-run   (default: read-only)
//   node src/scripts/migrate-uploads-to-s3.js --execute
//
// Needs the same env as the server: MONGODB_URI, UPLOADS_S3_BUCKET,
// UPLOADS_S3_REGION, AWS credentials, optional UPLOADS_PUBLIC_BASE_URL, and
// UPLOADS_DIR pointing at the folder the old files live in.
//
// For every referenced file: upload it under the readable folder for that
// field (thumbnails/lectures/…, plans/banners/…) keyed as
// legacy-<original name>, then set the field to the new absolute URL. Local
// files nobody references are uploaded under misc/legacy/ and listed. Files a
// field references but that are missing on disk are listed and left alone.
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const { UPLOAD_FOLDERS, publicUploadUrl } = require('../lib/uploadStorage');
const { getExtension, isInlineSafeExtension } = require('../utils/uploadValidation');
const Video = require('../models/Video');
const Playlist = require('../models/Playlist');
const LiveClass = require('../models/LiveClass');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const User = require('../models/User');
const Doubt = require('../models/Doubt');
const Question = require('../models/Question');

const isExecute = process.argv.includes('--execute');
if (!isExecute && !process.argv.includes('--dry-run')) {
  console.log('Usage: node src/scripts/migrate-uploads-to-s3.js --dry-run | --execute');
  console.log('  --dry-run   Read-only. Lists every file and field that would move.');
  console.log('  --execute   Uploads to S3 and rewrites the database fields.');
  process.exit(1);
}

const bucket = require('../lib/deploymentEnvironment').uploadsBucket();
const region = process.env.UPLOADS_S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const publicBaseUrl = process.env.UPLOADS_PUBLIC_BASE_URL || '';
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');

// Which fields point at uploads, and which readable folder each belongs in.
const TARGETS = [
  { model: Video, label: 'videos', fields: ['thumbnail_url', 'card_thumbnail_url'], folder: UPLOAD_FOLDERS.lectureThumbnail },
  { model: Video, label: 'videos', fields: ['transcript_url'], folder: UPLOAD_FOLDERS.classTranscript },
  { model: Playlist, label: 'playlists', fields: ['thumbnail_url'], folder: UPLOAD_FOLDERS.playlistThumbnail },
  { model: LiveClass, label: 'liveclasses', fields: ['thumbnail_url'], folder: UPLOAD_FOLDERS.classThumbnail },
  { model: LiveClass, label: 'liveclasses', fields: ['recording_url'], folder: UPLOAD_FOLDERS.classRecording },
  { model: LiveClass, label: 'liveclasses', fields: ['transcript_url'], folder: UPLOAD_FOLDERS.classTranscript },
  { model: SubscriptionPlan, label: 'subscriptionplans', fields: ['pitch.banner_url'], folder: UPLOAD_FOLDERS.planBanner },
  { model: User, label: 'users', fields: ['profile_image'], folder: UPLOAD_FOLDERS.profilePhoto },
  { model: Doubt, label: 'doubts', fields: ['image_url', 'answer_image_url'], folder: UPLOAD_FOLDERS.doubtImage },
  { model: Question, label: 'questions', fields: ['image_url', 'explanation_image_url'], folder: UPLOAD_FOLDERS.questionImage },
];

// A stored value may be "/uploads/x.jpg", "/api/uploads/x.jpg" or an absolute
// URL on the old host; anything already on S3/CloudFront is skipped.
function localFileFor(value) {
  const m = /\/uploads\/([^?#]+)$/.exec(String(value || ''));
  if (!m) return null;
  if (/amazonaws\.com|cloudfront\.net/.test(value) || (publicBaseUrl && String(value).startsWith(publicBaseUrl))) return null;
  return decodeURIComponent(m[1]);
}

const getPath = (doc, field) => field.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!bucket) throw new Error('UPLOADS_S3_BUCKET is not set');
  const s3 = new S3Client({ region });
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  console.log(`${isExecute ? 'EXECUTE' : 'DRY RUN'} — bucket ${bucket} (${region}), local dir ${uploadsDir}`);

  const uploaded = new Map(); // local relative path → new URL (dedupe across fields)
  const missing = [];
  let fieldsRewritten = 0;

  async function moveFile(relPath, folder) {
    if (uploaded.has(relPath)) return uploaded.get(relPath);
    const abs = path.join(uploadsDir, relPath);
    if (!fs.existsSync(abs)) { missing.push(relPath); return null; }
    const ext = getExtension(relPath) || 'bin';
    const key = `${folder}/legacy-${path.basename(relPath).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
    const url = publicUploadUrl(key, { bucket, region, publicBaseUrl });
    if (isExecute) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fs.readFileSync(abs),
        ContentType: guessContentType(ext),
        ContentDisposition: isInlineSafeExtension(ext) ? 'inline' : 'attachment',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    }
    uploaded.set(relPath, url);
    console.log(`  file  ${relPath}  →  ${key}`);
    return url;
  }

  for (const target of TARGETS) {
    const or = target.fields.map((f) => ({ [f]: /\/uploads\// }));
    const docs = await target.model.find({ $or: or }).lean();
    for (const doc of docs) {
      const $set = {};
      for (const field of target.fields) {
        const rel = localFileFor(getPath(doc, field));
        if (!rel) continue;
        // eslint-disable-next-line no-await-in-loop
        const url = await moveFile(rel, target.folder);
        if (url) $set[field] = url;
      }
      if (Object.keys($set).length) {
        fieldsRewritten += Object.keys($set).length;
        console.log(`  field ${target.label}/${doc._id} ${Object.keys($set).join(', ')}`);
        // eslint-disable-next-line no-await-in-loop
        if (isExecute) await target.model.updateOne({ _id: doc._id }, { $set });
      }
    }
  }

  // Anything on disk that no field references — keep it, but out of the way.
  const walk = (dir, prefix = '') => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  )) : [];
  const orphans = walk(uploadsDir).filter((rel) => !uploaded.has(rel) && !rel.startsWith('.'));
  for (const rel of orphans) {
    // eslint-disable-next-line no-await-in-loop
    await moveFile(rel, 'misc/legacy');
  }

  console.log(`\nSummary: ${uploaded.size} files ${isExecute ? 'uploaded' : 'to upload'}, ${fieldsRewritten} fields ${isExecute ? 'rewritten' : 'to rewrite'}, ${orphans.length} unreferenced files → misc/legacy/, ${missing.length} referenced but missing on disk.`);
  if (missing.length) console.log('Missing:', missing.join(', '));
  if (!isExecute) console.log('Dry run only — nothing was uploaded or written. Re-run with --execute.');
  await mongoose.disconnect();
}

function guessContentType(ext) {
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/x-m4v',
    vtt: 'text/vtt; charset=utf-8', srt: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

main().catch((err) => { console.error(err.message); process.exit(1); });
