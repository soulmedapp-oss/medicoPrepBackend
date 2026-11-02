require('dotenv').config();
const mongoose = require('mongoose');
const { databaseOptions } = require('../src/utils/databaseConfig');
const LoginEvent = require('../src/models/LoginEvent');
(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { ...databaseOptions(), autoIndex: false });
  await LoginEvent.createIndexes();
  console.log('LoginEvent indexes prepared, including automatic expiry after 30 days.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
