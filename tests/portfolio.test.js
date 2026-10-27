const assert = require('node:assert/strict');
const { test } = require('node:test');
const InvestmentPlan = require('../models/InvestmentPlan');
const SavingsGoal = require('../models/SavingsGoal');
const Wallet = require('../models/Wallet');
const { getPortfolio } = require('../controllers/portfolioController');

test('portfolio totals include the authenticated user wallet, active Core plans, and savings goals', async () => {
  const originalWalletFindOne = Wallet.findOne;
  const originalInvestmentFind = InvestmentPlan.find;
  const originalSavingsGoalFind = SavingsGoal.find;
  let walletQuery;
  let planQuery;
  let savingsGoalQuery;
  Wallet.findOne = (query) => {
    walletQuery = query;
    return { select: () => ({ lean: async () => ({ balanceKobo: 8043250 }) }) };
  };
  InvestmentPlan.find = (query) => {
    planQuery = query;
    return {
      sort() { return this; },
      select() {
        return {
          lean: async () => [
            {
              _id: { toString: () => 'plan-core-lock' },
              productType: 'CORE_LOCK',
              principalKobo: 100000000,
              accruedYieldKobo: 1250000,
              annualYieldBps: 1500,
              lockPeriodDays: 180,
              startDate: new Date('2026-01-01T00:00:00.000Z'),
              maturityDate: new Date('2026-06-30T00:00:00.000Z'),
            },
            {
              _id: { toString: () => 'plan-core-target' },
              productType: 'CORE_TARGET',
              principalKobo: 30000000,
              accruedYieldKobo: 250000,
              annualYieldBps: 1200,
              lockPeriodDays: 60,
              startDate: new Date('2026-01-01T00:00:00.000Z'),
              maturityDate: new Date('2026-03-02T00:00:00.000Z'),
            },
          ],
        };
      },
    };
  };
  SavingsGoal.find = (query) => {
    savingsGoalQuery = query;
    return {
      sort() { return this; },
      select() {
        return {
          lean: async () => [
            {
              _id: { toString: () => 'goal-travel' },
              name: 'Travel Fund',
              savedAmount: 25000,
              targetDate: new Date('2026-12-31T00:00:00.000Z'),
              planDurationDays: 180,
            },
          ],
        };
      },
    };
  };

  let responseBody;
  try {
    await getPortfolio(
      { user: { id: 'user-portfolio' } },
      { json: (body) => { responseBody = body; return body; } },
      (error) => { throw error; },
    );
  } finally {
    Wallet.findOne = originalWalletFindOne;
    InvestmentPlan.find = originalInvestmentFind;
    SavingsGoal.find = originalSavingsGoalFind;
  }

  assert.deepEqual(walletQuery, { userId: 'user-portfolio' });
  assert.deepEqual(planQuery, { userId: 'user-portfolio', status: 'ACTIVE' });
  assert.deepEqual(savingsGoalQuery, { userId: 'user-portfolio' });
  assert.equal(responseBody.currency, 'NGN');
  assert.equal(responseBody.portfolioValue, 1420432.5);
  assert.equal(responseBody.availableBalance, 80432.5);
  assert.equal(responseBody.savingsBalance, 25000);
  assert.equal(responseBody.investedPrincipal, 1300000);
  assert.equal(responseBody.accruedYield, 15000);
  assert.equal(responseBody.performanceHistoryAvailable, false);
  assert.equal(responseBody.holdings[0].name, 'Core Lock');
  assert.equal(responseBody.holdings[0].currentValue, 1012500);
  assert.deepEqual(responseBody.allocations, [
    { type: 'core-target', label: 'Core Target', amount: 302500 },
    { type: 'core-lock', label: 'Core Lock', amount: 1012500 },
    { type: 'savings', label: 'Savings', amount: 25000 },
    { type: 'cash', label: 'Cash Balance', amount: 80432.5 },
  ]);
  assert.equal(responseBody.holdings.length, 3);
  assert.deepEqual(responseBody.holdings[2], {
    id: 'goal-travel',
    type: 'SAVINGS',
    name: 'Travel Fund',
    principal: 25000,
    accruedYield: 0,
    currentValue: 25000,
    annualYieldPercent: null,
    lockPeriodDays: 180,
    startDate: null,
    maturityDate: new Date('2026-12-31T00:00:00.000Z'),
  });
});

test('portfolio returns zero balances when a user has no wallet, plans, or saved goals', async () => {
  const originalWalletFindOne = Wallet.findOne;
  const originalInvestmentFind = InvestmentPlan.find;
  const originalSavingsGoalFind = SavingsGoal.find;
  Wallet.findOne = () => ({ select: () => ({ lean: async () => null }) });
  InvestmentPlan.find = () => ({
    sort() { return this; },
    select() { return { lean: async () => [] }; },
  });
  SavingsGoal.find = () => ({
    sort() { return this; },
    select() { return { lean: async () => [] }; },
  });
  let responseBody;
  try {
    await getPortfolio(
      { user: { id: 'user-without-assets' } },
      { json: (body) => { responseBody = body; return body; } },
      (error) => { throw error; },
    );
  } finally {
    Wallet.findOne = originalWalletFindOne;
    InvestmentPlan.find = originalInvestmentFind;
    SavingsGoal.find = originalSavingsGoalFind;
  }

  assert.equal(responseBody.portfolioValue, 0);
  assert.equal(responseBody.savingsBalance, 0);
  assert.equal(responseBody.holdings.length, 0);
});

test('portfolio API requires an authenticated session', async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/portfolio`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, 'Please log in to continue.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
