const mongoose = require('mongoose');

const transactionLimitsSchema = new mongoose.Schema(
  {
    perTransaction: { type: Number, required: true, min: 0 },
    perDay: { type: Number, required: true, min: 0 },
    perMonth: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const tierSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true, enum: [0, 1, 2, 3] },
    name: { type: String, required: true },
    deposit: { type: transactionLimitsSchema, required: true },
    withdrawal: { type: transactionLimitsSchema, required: true },
  },
  { _id: false },
);

const transactionTierPolicySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    tiers: { type: [tierSchema], required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updateReason: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('TransactionTierPolicy', transactionTierPolicySchema);
