const mongoose = require('mongoose');
const { SFNClient } = require('@aws-sdk/client-sfn');
const { dispatchDueJobs } = require('../src/services/aiJobDispatcher');
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
(async () => {
  if (process.env.AI_DISPATCH_ENABLED !== 'true') throw new Error('AI dispatcher is disabled; explicit handover is required');
  if (!process.env.AI_DB_NAME || !process.env.AI_WORKER_STATE_MACHINE_ARN) throw new Error('AI dispatcher configuration missing');
  const client = new SFNClient({ region: 'ap-south-1', maxAttempts: 3 });
  try {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.AI_DB_NAME, autoIndex: false, maxPoolSize: 3, serverSelectionTimeoutMS: 8000 });
    do {
      const summary = await dispatchDueJobs({ database: mongoose.connection.db, client, stateMachineArn: process.env.AI_WORKER_STATE_MACHINE_ARN });
      console.log(JSON.stringify({ event: 'ai_dispatch_batch', ...summary }));
      if (process.argv.includes('--once')) break;
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 10_000));
    } while (!stopping);
  } finally { client.destroy(); await mongoose.disconnect(); }
})().catch(error => { console.error(JSON.stringify({ event: 'ai_dispatch_failed', type: error.name })); process.exitCode = 1; });
