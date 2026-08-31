const mongoose = require('mongoose');

const subtopicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true },
    is_active: { type: Boolean, default: true },
  },
  { _id: true }
);

const subjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    slug: { type: String, required: true, unique: true, index: true },
    color: { type: String, default: '' },
    is_active: { type: Boolean, default: true },
    sort_order: { type: Number, default: 0 },
    subtopics: { type: [subtopicSchema], default: [] },
    // Teachers allowed to run AI ingestion / question generation for this
    // subject (admins are always allowed). Managed via PUT /subjects/:id/owners.
    owner_ids: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
      index: true,
    },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('Subject', subjectSchema);
