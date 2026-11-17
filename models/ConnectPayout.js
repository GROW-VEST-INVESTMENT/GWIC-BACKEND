const mongoose = require('mongoose');

const connectPayoutSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectPartner', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    linkedBankId: { type: mongoose.Schema.Types.ObjectId, ref: 'LinkedBankAccount', required: true },
    bankName: { type: String, required: true, trim: true, maxlength: 120 },
    accountLast4: { type: String, required: true, match: /^\d{4}$/ },
    amountKobo: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'processing', 'requires_otp', 'rejected', 'paid', 'failed', 'reversed'],
      default: 'pending',
      required: true,
    },
    reviewNote: { type: String, trim: true, maxlength: 500, default: '' },
    paymentReference: { type: String, trim: true, maxlength: 120, default: '' },
    transferReference: { type: String, trim: true, maxlength: 120, unique: true, sparse: true },
    transferCode: { type: String, trim: true, maxlength: 120, default: null, select: false },
    transferStatus: { type: String, trim: true, maxlength: 40, default: '' },
    transferError: { type: String, trim: true, maxlength: 500, default: '' },
    transferStartedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    reversedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

connectPayoutSchema.index({ userId: 1, createdAt: -1 });
connectPayoutSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('ConnectPayout', connectPayoutSchema);
