const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Video = require('../models/Video');
const Playlist = require('../models/Playlist');
const PlaylistMigration = require('../models/PlaylistMigration');
const { planPlaylistsFromVideos, classifyLogInsertError } = require('../utils/playlistMigration');

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
// failure has a precise, describable boundary: every subject before the
// failure has both its Playlist AND its PlaylistMigration row committed;
// the failing subject has its just-created Playlist removed again (or, if
// that removal itself fails, the orphan's id is printed so an operator can
// remove it by hand — see fix round 2 below); every subject after it in
// this run is completely untouched. A re-run is therefore safe — once any
// orphan reported by that cleanup-failure path has been removed by hand.
//
// Fix round 2: the cleanup on a failed PlaylistMigration.create is
// unconditional, not gated on error code. An earlier version only deleted
// the orphan Playlist when the log insert failed with a duplicate-key
// error (11000); any OTHER failure — a network blip, a validation error —
// left a committed Playlist with no log row, which a re-run's
// loadMigratedSubjectIds() (reading only the log) would not recognise as
// migrated, reintroducing Critical 1's duplicate-creation outcome through
// a different trigger. Now the delete always runs first; only afterwards
// does the code branch on classifyLogInsertError(err) to decide whether to
// log-and-continue (a genuine concurrent-run race) or rethrow (everything
// else). If the delete itself fails, both the original error and the
// delete error are logged with the orphan's id before the original error
// is rethrown — a cleanup failure must never mask the real one.
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
        // Cleanup is unconditional: whatever the log insert failed with,
        // the Playlist just created above is now an orphan (a Playlist
        // with no PlaylistMigration row), and MUST be removed before this
        // subject is decided one way or the other — see fix round 2.
        try {
          // eslint-disable-next-line no-await-in-loop
          await Playlist.deleteOne({ _id: created._id });
        } catch (cleanupErr) {
          // The orphan could not be removed automatically. Do not let this
          // mask the original error — log both, with enough to find the
          // row by hand, then rethrow the original.
          // eslint-disable-next-line no-console
          console.error(
            `  Could not remove orphan playlist ${created._id} (subject ${subjectId}) after a migration-log write failure. Remove it by hand.`
          );
          // eslint-disable-next-line no-console
          console.error('  Original error:', err);
          // eslint-disable-next-line no-console
          console.error('  Cleanup error:', cleanupErr);
          throw err;
        }

        if (classifyLogInsertError(err) === 'duplicate') {
          // A concurrent run logged this subject_id first; the orphan
          // Playlist above has already been removed.
          // eslint-disable-next-line no-console
          console.log(
            `  Skipped subject ${subjectId}: a concurrent run already migrated it (removed orphan playlist ${created._id}).`
          );
        } else {
          // Anything else (validation error, network blip, ...) must not
          // be treated as a benign race. The orphan is already cleaned up;
          // propagate so the operator sees the real failure.
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
