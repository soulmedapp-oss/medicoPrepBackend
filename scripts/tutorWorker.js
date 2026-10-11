require('dotenv').config();
const mongoose = require('mongoose');
const { runTutorWorkerOnce } = require('../src/services/tutorWorker');
const { logger } = require('../src/lib/logger');

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, maxPoolSize: 5 });
  while (!stopping) {
    try { await runTutorWorkerOnce(); }
    catch (err) { logger.error({ err }, 'Tutor worker failed'); }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await mongoose.disconnect();
})().catch((err) => { logger.error({ err }, 'Tutor worker startup failed'); process.exitCode = 1; });
