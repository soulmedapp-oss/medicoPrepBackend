const mongoose = require('mongoose');

const teacherRequestSchema = new mongoose.Schema(
  {
    teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    teacher_email: { type: String, required: true, index: true },
    teacher_name: { type: String, default: '' },
    type: { type: String, default: 'suggestion' },
    category: { type: String, default: 'general' },
    priority: { type: String, default: 'medium' },
    module: { type: String, default: '' },
    impact: { type: String, default: 'students' },
    title: { type: String, required: true },
    description: { type: String, required: true },
    desired_outcome: { type: String, default: '' },
    reference_links: { type: [String], default: [] },
    contact_methods: { type: [String], default: [] },
    contact_email: { type: String, default: '' },
    contact_phone: { type: String, default: '' },
    meeting_requested: { type: Boolean, default: false },
    preferred_time_slots: { type: [String], default: [] },
    timezone: { type: String, default: '' },
    status: { type: String, default: 'open' },
    developer_response: { type: String, default: '' },
    response_tags: { type: [String], default: [] },
    responded_by: { type: String, default: '' },
    responded_at: { type: Date },
    meeting_time: { type: Date },
    meeting_link: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('TeacherRequest', teacherRequestSchema);
