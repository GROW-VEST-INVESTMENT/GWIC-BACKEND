const mongoose = require('mongoose');

const savingsGoalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    targetAmount: { type: Number, required: true, min: 1, max: 1000000000000 },
    targetDate: { type: Date, default: null },
    planDurationDays: { type: Number, enum: [30, 90, 180, 365], default: null },
    plannedContributionAmount: { type: Number, min: 1, default: null },
    plannedContributionFrequency: { type: String, enum: ['weekly', 'monthly', null], default: null },
    savedAmount: { type: Number, default: 0, min: 0, max: 1000000000000 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('SavingsGoal', savingsGoalSchema);
