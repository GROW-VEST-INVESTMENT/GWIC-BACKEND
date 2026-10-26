const mongoose = require('mongoose');

const ledgerEntrySchema = new mongoose.Schema(
  {
    journalId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true },
    postingIndex: { type: Number, required: true, min: 0 },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    transactionType: {
      type: String,
      required: true,
      enum: [
        'DEPOSIT',
        'WITHDRAWAL',
        'CORE_LOCK_INVESTMENT',
        'YIELD_PAYOUT',
        'YIELD_ACCRUAL',
        'PLATFORM_SPREAD',
        'EARLY_WITHDRAWAL_PENALTY',
        'STOCK_PURCHASE',
        'OPENING_BALANCE',
      ],
    },
    accountCode: {
      type: String,
      required: true,
      enum: [
        'PAYSTACK_CLEARING',
        'USER_WALLET',
        'INVESTMENT_PRINCIPAL',
        'YIELD_RECEIVABLE',
        'USER_YIELD_PAYABLE',
        'PLATFORM_YIELD_REVENUE',
        'EARLY_EXIT_PENALTY_REVENUE',
        'FORFEITED_YIELD_REVENUE',
        'OPENING_BALANCE_EQUITY',
      ],
    },
    amountKobo: { type: Number, required: true, min: 1 },
    entryType: { type: String, required: true, enum: ['DEBIT', 'CREDIT'] },
    description: { type: String, required: true, maxlength: 240 },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

ledgerEntrySchema.index({ idempotencyKey: 1, postingIndex: 1 }, { unique: true });
ledgerEntrySchema.index({ userId: 1, timestamp: -1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
