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
        phone: req.user.phone || '',
        isKycVerified: req.user.isKycVerified === true,
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
        targetDate: goal.targetDate || null,
        planDurationDays: goal.planDurationDays || null,
        plannedContributionAmount: goal.plannedContributionAmount || null,
        plannedContributionFrequency: goal.plannedContributionFrequency || null,
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
  const {
    name,
    targetAmount,
    targetDate,
    planDurationDays,
    plannedContributionAmount,
    plannedContributionFrequency,
  } = req.body || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const parsedTarget = typeof targetAmount === 'number' ? targetAmount : Number.NaN;
  const parsedContribution = plannedContributionAmount === null || plannedContributionAmount === undefined
    ? null
    : plannedContributionAmount;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const hasTargetDate = typeof targetDate === 'string' && targetDate.length > 0;
  const parsedDate = hasTargetDate && datePattern.test(targetDate)
    ? new Date(`${targetDate}T00:00:00.000Z`)
    : null;
  const hasPlanDuration = planDurationDays !== null && planDurationDays !== undefined;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  today.setUTCDate(today.getUTCDate() - 1);

  if (
    !normalizedName
    || normalizedName.length > 80
    || !Number.isSafeInteger(parsedTarget)
    || parsedTarget < 1
    || parsedTarget > 1000000000000
    || (hasTargetDate && (
      !parsedDate
      || Number.isNaN(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== targetDate
      || parsedDate < today
    ))
    || (hasPlanDuration && ![30, 90, 180, 365].includes(planDurationDays))
    || (parsedContribution !== null
      && (!Number.isSafeInteger(parsedContribution) || parsedContribution < 1 || parsedContribution > parsedTarget))
    || (parsedContribution !== null && !['weekly', 'monthly'].includes(plannedContributionFrequency))
  ) {
    return res.status(400).json({ message: 'Enter a valid goal name, target, future target date, timeline, and optional contribution plan.' });
  }

  try {
    const goal = await SavingsGoal.create({
      userId: req.user.id,
      name: normalizedName,
      targetAmount: parsedTarget,
      targetDate: parsedDate,
      planDurationDays: hasPlanDuration ? planDurationDays : null,
      plannedContributionAmount: parsedContribution,
      plannedContributionFrequency: parsedContribution === null ? null : plannedContributionFrequency,
    });

    return res.status(201).json({
      goal: {
        id: goal.id,
        name: goal.name,
        targetAmount: goal.targetAmount,
        targetDate: goal.targetDate,
        planDurationDays: goal.planDurationDays || null,
        plannedContributionAmount: goal.plannedContributionAmount,
        plannedContributionFrequency: goal.plannedContributionFrequency,
        savedAmount: goal.savedAmount,
        progress: 0,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getDashboard, createSavingsGoal };
