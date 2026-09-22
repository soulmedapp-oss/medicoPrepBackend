const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Video = require('../models/Video');
const Playlist = require('../models/Playlist');
const PlaylistMigration = require('../models/PlaylistMigration');
const { planPlaylistsFromVideos } = require('../utils/playlistMigration');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Idempotency (Task 7 rule 7, fix round 1): a subject counts as migrated iff
// a PlaylistMigration row exists for it — never anything read off Playlist
// itself. An earlier version of this script used a marker string in
// Playlist.description, but that marker could be erased by an ordinary
// playlist edit, and (worse) was keyed on `subject_ids.length === 1`, which
// broke the moment a curator legitimately broadened a migrated playlist to
// span a second subject — the row would silently vanish from the migrated
// set and the next run would insert a duplicate. See
// src/models/PlaylistMigration.js for why the replacement is a separate,
// unreachable-from-the-UI collection keyed on subject_id.
//
// --execute writes playlists per subject in a loop, not one insertMany, on
// purpose: PlaylistMigration's unique index on subject_id is the actual
// concurrency guard (a second, near-simultaneous --execute racing on the
// same subject loses the unique-insert and its orphan Playlist is deleted
// — see the catch block below), and a per-subject loop means a mid-run
// failure has a precise, describable boundary: every subject up to the
// failure has both its Playlist AND its PlaylistMigration row committed;
// the subject that failed, and every one after it in this run, are
// completely untouched. A re-run is safe and will only attempt the
// untouched ones — nothing needs manual repair.
//
// This also means --execute is monotonic, matching
// backfill-video-subject-ids.js's own convention: it writes every playlist
// it CAN resolve even when some videos remain unmigrated, then exits
// non-zero so the unmigrated rows are never silently missed. It does not
// wait for every video to be resolvable before writing anything.

const isDryRun = process.argv.includes('--dry-run');
const isExecute = process.argv.includes('--execute');

function printUsage() {
  // eslint-disable-next-line no-console
  console.log('Usage: node src/scripts/migrate-videos-to-playlists.js --dry-run | --execute');
  // eslint-disable-next-line no-console
  console.log('  --dry-run   Read-only. Prints the migration plan; writes nothing.');
  // eslint-disable-next-line no-console
  console.log('  --execute   Creates the planned playlists. Idempotent: safe to re-run.');
  // eslint-disable-next-line no-console
  console.log('              Writes every resolvable playlist even if some videos remain');
  // eslint-disable-next-line no-console
  console.log('              unmigrated, then exits non-zero so those rows are never missed.');
}

async function loadMigratedSubjectIds() {
  const rows = await PlaylistMigration.find({}, 'subject_id').lean();
  return new Set(rows.map((row) => String(row.subject_id)));
}

async function migrateVideosToPlaylists() {
  // Neither flag: refuse rather than default to any write-capable behaviour.
  // --dry-run is the ONLY thing that happens without --execute.
  if (!isDryRun && !isExecute) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (isDryRun && isExecute) {
    // eslint-disable-next-line no-console
    console.error('Pass exactly one of --dry-run or --execute, not both.');
    process.exitCode = 1;
    return;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(mongoUri, { autoIndex: false });

  const videos = await Video.find(
    {},
    '_id subject_id subject is_published is_active is_free allowed_plans order created_date'
  ).lean();

  const { playlists, unmigrated } = planPlaylistsFromVideos(videos);

  const migratedSubjectIds = await loadMigratedSubjectIds();
  const toCreate = playlists.filter((playlist) => !migratedSubjectIds.has(String(playlist.subject_ids[0])));
  const skippedAsAlreadyMigrated = playlists.length - toCreate.length;

  // eslint-disable-next-line no-console
  console.log(`${isDryRun ? '[dry run] ' : ''}Videos scanned: ${videos.length}`);
  // eslint-disable-next-line no-console
  console.log(`Playlists planned (from published videos): ${playlists.length}`);
  // eslint-disable-next-line no-console
  console.log(`Already migrated (skipped, idempotent): ${skippedAsAlreadyMigrated}`);
  // eslint-disable-next-line no-console
  console.log(`Playlists to create: ${toCreate.length}`);
  toCreate.forEach((playlist) => {
    // eslint-disable-next-line no-console
    console.log(
      `  "${playlist.name}"  plans=${JSON.stringify(playlist.allowed_plans)}  is_free=${playlist.is_free}  items=${playlist.items.length}`
    );
  });

  // eslint-disable-next-line no-console
  console.log(`Unmigrated videos: ${unmigrated.length}`);
  if (unmigrated.length) {
    unmigrated.forEach((row) => {
      // eslint-disable-next-line no-console
      console.log(`  ${row._id}  subject=${JSON.stringify(row.subject)}  reason=${row.reason}`);
    });
  }

  if (isExecute) {
    let createdCount = 0;
    // Sequential per-subject writes, deliberately not Playlist.insertMany —
    // see the top-of-file comment for why.
    // eslint-disable-next-line no-restricted-syntax
    for (const playlist of toCreate) {
      const subjectId = playlist.subject_ids[0];
      // eslint-disable-next-line no-await-in-loop
      const created = await Playlist.create({ ...playlist, created_by: null });
      try {
        // eslint-disable-next-line no-await-in-loop
        await PlaylistMigration.create({ subject_id: subjectId, playlist_id: created._id });
        createdCount += 1;
      } catch (err) {
        if (err && err.code === 11000) {
          // A concurrent run logged this subject_id first. The Playlist we
          // just inserted is an orphan the migration log doesn't know
          // about — remove it rather than leaving an unlogged duplicate.
          // eslint-disable-next-line no-await-in-loop
          await Playlist.deleteOne({ _id: created._id });
          // eslint-disable-next-line no-console
          console.log(
            `  Skipped subject ${subjectId}: a concurrent run already migrated it (removed orphan playlist ${created._id}).`
          );
        } else {
          throw err;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Created ${createdCount} playlist(s).`);
  }

  await mongoose.disconnect();

  // An operator must never be able to miss unmigrated rows.
  if (unmigrated.length) {
    process.exitCode = 1;
  }
}

migrateVideosToPlaylists().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
