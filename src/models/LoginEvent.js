const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  method: { type: String, enum: ['google', 'password'], required: true },
  occurred_at: { type: Date, required: true },
  expires_at: { type: Date, required: true },
  ip: { type: String, maxlength: 100, default: '' },
  user_agent: { type: String, maxlength: 512, default: '' },
}, { bufferCommands: false, versionKey: false });
schema.index({ user_id: 1, occurred_at: -1 });
schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('LoginEvent', schema);
