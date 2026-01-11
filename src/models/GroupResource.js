const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    user_email: { type: String, required: true },
    user_name: { type: String, default: '' },
    message: { type: String, required: true },
    created_date: { type: Date, default: Date.now },
  },
  { _id: false }
);

const groupResourceSchema = new mongoose.Schema(
  {
    group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StudyGroup', required: true, index: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    user_email: { type: String, required: true },
    user_name: { type: String, default: '' },
    type: { type: String, default: 'note' },
    title: { type: String, required: true },
    content: { type: String, default: '' },
    url: { type: String, default: '' },
    liked_by: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
    like_count: { type: Number, default: 0 },
    comments: { type: [commentSchema], default: [] },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('GroupResource', groupResourceSchema);
