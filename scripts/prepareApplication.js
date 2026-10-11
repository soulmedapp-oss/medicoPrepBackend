require('dotenv').config();
process.env.RUN_STARTUP_SEEDS = 'true';
const mongoose = require('mongoose');
require('../src/server').ensureDbConnected()
  .then(() => console.log('Application defaults prepared'))
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
