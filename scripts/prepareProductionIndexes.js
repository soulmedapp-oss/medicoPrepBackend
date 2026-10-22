const { databaseOptions } = require('../src/utils/databaseConfig');
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { ...databaseOptions(), autoIndex: false, maxPoolSize: 5 });
  const directory = path.join(__dirname, '../src/models');
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.js'))) require(path.join(directory, file));
  // Add declared indexes only; never drop existing indexes or repair data silently.
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes();
    console.log(`Indexes prepared: ${model.modelName}`);
  }
})().catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
