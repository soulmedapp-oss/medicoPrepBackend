const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    actor_name: { type: String, default: '' },
    action: { type: String, required: true, index: true },
    target_type: { type: String, default: '' },
    target_id: { type: String, default: '' },
    target_label: { type: String, default: '' },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: 'created_date', updatedAt: false },
    // Addendum D: a model call made without a live connection otherwise
    // buffers for mongoose's default 10s before rejecting — too slow for a
    // write that sits in the middle of an already-answered request path.
    // With this off, it fails immediately and recordAudit swallows it.
    bufferCommands: false,
  }
);
auditLogSchema.index({ created_date: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
