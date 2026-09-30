const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Subject = require('../models/Subject');
const Video = require('../models/Video');
const { resolveSubjectIds } = require('../utils/subjectResolution');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Fix round 3, Important 2: this script used to WRITE unless it was handed
// --dry-run, so a bare `node src/scripts/backfill-video-subject-ids.js`
// silently bulk-updated every video. Both migration scripts now share one
// convention, mirroring migrate-videos-to-playlists.js exactly: writing is
// opt-in through --execute, --dry-run is the read-only rehearsal, and
// neither flag (or both) is refused with usage text and exit 1 rather than
// defaulting to any write-capable behaviour.
const isDryRun = process.argv.includes('--dry-run');
const isExecute = process.argv.includes('--execute');

function printUsage() {
  // eslint-disable-next-line no-console
  console.log('Usage: node src/scripts/backfill-video-subject-ids.js --dry-run | --execute');
  // eslint-disable-next-line no-console
  console.log('  --dry-run   Read-only. Prints what would be written; writes nothing.');
  // eslint-disable-next-line no-console
  console.log('  --execute   Writes subject_id onto every video whose subject string');
  // eslint-disable-next-line no-console
  console.log('              resolves to a Subject. Idempotent: safe to re-run. Exits');
  // eslint-disable-next-line no-console
  console.log('              non-zero if any video was left unresolved.');
}

async function backfillVideoSubjectIds() {
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

  const subjects = await Subject.find({}, '_id name slug').lean();
  const videos = await Video.find({}, '_id subject subject_id').lean();

  const { updates, unresolved } = resolveSubjectIds(videos, subjects);
  const alreadyMigrated = videos.length - updates.length - unresolved.length;

  if (isExecute && updates.length) {
    await Video.bulkWrite(
      updates.map((update) => ({
        updateOne: {
          filter: { _id: update._id },
          update: { $set: { subject_id: update.subject_id } },
        },
      }))
    );
  }

  // eslint-disable-next-line no-console
  console.log(`${isDryRun ? '[dry run] ' : ''}Videos scanned: ${videos.length}`);
  // eslint-disable-next-line no-console
  console.log(`${isDryRun ? 'Would update' : 'Updated'}: ${updates.length}`);
  // eslint-disable-next-line no-console
  console.log(`Already migrated: ${alreadyMigrated}`);
  // eslint-disable-next-line no-console
  console.log(`Unresolved: ${unresolved.length}`);

  if (unresolved.length) {
    // eslint-disable-next-line no-console
    console.log('Unresolved videos (subject string matched no Subject row):');
    unresolved.forEach((row) => {
      // eslint-disable-next-line no-console
      console.log(`  ${row._id}  subject=${JSON.stringify(row.subject)}`);
    });
  }

  await mongoose.disconnect();

  if (unresolved.length) {
    process.exitCode = 1;
  }
}

backfillVideoSubjectIds().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
