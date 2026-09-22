const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Subject = require('../models/Subject');
const Video = require('../models/Video');
const { resolveSubjectIds } = require('../utils/subjectResolution');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const isDryRun = process.argv.includes('--dry-run');

async function backfillVideoSubjectIds() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(mongoUri, { autoIndex: false });

  const subjects = await Subject.find({}, '_id name slug').lean();
  const videos = await Video.find({}, '_id subject subject_id').lean();

  const { updates, unresolved } = resolveSubjectIds(videos, subjects);
  const alreadyMigrated = videos.length - updates.length - unresolved.length;

  if (!isDryRun && updates.length) {
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
  console.log(`Updated: ${updates.length}`);
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
