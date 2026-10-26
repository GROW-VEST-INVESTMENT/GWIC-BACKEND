const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const InvestmentPlan = require('../models/InvestmentPlan');
const LedgerEntry = require('../models/LedgerEntry');
const User = require('../models/User');
const {
  PRODUCT_TERMS,
  addUtcDays,
  calculateEarlyExit,
  createJournal,
} = require('../services/coreSavings');
const { getOrCreateWallet } = require('../services/wallet');

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toNaira(amountKobo) {
  return amountKobo / 100;
}

function estimateYieldKobo(principalKobo, annualYieldBps, days) {
  const estimate = Number(
    (BigInt(principalKobo) * BigInt(annualYieldBps) * BigInt(days))
      / BigInt(365 * 10000),
  );
  if (!Number.isSafeInteger(estimate)) {
    throw new RangeError('Estimated Core savings yield exceeds the supported amount.');
  }
  return estimate;
}

function serializePlan(plan) {
  return {
    id: plan._id.toString(),
    productType: plan.productType,
    principalAmount: toNaira(plan.principalKobo),
    accruedYield: toNaira(plan.accruedYieldKobo),
    lockPeriodDays: plan.lockPeriodDays,
    annualYieldPercent: plan.annualYieldBps / 100,
    startDate: plan.startDate,
    maturityDate: plan.maturityDate,
    status: plan.status,
  };
}

async function getCoreSavings(req, res, next) {
  try {
    const enabled = process.env.CORE_SAVINGS_ENABLED === 'true';
    const plans = await InvestmentPlan.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    const products = Object.entries(PRODUCT_TERMS).map(([productType, terms]) => ({
      productType,
      annualYieldPercent: terms.annualYieldBps / 100,
      minimumDays: terms.minimumDays,
      maximumDays: terms.maximumDays,
      available: enabled && terms.available,
      withdrawalEnabled: terms.withdrawalEnabled,
      availabilityMessage: !terms.available
        ? 'Core Flex is not available until instant withdrawals are backed by a documented liquidity reserve or facility.'
        : enabled
          ? null
          : 'Core savings is not enabled until its asset placement, custody, reconciliation, and operating controls are ready.',
    }));

    return res.json({
      currency: 'NGN',
      isKycVerified: Boolean(req.user.isKycVerified),
      products,
      plans: plans.map(serializePlan),
    });
  } catch (error) {
    return next(error);
  }
}

async function createCoreSavingsPlan(req, res, next) {
  const {
    productType,
    amount: amountNaira,
    lockPeriodDays,
    idempotencyKey,
  } = req.body || {};
  const terms = PRODUCT_TERMS[productType];
  if (!terms || !terms.available || process.env.CORE_SAVINGS_ENABLED !== 'true') {
    return res.status(400).json({ message: 'This Core savings product is not currently available.' });
  }
  if (
    !Number.isSafeInteger(amountNaira)
    || amountNaira < 1
    || !Number.isSafeInteger(amountNaira * 100)
    || amountNaira * 100 > Number.MAX_SAFE_INTEGER
  ) {
    return res.status(400).json({ message: 'Enter a valid whole-naira investment amount.' });
  }
  const principalKobo = amountNaira * 100;
  const estimatedYieldKobo = estimateYieldKobo(
    principalKobo,
    terms.annualYieldBps,
    Number.isSafeInteger(lockPeriodDays) ? lockPeriodDays : terms.minimumDays,
  );
  if (!Number.isSafeInteger(principalKobo + estimatedYieldKobo)) {
    return res.status(400).json({ message: 'This amount exceeds the supported Core savings limit.' });
  }
  if (
    !Number.isSafeInteger(lockPeriodDays)
    || lockPeriodDays < terms.minimumDays
    || lockPeriodDays > terms.maximumDays
  ) {
    return res.status(400).json({
      message: `${productType === 'CORE_TARGET' ? 'Core Target' : 'Core Lock'} terms must be ${terms.minimumDays}–${terms.maximumDays} days.`,
    });
  }
  if (!isUuid(idempotencyKey)) {
    return res.status(400).json({ message: 'Review the investment and try again.' });
  }
  if (!req.user.isKycVerified) {
    return res.status(403).json({ message: 'Complete identity verification before starting a Core savings plan.' });
  }

  try {
    const existing = await InvestmentPlan.findOne({ userId: req.user.id, idempotencyKey });
    if (existing) return res.status(200).json({ plan: serializePlan(existing), reused: true });

    const session = await mongoose.startSession();
    let plan;
    try {
      await session.withTransaction(async () => {
        const existingPlan = await InvestmentPlan.findOne({
          userId: req.user.id,
          idempotencyKey,
        }).session(session);
        if (existingPlan) {
          plan = existingPlan;
          return;
        }

        const wallet = await getOrCreateWallet(req.user.id, session);
        if (wallet.balanceKobo < principalKobo) {
          const error = new Error('Your available wallet balance is too low for this investment.');
          error.status = 400;
          throw error;
        }

        const startDate = new Date();
        const maturityDate = addUtcDays(startDate, lockPeriodDays);
        wallet.balanceKobo -= principalKobo;
        await wallet.save({ session });
        [plan] = await InvestmentPlan.create([{
          userId: req.user.id,
          productType,
          principalKobo,
          annualYieldBps: terms.annualYieldBps,
          annualSpreadBps: terms.annualSpreadBps,
          lockPeriodDays,
          startDate,
          maturityDate,
          lastAccrualDate: new Date(Date.UTC(
            startDate.getUTCFullYear(),
            startDate.getUTCMonth(),
            startDate.getUTCDate() - 1,
          )),
          idempotencyKey,
        }], { session });

        await createJournal({
          session,
          idempotencyKey: `core-invest:${plan._id}`,
          transactionType: 'CORE_LOCK_INVESTMENT',
          description: `Started ${productType.replace('_', ' ')} savings plan.`,
          timestamp: startDate,
          postings: [
            { userId: req.user.id, accountCode: 'USER_WALLET', amountKobo: principalKobo, entryType: 'DEBIT' },
            { userId: req.user.id, accountCode: 'INVESTMENT_PRINCIPAL', amountKobo: principalKobo, entryType: 'CREDIT' },
          ],
        });
      });
    } finally {
      await session.endSession();
    }
    return res.status(201).json({
      plan: serializePlan(plan),
      estimatedYieldAtMaturity: toNaira(estimateYieldKobo(
        plan.principalKobo,
        plan.annualYieldBps,
        plan.lockPeriodDays,
      )),
      message: 'Your investment is active. Yield is indicative until each daily accrual is recorded; the principal is locked until maturity or eligible early liquidation.',
    });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await InvestmentPlan.findOne({ userId: req.user.id, idempotencyKey });
      if (existing) return res.status(200).json({ plan: serializePlan(existing), reused: true });
    }
    return next(error);
  }
}

async function liquidateCoreSavingsPlan(req, res, next) {
  const { password, idempotencyKey } = req.body || {};
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ message: 'Enter your password to confirm early liquidation.' });
  }
  if (!isUuid(idempotencyKey)) {
    return res.status(400).json({ message: 'Review the liquidation and try again.' });
  }

  try {
    const journalKey = `core-liquidate:${req.params.planId}:${idempotencyKey}`;
    const priorJournal = await LedgerEntry.findOne({ idempotencyKey: journalKey, userId: req.user.id });
    if (priorJournal) {
      const priorEntries = await LedgerEntry.find({ idempotencyKey: journalKey })
        .select('accountCode amountKobo entryType')
        .lean();
      const amountFor = (accountCode) => (
        priorEntries.find((entry) => entry.accountCode === accountCode)?.amountKobo || 0
      );
      return res.json({
        status: 'EARLY_LIQUIDATED',
        returnedToWallet: toNaira(amountFor('USER_WALLET')),
        penalty: toNaira(amountFor('EARLY_EXIT_PENALTY_REVENUE')),
        forfeitedYield: toNaira(amountFor('FORFEITED_YIELD_REVENUE')),
        message: 'Early liquidation was already completed. No additional funds were moved.',
        reused: true,
      });
    }

    const user = await User.findById(req.user.id).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(403).json({ message: 'Your password could not be confirmed.' });
    }

    const session = await mongoose.startSession();
    let response;
    try {
      await session.withTransaction(async () => {
        const plan = await InvestmentPlan.findOne({
          _id: req.params.planId,
          userId: req.user.id,
        }).session(session);
        if (!plan) {
          const error = new Error('Core savings plan was not found.');
          error.status = 404;
          throw error;
        }
        if (plan.status !== 'ACTIVE') {
          const error = new Error('Only active Core savings plans can be liquidated early.');
          error.status = 409;
          throw error;
        }
        if (new Date() >= plan.maturityDate) {
          const error = new Error('This plan has reached maturity. Run the maturity payout before requesting early liquidation.');
          error.status = 409;
          throw error;
        }

        const result = calculateEarlyExit(plan.principalKobo, plan.accruedYieldKobo);
        const wallet = await getOrCreateWallet(req.user.id, session);
        wallet.balanceKobo += result.payoutKobo;
        await wallet.save({ session });
        plan.status = 'EARLY_LIQUIDATED';
        plan.liquidatedAt = new Date();
        await plan.save({ session });

        const postings = [
          { userId: req.user.id, accountCode: 'INVESTMENT_PRINCIPAL', amountKobo: plan.principalKobo, entryType: 'DEBIT' },
          { userId: req.user.id, accountCode: 'USER_YIELD_PAYABLE', amountKobo: plan.accruedYieldKobo, entryType: 'DEBIT' },
          { userId: req.user.id, accountCode: 'USER_WALLET', amountKobo: result.payoutKobo, entryType: 'CREDIT' },
          { userId: null, accountCode: 'EARLY_EXIT_PENALTY_REVENUE', amountKobo: result.penaltyKobo, entryType: 'CREDIT' },
          { userId: null, accountCode: 'FORFEITED_YIELD_REVENUE', amountKobo: result.forfeitedYieldKobo, entryType: 'CREDIT' },
        ].filter((posting) => posting.amountKobo > 0);
        await createJournal({
          session,
          idempotencyKey: journalKey,
          transactionType: 'EARLY_WITHDRAWAL_PENALTY',
          description: `Early liquidation of ${plan.productType.replace('_', ' ')} plan.`,
          timestamp: plan.liquidatedAt,
          postings,
        });
        response = {
          status: plan.status,
          returnedToWallet: toNaira(result.payoutKobo),
          penalty: toNaira(result.penaltyKobo),
          forfeitedYield: toNaira(result.forfeitedYieldKobo),
          message: 'Early liquidation is complete. The penalty and forfeited yield are shown above.',
        };
      });
    } finally {
      await session.endSession();
    }
    return res.json(response);
  } catch (error) {
    if (error instanceof mongoose.Error.CastError) {
      return res.status(400).json({ message: 'Choose a valid Core savings plan.' });
    }
    return next(error);
  }
}

module.exports = {
  createCoreSavingsPlan,
  getCoreSavings,
  liquidateCoreSavingsPlan,
  serializePlan,
};
