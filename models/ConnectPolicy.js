const mongoose = require('mongoose');

const connectPolicySchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    registrationRewardNaira: { type: Number, default: 40, min: 0 },
    kycRewardNaira: { type: Number, default: 60, min: 0 },
    firstDepositRewardNaira: { type: Number, default: 200, min: 0 },
    activeSaverBonusNaira: { type: Number, default: 100, min: 0 },
    milestoneRewardsEnabled: { type: Boolean, default: false },
    minimumPayoutNaira: { type: Number, default: 1000, min: 1 },
    payoutDays: {
      type: [{ type: Number, min: 0, max: 6 }],
      default: [1],
      validate: {
        validator: (days) => Array.isArray(days)
          && days.length > 0
          && new Set(days).size === days.length,
        message: 'Select at least one unique payout weekday.',
      },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('ConnectPolicy', connectPolicySchema);
