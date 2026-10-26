const mongoose = require('mongoose');

const linkedBankAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    bankCode: { type: String, required: true },
    bankName: { type: String, required: true },
    accountName: { type: String, required: true },
    accountLast4: { type: String, required: true, match: /^\d{4}$/ },
    accountFingerprint: { type: String, required: true },
    recipientCode: { type: String, required: true, select: false },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

linkedBankAccountSchema.index({ userId: 1, accountFingerprint: 1 }, { unique: true });

module.exports = mongoose.model('LinkedBankAccount', linkedBankAccountSchema);
