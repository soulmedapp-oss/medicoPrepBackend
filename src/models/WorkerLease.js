const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id: String,
  owner: String,
  expires_at: { type: Date, required: true },
});

module.exports = mongoose.model('WorkerLease', schema);
