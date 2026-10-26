const mongoose = require('mongoose');

const supportRequestSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, enum: ['account', 'verification', 'payments', 'technical', 'other'], required: true },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open', required: true },
    staffNote: { type: String, default: '', maxlength: 1000, select: false },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

supportRequestSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('SupportRequest', supportRequestSchema);
