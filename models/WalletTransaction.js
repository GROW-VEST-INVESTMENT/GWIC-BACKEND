const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: { type: String, required: true, enum: ['deposit', 'withdrawal'] },
    amountKobo: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'requires_approval', 'successful', 'failed', 'reversed'],
      default: 'pending',
    },
    authorizationUrl: { type: String, default: null },
    transferCode: { type: String, default: null },
    recipientCode: { type: String, default: null },
    accountName: { type: String, default: null },
    bankName: { type: String, default: null },
    accountLast4: { type: String, default: null },
    failureReason: { type: String, default: null },
    refundedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
