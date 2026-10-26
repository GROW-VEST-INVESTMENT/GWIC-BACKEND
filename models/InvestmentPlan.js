const mongoose = require('mongoose');

const investmentPlanSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    productType: {
      type: String,
      required: true,
      enum: ['CORE_TARGET', 'CORE_LOCK'],
      index: true,
    },
    principalKobo: { type: Number, required: true, min: 1 },
    accruedYieldKobo: { type: Number, default: 0, min: 0 },
    accruedSpreadKobo: { type: Number, default: 0, min: 0 },
    yieldRemainder: { type: Number, default: 0, min: 0 },
    spreadRemainder: { type: Number, default: 0, min: 0 },
    annualYieldBps: { type: Number, required: true, min: 0, max: 2000 },
    annualSpreadBps: { type: Number, required: true, min: 0, max: 2000 },
    lockPeriodDays: { type: Number, required: true, min: 30, max: 365 },
    startDate: { type: Date, required: true },
    maturityDate: { type: Date, required: true },
    lastAccrualDate: { type: Date, required: true },
    idempotencyKey: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['ACTIVE', 'MATURED', 'EARLY_LIQUIDATED'],
      default: 'ACTIVE',
      index: true,
    },
    liquidatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

investmentPlanSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
investmentPlanSchema.index({ status: 1, maturityDate: 1 });

module.exports = mongoose.model('InvestmentPlan', investmentPlanSchema);
