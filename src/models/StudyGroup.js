const mongoose = require('mongoose');

const groupMemberSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    user_email: { type: String, required: true },
    user_name: { type: String, default: '' },
    role: { type: String, default: 'member' },
  },
  { _id: false }
);

const studyGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: { type: [groupMemberSchema], default: [] },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('StudyGroup', studyGroupSchema);
