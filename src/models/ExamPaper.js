const mongoose = require('mongoose');

// One immutable snapshot per distinct paper, shared by all attempts using it.
const schema = new mongoose.Schema({
  _id: { type: String }, // SHA-256 of the test and ordered question snapshot
  test_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  questions: { type: [mongoose.Schema.Types.Mixed], required: true },
}, { timestamps: true });

module.exports = mongoose.model('ExamPaper', schema);
