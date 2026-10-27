const InvestmentPlan = require('../models/InvestmentPlan');
const SavingsGoal = require('../models/SavingsGoal');
const Wallet = require('../models/Wallet');

function toNaira(kobo) {
  return kobo / 100;
}

async function getPortfolio(req, res, next) {
  try {
    const [wallet, plans, savingsGoals] = await Promise.all([
      Wallet.findOne({ userId: req.user.id }).select('balanceKobo').lean(),
      InvestmentPlan.find({ userId: req.user.id, status: 'ACTIVE' })
        .sort({ createdAt: -1 })
        .select('productType principalKobo accruedYieldKobo annualYieldBps lockPeriodDays startDate maturityDate status')
        .lean(),
      SavingsGoal.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .select('name savedAmount targetDate planDurationDays')
        .lean(),
    ]);

    const balanceKobo = wallet?.balanceKobo || 0;
    const savingsBalanceKobo = savingsGoals.reduce((total, goal) => total + Math.round(goal.savedAmount * 100), 0);
    const investedKobo = plans.reduce((total, plan) => total + plan.principalKobo, 0);
    const accruedYieldKobo = plans.reduce((total, plan) => total + (plan.accruedYieldKobo || 0), 0);
    const coreTargetValueKobo = plans
      .filter((plan) => plan.productType === 'CORE_TARGET')
      .reduce((total, plan) => total + plan.principalKobo + (plan.accruedYieldKobo || 0), 0);
    const coreLockValueKobo = plans
      .filter((plan) => plan.productType === 'CORE_LOCK')
      .reduce((total, plan) => total + plan.principalKobo + (plan.accruedYieldKobo || 0), 0);
    const portfolioValueKobo = balanceKobo + savingsBalanceKobo + investedKobo + accruedYieldKobo;

    if (![balanceKobo, savingsBalanceKobo, investedKobo, accruedYieldKobo, coreTargetValueKobo, coreLockValueKobo, portfolioValueKobo]
      .every(Number.isSafeInteger)) {
      throw new RangeError('Portfolio value exceeds the supported amount.');
    }

    return res.json({
      currency: 'NGN',
      portfolioValue: toNaira(portfolioValueKobo),
      availableBalance: toNaira(balanceKobo),
      savingsBalance: toNaira(savingsBalanceKobo),
      investedPrincipal: toNaira(investedKobo),
      accruedYield: toNaira(accruedYieldKobo),
      performanceHistoryAvailable: false,
      allocations: [
        { type: 'core-target', label: 'Core Target', amount: toNaira(coreTargetValueKobo) },
        { type: 'core-lock', label: 'Core Lock', amount: toNaira(coreLockValueKobo) },
        { type: 'savings', label: 'Savings', amount: toNaira(savingsBalanceKobo) },
        { type: 'cash', label: 'Cash Balance', amount: toNaira(balanceKobo) },
      ],
      holdings: [
        ...plans.map((plan) => ({
          id: plan._id.toString(),
          type: plan.productType,
          name: plan.productType === 'CORE_LOCK' ? 'Core Lock' : 'Core Target',
          principal: toNaira(plan.principalKobo),
          accruedYield: toNaira(plan.accruedYieldKobo || 0),
          currentValue: toNaira(plan.principalKobo + (plan.accruedYieldKobo || 0)),
          annualYieldPercent: plan.annualYieldBps / 100,
          lockPeriodDays: plan.lockPeriodDays,
          startDate: plan.startDate,
          maturityDate: plan.maturityDate,
        })),
        ...savingsGoals.map((goal) => ({
          id: goal._id.toString(),
          type: 'SAVINGS',
          name: goal.name,
          principal: goal.savedAmount,
          accruedYield: 0,
          currentValue: goal.savedAmount,
          annualYieldPercent: null,
          lockPeriodDays: goal.planDurationDays,
          startDate: null,
          maturityDate: goal.targetDate,
        })),
      ],
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getPortfolio };
