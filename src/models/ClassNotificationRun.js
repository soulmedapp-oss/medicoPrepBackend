const mongoose = require('mongoose');

// One row per (class, kind) send: who was told about a class, when, and what
// failed. This is what the admin sees under "Notifications" in Manage Live
// Class, and what the reminder scheduler consults so it never sends twice.
const failureSchema = new mongoose.Schema(
  { email: String, error: String },
  { _id: false }
);

const classNotificationRunSchema = new mongoose.Schema(
  {
    live_class_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveClass', required: true, index: true },
    kind: { type: String, enum: ['published', 'rescheduled', 'cancelled', 'reminder_1h', 'starting', 'retry'], required: true },
    triggered_by: { type: String, default: 'system' }, // user email or 'system'
    started_at: { type: Date, default: Date.now },
    finished_at: { type: Date },
    in_app: { type: Boolean, default: false },      // bell notification broadcast sent
    email_configured: { type: Boolean, default: true },
    total: { type: Number, default: 0 },            // recipients planned
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },          // opted out / no email
    failures: { type: [failureSchema], default: [] },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

classNotificationRunSchema.index({ live_class_id: 1, kind: 1 });

module.exports = mongoose.model('ClassNotificationRun', classNotificationRunSchema);
