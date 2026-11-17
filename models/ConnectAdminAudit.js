const mongoose = require('mongoose');

const connectAdminAuditSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: {
      type: String,
      enum: [
        'application_reviewed',
        'application_message_sent',
        'connect_id_card_submitted',
        'connect_id_card_reviewed',
        'connect_id_card_unissued',
        'partner_status_changed',
        'commission_reviewed',
        'payout_reviewed',
        'payout_transfer_otp_submitted',
        'payout_transfer_succeeded',
        'payout_transfer_failed',
        'payout_transfer_reversed',
        'policy_updated',
        'opportunity_created',
        'opportunity_updated',
      ],
      required: true,
    },
    entityType: { type: String, enum: ['application', 'connect_id_card', 'partner', 'commission', 'payout', 'policy', 'opportunity'], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

connectAdminAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ConnectAdminAudit', connectAdminAuditSchema);
