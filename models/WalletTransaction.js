const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    idempotencyKey: { type: String, unique: true, sparse: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: { type: String, required: true, enum: ['deposit', 'withdrawal'] },
    amountKobo: { type: Number, required: true, min: 1 },
    tierUsageAt: { type: Date, default: null },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'requires_approval', 'successful', 'failed', 'reversed'],
      default: 'pending',
    },
    authorizationUrl: { type: String, default: null },
    transferCode: { type: String, default: null },
    recipientCode: { type: String, default: null },
    linkedBankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'LinkedBankAccount', default: null },
    accountName: { type: String, default: null },
    bankName: { type: String, default: null },
    accountLast4: { type: String, default: null },
    failureReason: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    tierAtInitiation: { type: Number, enum: [0, 1, 2, 3], default: null },
    reviewReason: { type: String, default: null, maxlength: 500 },
    reviewDecision: { type: String, enum: [null, 'release', 'refund_requested'], default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    refundStatus: {
      type: String,
      enum: ['none', 'requested', 'pending', 'processed', 'failed', 'unknown'],
      default: 'none',
    },
    refundProviderId: { type: String, default: null },
  },
  { timestamps: true },
);

walletTransactionSchema.index({ type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
