const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Video = require('../models/Video');
const Playlist = require('../models/Playlist');
const { planPlaylistsFromVideos } = require('../utils/playlistMigration');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Idempotency marker (Task 7 rule 7). A dedicated Playlist schema field
// would be cleaner, but this task's constraints say touch no existing
// model, so the marker lives in `description` instead — the field the
// spec's own suggestion (§6) points at. A migrated playlist's description
// is set to exactly this string and nothing else. Caveat worth carrying
// forward: Task 10's admin UI lets a curator edit a playlist's description;
// doing so on a migrated playlist would erase the marker and make a later
// re-run treat that subject as unmigrated again, creating a duplicate. That
// is a real but narrow risk — noted here rather than solved, since solving
// it needs a schema change this task must not make.
const MIGRATION_MARKER = 'migrated_from:videos';

const isDryRun = process.argv.includes('--dry-run');
const isExecute = process.argv.includes('--execute');

function printUsage() {
  // eslint-disable-next-line no-console
  console.log('Usage: node src/scripts/migrate-videos-to-playlists.js --dry-run | --execute');
  // eslint-disable-next-line no-console
  console.log('  --dry-run   Read-only. Prints the migration plan; writes nothing.');
  // eslint-disable-next-line no-console
  console.log('  --execute   Creates the planned playlists. Idempotent: safe to re-run.');
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

  // Re-check the idempotency marker even on a --dry-run so its report
  // matches exactly what --execute would do, and re-check it again right
  // before the insertMany below (not just here) so a double --execute in
  // quick succession can't race past a stale in-memory list.
  const alreadyMigrated = await Playlist.find(
    { description: MIGRATION_MARKER },
    'subject_ids'
  ).lean();
  const migratedSubjectIds = new Set(
    alreadyMigrated
      .filter((playlist) => Array.isArray(playlist.subject_ids) && playlist.subject_ids.length === 1)
      .map((playlist) => String(playlist.subject_ids[0]))
  );

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

  if (isExecute && toCreate.length) {
    // Re-check right before the write: a second, near-simultaneous
    // --execute must not create a duplicate playlist for a subject the
    // first run just migrated.
    const stillMigrated = await Playlist.find(
      { description: MIGRATION_MARKER },
      'subject_ids'
    ).lean();
    const stillMigratedSubjectIds = new Set(
      stillMigrated
        .filter((playlist) => Array.isArray(playlist.subject_ids) && playlist.subject_ids.length === 1)
        .map((playlist) => String(playlist.subject_ids[0]))
    );
    const safeToCreate = toCreate.filter(
      (playlist) => !stillMigratedSubjectIds.has(String(playlist.subject_ids[0]))
    );

    if (safeToCreate.length) {
      await Playlist.insertMany(
        safeToCreate.map((playlist) => ({
          ...playlist,
          description: MIGRATION_MARKER,
          created_by: null,
        }))
      );
    }
    // eslint-disable-next-line no-console
    console.log(`Created ${safeToCreate.length} playlist(s).`);
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
