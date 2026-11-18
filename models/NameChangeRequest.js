const mongoose = require('mongoose');

const nameChangeRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    currentName: { type: String, required: true, trim: true, maxlength: 100 },
    requestedName: { type: String, required: true, trim: true, maxlength: 100 },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', required: true },
    reviewNote: { type: String, default: '', trim: true, maxlength: 1000 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    identityCheckConfirmed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

nameChangeRequestSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_name_change_per_user' },
);
nameChangeRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('NameChangeRequest', nameChangeRequestSchema);
