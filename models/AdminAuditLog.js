const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: ['kyc.reviewed', 'support.status_updated'], required: true },
    targetType: { type: String, enum: ['verification_request', 'support_request'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    previousStatus: { type: String, required: true },
    nextStatus: { type: String, required: true },
    note: { type: String, required: true, trim: true, maxlength: 1000 },
    evidenceReviewed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

adminAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
