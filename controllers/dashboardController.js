const SavingsGoal = require('../models/SavingsGoal');

async function getDashboard(req, res, next) {
  try {
    const savingsGoals = await SavingsGoal.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    const savingsBalance = savingsGoals.reduce((total, goal) => total + goal.savedAmount, 0);

    return res.json({
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
      },
      balances: {
        currency: 'NGN',
        total: savingsBalance,
        savings: savingsBalance,
        investments: null,
      },
      performance: null,
      savingsGoals: savingsGoals.map((goal) => ({
        id: goal._id.toString(),
        name: goal.name,
        targetAmount: goal.targetAmount,
        savedAmount: goal.savedAmount,
        progress: Math.min(Math.round((goal.savedAmount / goal.targetAmount) * 100), 100),
      })),
      recentActivity: [],
    });
  } catch (error) {
    return next(error);
  }
}

async function createSavingsGoal(req, res, next) {
  const { name, targetAmount } = req.body || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const parsedTarget = typeof targetAmount === 'number' ? targetAmount : Number.NaN;

  if (
    !normalizedName
    || normalizedName.length > 80
    || !Number.isSafeInteger(parsedTarget)
    || parsedTarget < 1
    || parsedTarget > 1000000000000
  ) {
    return res.status(400).json({ message: 'Enter a goal name and a valid target amount.' });
  }

  try {
    const goal = await SavingsGoal.create({
      userId: req.user.id,
      name: normalizedName,
      targetAmount: parsedTarget,
    });

    return res.status(201).json({
      goal: {
        id: goal.id,
        name: goal.name,
        targetAmount: goal.targetAmount,
        savedAmount: goal.savedAmount,
        progress: 0,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getDashboard, createSavingsGoal };
