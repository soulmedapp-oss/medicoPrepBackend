const { databaseOptions } = require('../src/utils/databaseConfig');
require('dotenv').config();
const mongoose = require('mongoose');
const TestAttempt = require('../src/models/TestAttempt');
const ExamPaper = require('../src/models/ExamPaper');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { ...databaseOptions(), autoIndex: false });
  try {
    // Add declared indexes only; never drop indexes or delete old attempts.
    await TestAttempt.createIndexes();
    await ExamPaper.createIndexes();
    console.log('Exam indexes prepared. Active-attempt uniqueness is enforced by MongoDB.');
  } finally { await mongoose.disconnect(); }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
