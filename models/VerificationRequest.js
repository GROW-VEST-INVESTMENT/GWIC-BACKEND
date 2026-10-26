const mongoose = require('mongoose');

const verificationRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    legalName: { type: String, required: true, trim: true, maxlength: 100 },
    dateOfBirth: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending', required: true },
    consentedAt: { type: Date, required: true },
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
