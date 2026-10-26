const mongoose = require('mongoose');
const InvestmentPlan = require('../models/InvestmentPlan');
const { getOrCreateWallet } = require('./wallet');
const {
  calculateDailyAccrual,
  createJournal,
  getUtcDay,
} = require('./coreSavings');

const DAY_MS = 24 * 60 * 60 * 1000;

async function accruePlanDay(plan, accrualDay, session) {
  const userAccrual = calculateDailyAccrual(
    plan.principalKobo,
    plan.annualYieldBps,
    plan.yieldRemainder,
  );
  const spreadAccrual = calculateDailyAccrual(
    plan.principalKobo,
    plan.annualSpreadBps,
    plan.spreadRemainder,
  );
  plan.accruedYieldKobo += userAccrual.amountKobo;
  plan.accruedSpreadKobo += spreadAccrual.amountKobo;
  plan.yieldRemainder = userAccrual.remainder;
  plan.spreadRemainder = spreadAccrual.remainder;
  plan.lastAccrualDate = new Date(accrualDay);

  const grossKobo = userAccrual.amountKobo + spreadAccrual.amountKobo;
  if (grossKobo > 0) {
    const postings = [
      { userId: null, accountCode: 'YIELD_RECEIVABLE', amountKobo: grossKobo, entryType: 'DEBIT' },
      { userId: plan.userId, accountCode: 'USER_YIELD_PAYABLE', amountKobo: userAccrual.amountKobo, entryType: 'CREDIT' },
      { userId: null, accountCode: 'PLATFORM_YIELD_REVENUE', amountKobo: spreadAccrual.amountKobo, entryType: 'CREDIT' },
    ].filter((posting) => posting.amountKobo > 0);
    await createJournal({
      session,
      idempotencyKey: `core-yield:${plan._id}:${accrualDay}`,
      transactionType: userAccrual.amountKobo > 0 ? 'YIELD_ACCRUAL' : 'PLATFORM_SPREAD',
      description: `Daily yield accrual for ${plan.productType.replace('_', ' ')} plan.`,
      timestamp: new Date(accrualDay + DAY_MS),
      postings,
    });
  }
}

async function maturePlan(plan, session, maturityProcessedAt) {
  const wallet = await getOrCreateWallet(plan.userId, session);
  const payoutKobo = plan.principalKobo + plan.accruedYieldKobo;
  if (!Number.isSafeInteger(payoutKobo) || !Number.isSafeInteger(wallet.balanceKobo + payoutKobo)) {
    throw new RangeError(`Maturity payout exceeds the supported wallet amount for plan ${plan._id}.`);
  }
  wallet.balanceKobo += payoutKobo;
  await wallet.save({ session });

  const postings = [
    { userId: plan.userId, accountCode: 'INVESTMENT_PRINCIPAL', amountKobo: plan.principalKobo, entryType: 'DEBIT' },
    { userId: plan.userId, accountCode: 'USER_YIELD_PAYABLE', amountKobo: plan.accruedYieldKobo, entryType: 'DEBIT' },
    { userId: plan.userId, accountCode: 'USER_WALLET', amountKobo: payoutKobo, entryType: 'CREDIT' },
  ].filter((posting) => posting.amountKobo > 0);
  await createJournal({
    session,
    idempotencyKey: `core-maturity:${plan._id}`,
    transactionType: 'YIELD_PAYOUT',
    description: `Maturity payout for ${plan.productType.replace('_', ' ')} plan.`,
    timestamp: maturityProcessedAt,
    postings,
  });
  plan.status = 'MATURED';
  await plan.save({ session });
}

async function processPlan(planId, now) {
  const session = await mongoose.startSession();
  let outcome = 'unchanged';
  try {
    await session.withTransaction(async () => {
      const plan = await InvestmentPlan.findOne({ _id: planId, status: 'ACTIVE' }).session(session);
      if (!plan) return;

      const endOfCompletedUtcDay = getUtcDay(now) - DAY_MS;
      const startDay = getUtcDay(plan.startDate);
      const lastAccrualDayExclusive = startDay + plan.lockPeriodDays * DAY_MS;
      let nextAccrualDay = getUtcDay(plan.lastAccrualDate) + DAY_MS;
      while (
        nextAccrualDay <= endOfCompletedUtcDay
        && nextAccrualDay < lastAccrualDayExclusive
      ) {
        await accruePlanDay(plan, nextAccrualDay, session);
        nextAccrualDay += DAY_MS;
        outcome = 'accrued';
      }

      if (now >= plan.maturityDate) {
        await maturePlan(plan, session, now);
        outcome = 'matured';
      } else if (outcome === 'accrued') {
        await plan.save({ session });
      }
    });
  } finally {
    await session.endSession();
  }
  return outcome;
}

async function runDailyCoreSavingsSweep(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('Core savings sweep requires a valid date.');
  }

  const activePlans = await InvestmentPlan.find({ status: 'ACTIVE' })
    .select('_id')
    .lean();
  const results = { processed: 0, accrued: 0, matured: 0, unchanged: 0 };
  for (const { _id } of activePlans) {
    const outcome = await processPlan(_id, now);
    results.processed += 1;
    results[outcome] += 1;
  }
  return results;
}

module.exports = { runDailyCoreSavingsSweep };
