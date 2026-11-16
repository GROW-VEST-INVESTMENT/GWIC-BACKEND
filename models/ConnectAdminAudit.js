const mongoose = require('mongoose');

const connectAdminAuditSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: {
      type: String,
      enum: ['application_reviewed', 'partner_status_changed', 'commission_reviewed', 'payout_reviewed', 'policy_updated'],
      required: true,
    },
    entityType: { type: String, enum: ['application', 'partner', 'commission', 'payout', 'policy'], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

connectAdminAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ConnectAdminAudit', connectAdminAuditSchema);
