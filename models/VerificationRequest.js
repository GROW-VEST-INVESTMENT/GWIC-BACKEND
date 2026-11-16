const mongoose = require('mongoose');

const verificationRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    legalName: { type: String, required: true, trim: true, maxlength: 100 },
    dateOfBirth: { type: Date, required: true },
    requestedTier: { type: Number, enum: [1, 2, 3], default: 1, required: true },
    addressLine: { type: String, default: '', trim: true, maxlength: 150 },
    city: { type: String, default: '', trim: true, maxlength: 80 },
    state: { type: String, default: '', trim: true, maxlength: 80 },
    occupation: { type: String, default: '', trim: true, maxlength: 100 },
    sourceOfFundsCategory: {
      type: String,
      enum: ['', 'salary', 'business_income', 'savings', 'investments', 'other'],
      default: '',
    },
    status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending', required: true },
    consentedAt: { type: Date, required: true },
    consentVersion: { type: String, required: true, default: 'tier-verification-v2' },
    verificationProvider: { type: String, default: '', trim: true, maxlength: 100 },
    verificationReference: { type: String, default: '', trim: true, maxlength: 120 },
    identityCheckConfirmed: { type: Boolean, default: false },
    addressCheckConfirmed: { type: Boolean, default: false },
    sourceOfFundsCheckConfirmed: { type: Boolean, default: false },
    reviewedAt: { type: Date, default: null },
    reviewerNote: { type: String, default: '', maxlength: 500, select: false },
  },
  { timestamps: true },
);

verificationRequestSchema.index({ userId: 1, createdAt: -1 });
verificationRequestSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

module.exports = mongoose.model('VerificationRequest', verificationRequestSchema);
