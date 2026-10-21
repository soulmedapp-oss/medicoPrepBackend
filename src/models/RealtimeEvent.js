const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  origin: { type: String, required: true },
  kind: { type: String, required: true },
  payload: mongoose.Schema.Types.Mixed,
  created_at: { type: Date, default: Date.now },
});
schema.index({ created_at: 1 }, { expireAfterSeconds: 300, name: 'realtime_event_retention' });
module.exports = mongoose.model('RealtimeEvent', schema);
