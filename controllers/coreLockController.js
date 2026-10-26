const SavingsGoal = require('../models/SavingsGoal');
const { getProfilePhotoUrl } = require('../services/profilePhotoStorage');

const LOCK_PERIODS = [30, 90, 180, 365];

async function getCoreLock(req, res, next) {
  try {
    const goals = await SavingsGoal.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      user: {
        id: req.user.id,
        name: req.user.name,
        photoUrl: getProfilePhotoUrl(req.user.profilePhotoPublicId, req.user.profilePhotoVersion),
      },
      status: 'coming-soon',
      currency: 'NGN',
      balance: null,
      monthlyChangePercent: null,
      lockPeriods: LOCK_PERIODS.map((days) => ({
        days,
        annualPercentageYield: null,
        available: false,
      })),
      activeGoals: goals.map((goal) => ({
        id: goal._id.toString(),
        name: goal.name,
        targetAmount: goal.targetAmount,
        savedAmount: goal.savedAmount,
        progress: Math.min(Math.round((goal.savedAmount / goal.targetAmount) * 100), 100),
      })),
      nextContribution: null,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getCoreLock };
