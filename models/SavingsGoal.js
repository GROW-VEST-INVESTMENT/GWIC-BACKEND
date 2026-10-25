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
    savedAmount: { type: Number, default: 0, min: 0, max: 1000000000000 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('SavingsGoal', savingsGoalSchema);
