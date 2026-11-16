const mongoose = require('mongoose');

const connectPayoutSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectPartner', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    linkedBankId: { type: mongoose.Schema.Types.ObjectId, ref: 'LinkedBankAccount', required: true },
    bankName: { type: String, required: true, trim: true, maxlength: 120 },
    accountLast4: { type: String, required: true, match: /^\d{4}$/ },
    amountKobo: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'paid'], default: 'pending', required: true },
    reviewNote: { type: String, trim: true, maxlength: 500, default: '' },
    paymentReference: { type: String, trim: true, maxlength: 120, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);

connectPayoutSchema.index({ userId: 1, createdAt: -1 });
connectPayoutSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('ConnectPayout', connectPayoutSchema);
