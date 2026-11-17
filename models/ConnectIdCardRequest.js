const mongoose = require('mongoose');

const connectIdCardRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    associateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectAssociate', required: true, index: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectApplication', required: true },
    photoPublicId: { type: String, required: true, trim: true, maxlength: 240 },
    photoFormat: { type: String, required: true, enum: ['jpg', 'png', 'webp'] },
    photoBytes: { type: Number, required: true, min: 1, max: 2097152 },
    verificationId: { type: String, default: null, match: /^[a-f0-9]{48}$/ },
    status: {
      type: String,
      enum: ['pending', 'changes_requested', 'approved', 'rejected', 'revoked'],
      default: 'pending',
      required: true,
      index: true,
    },
    reviewNote: { type: String, trim: true, maxlength: 500, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

connectIdCardRequestSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_connect_id_card_per_user' },
);
connectIdCardRequestSchema.index({ status: 1, createdAt: 1 });
connectIdCardRequestSchema.index(
  { verificationId: 1 },
  { unique: true, partialFilterExpression: { verificationId: { $type: 'string' } }, name: 'connect_id_card_verification_id' },
);

module.exports = mongoose.model('ConnectIdCardRequest', connectIdCardRequestSchema);
