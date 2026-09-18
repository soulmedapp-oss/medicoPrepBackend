/**
 * Read-only data classification report for the MongoDB -> EC2 migration (Phase 0).
 *
 * Connects to the app's Atlas database (MONGODB_URI) and, for every collection,
 * prints a document count plus a sample of documents matching heuristic
 * test/seed-data patterns. This NEVER writes, updates, or deletes anything —
 * it is purely informational, to help a human build the exclusion list the
 * real migration script (Phase 3) requires before it will run.
 *
 * Usage:
 *   node src/scripts/migration-report.js
 *
 * Prints Markdown to stdout. Redirect to a file yourself if you want to keep
 * it — the output can contain email addresses, so do not commit it.
 */
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const TEST_EMAIL_PATTERN = /(^|[.+_-])test([.+_-]|@)|@(example|test)\.[a-z]+$/i;
const KNOWN_SEED_TEST_TITLE = 'PSM Intermediate Test - Preventive & Social Medicine';
const SAMPLE_SIZE = 15;

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(mongoUri, { autoIndex: false });
  const db = mongoose.connection.db;
  console.error(`Connected read-only to ${db.databaseName}`);

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();

  const lines = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`# Migration data classification report — ${today}`);
  lines.push('');
  lines.push(`Database: \`${db.databaseName}\` (this is the "prod" data despite the db name)`);
  lines.push('');
  lines.push('This is a heuristic candidates report, not an exclusion list. A human must');
  lines.push('review every "candidate" bucket and confirm it before anything gets excluded.');
  lines.push('');

  for (const name of collections) {
    const coll = db.collection(name);
    const total = await coll.countDocuments();
    lines.push(`## ${name} (${total} documents)`);
    lines.push('');

    if (total === 0) {
      lines.push('_empty_');
      lines.push('');
      continue;
    }

    if (name === 'users') {
      const candidates = await coll
        .find({ email: TEST_EMAIL_PATTERN })
        .project({ email: 1, full_name: 1, created_date: 1 })
        .limit(SAMPLE_SIZE)
        .toArray();
      const candidateCount = await coll.countDocuments({ email: TEST_EMAIL_PATTERN });
      lines.push(`Candidates matching a test-looking email pattern: **${candidateCount}**`);
      lines.push('');
      if (candidateCount > 0) {
        lines.push('| _id | email | full_name | created_date |');
        lines.push('|---|---|---|---|');
        for (const d of candidates) {
          lines.push(`| ${d._id} | ${d.email} | ${d.full_name || ''} | ${d.created_date ? d.created_date.toISOString() : ''} |`);
        }
        lines.push('');
        if (candidateCount > SAMPLE_SIZE) {
          lines.push(`_...and ${candidateCount - SAMPLE_SIZE} more not shown._`);
          lines.push('');
        }
      }
    } else if (name === 'tests') {
      const seedTests = await coll
        .find({ title: KNOWN_SEED_TEST_TITLE })
        .project({ title: 1, subject: 1, created_date: 1 })
        .toArray();
      lines.push(`Documents matching the known seed-script title ("${KNOWN_SEED_TEST_TITLE}"): **${seedTests.length}**`);
      lines.push('');
      if (seedTests.length > 0) {
        lines.push('_Verify with the team whether this is real practice-test content worth keeping in the new `test` database, or throwaway demo content to drop._');
        lines.push('');
        lines.push('| _id | subject | created_date |');
        lines.push('|---|---|---|');
        for (const d of seedTests) {
          lines.push(`| ${d._id} | ${d.subject} | ${d.created_date ? d.created_date.toISOString() : ''} |`);
        }
        lines.push('');
      }
    } else if (name === 'questions') {
      const seedTestIds = await db
        .collection('tests')
        .find({ title: KNOWN_SEED_TEST_TITLE })
        .project({ _id: 1 })
        .toArray();
      if (seedTestIds.length > 0) {
        const linkedCount = await coll.countDocuments({ test_id: { $in: seedTestIds.map((t) => t._id) } });
        lines.push(`Questions linked to the known seed test above: **${linkedCount}** (drop together with the test if excluded)`);
        lines.push('');
      }
    } else if (name === 'subjects') {
      lines.push('_Reference/taxonomy data (subject names like Anatomy, Physiology) — this is real data the app needs, not disposable, even though `seed-subjects.js` created it. No candidates flagged._');
      lines.push('');
    }
  }

  console.log(lines.join('\n'));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
