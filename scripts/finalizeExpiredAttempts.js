const { databaseOptions } = require('../src/utils/databaseConfig');
require('dotenv').config();
const mongoose = require('mongoose');
const { finalizeExpiredAttempts, reconcileCompletionEffects } = require('../src/services/examAttemptService');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { ...databaseOptions(), autoIndex: false });
  try {
    const result = await finalizeExpiredAttempts({ limit: 500 });
    console.log(JSON.stringify(result));
    console.log(JSON.stringify(await reconcileCompletionEffects()));
    if (result.failures.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
