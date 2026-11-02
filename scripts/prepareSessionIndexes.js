require('dotenv').config();
const mongoose = require('mongoose');
const { databaseOptions } = require('../src/utils/databaseConfig');
const User = require('../src/models/User');
(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { ...databaseOptions(), autoIndex: false });
  await User.collection.createIndex({ 'refresh_tokens.hash': 1 }, { sparse: true });
  await User.collection.createIndex({ 'active_session.previous_refresh_hash': 1 }, { sparse: true });
  console.log('Session lookup indexes prepared. No existing indexes or user records were removed.');
})().catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => mongoose.disconnect());
