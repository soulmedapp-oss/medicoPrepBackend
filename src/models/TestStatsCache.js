const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: mongoose.Schema.Types.ObjectId,
  refreshed_at: Date,
  stats: mongoose.Schema.Types.Mixed,
  distribution: [mongoose.Schema.Types.Mixed],
});
module.exports = mongoose.model('TestStatsCache', schema);
