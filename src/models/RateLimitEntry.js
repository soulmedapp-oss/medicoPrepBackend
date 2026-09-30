const mongoose = require('mongoose');

// One document per (limiter, key, window). _id = "<limiter>:<key>:<windowStart>".
// The TTL index removes documents once their window has ended.
const rateLimitEntrySchema = new mongoose.Schema(
  {
    _id: { type: String },
    count: { type: Number, default: 0 },
    expires_at: { type: Date, required: true },
  },
  { versionKey: false }
);

rateLimitEntrySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RateLimitEntry
  || mongoose.model('RateLimitEntry', rateLimitEntrySchema, 'rate_limits');
