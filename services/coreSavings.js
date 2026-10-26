const crypto = require('node:crypto');
const LedgerEntry = require('../models/LedgerEntry');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_RATE_DENOMINATOR = 365 * 10000;
const GROSS_ANNUAL_YIELD_BPS = 2000;
const EARLY_EXIT_PENALTY_BPS = 350;
const PRODUCT_TERMS = Object.freeze({
  CORE_FLEX: {
    annualYieldBps: 1000,
    annualSpreadBps: 1000,
    available: false,
    minimumDays: 0,
    maximumDays: 0,
    withdrawalEnabled: false,
  },
  CORE_TARGET: {
    annualYieldBps: 1200,
    annualSpreadBps: 800,
    available: true,
    minimumDays: 30,
    maximumDays: 60,
    withdrawalEnabled: true,
  },
  CORE_LOCK: {
    annualYieldBps: 1500,
    annualSpreadBps: 500,
    available: true,
    minimumDays: 90,
    maximumDays: 365,
    withdrawalEnabled: true,
  },
});

function getUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function calculateDailyAccrual(principalKobo, annualRateBps, previousRemainder = 0) {
  if (
    !Number.isSafeInteger(principalKobo)
    || principalKobo < 1
    || !Number.isSafeInteger(annualRateBps)
    || annualRateBps < 0
    || !Number.isSafeInteger(previousRemainder)
    || previousRemainder < 0
    || previousRemainder >= DAILY_RATE_DENOMINATOR
  ) {
    throw new TypeError('Invalid Core savings accrual input.');
  }

  const numerator = BigInt(principalKobo) * BigInt(annualRateBps) + BigInt(previousRemainder);
  const denominator = BigInt(DAILY_RATE_DENOMINATOR);
  const amountKobo = Number(numerator / denominator);
  const remainder = Number(numerator % denominator);
  if (!Number.isSafeInteger(amountKobo)) {
    throw new RangeError('Core savings accrual exceeds the supported amount.');
  }
  return { amountKobo, remainder };
}

function calculateEarlyExit(principalKobo, accruedYieldKobo) {
  if (
    !Number.isSafeInteger(principalKobo)
    || principalKobo < 1
    || !Number.isSafeInteger(accruedYieldKobo)
    || accruedYieldKobo < 0
  ) {
    throw new TypeError('Invalid Core savings liquidation input.');
  }
  const percentagePenaltyKobo = Number(
    (BigInt(principalKobo) * BigInt(EARLY_EXIT_PENALTY_BPS)) / 10000n,
  );
  const penaltyKobo = Math.min(principalKobo, Math.max(percentagePenaltyKobo, accruedYieldKobo));
  return {
    penaltyKobo,
    payoutKobo: principalKobo - penaltyKobo,
    forfeitedYieldKobo: accruedYieldKobo,
  };
}

async function createJournal({
  session,
  idempotencyKey,
  transactionType,
  description,
  timestamp = new Date(),
  postings,
}) {
  const existing = await LedgerEntry.exists({ idempotencyKey }).session(session);
  if (existing) return false;
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new TypeError('A ledger journal must contain at least two postings.');
  }

  let debits = 0n;
  let credits = 0n;
  const journalId = crypto.randomUUID();
  const entries = postings.map((posting, postingIndex) => {
    if (!Number.isSafeInteger(posting.amountKobo) || posting.amountKobo < 1) {
      throw new TypeError('Ledger posting amounts must be positive whole kobo.');
    }
    const amount = BigInt(posting.amountKobo);
    if (posting.entryType === 'DEBIT') debits += amount;
    else if (posting.entryType === 'CREDIT') credits += amount;
    else throw new TypeError('Ledger entry type must be DEBIT or CREDIT.');

    return {
      journalId,
      idempotencyKey,
      postingIndex,
      userId: posting.userId || null,
      transactionType,
      accountCode: posting.accountCode,
      amountKobo: posting.amountKobo,
      entryType: posting.entryType,
      description,
      timestamp,
    };
  });

  if (debits !== credits) {
    throw new Error('Unbalanced ledger journal.');
  }

  await LedgerEntry.insertMany(entries, { session, ordered: true });
  return true;
}

module.exports = {
  DAILY_RATE_DENOMINATOR,
  EARLY_EXIT_PENALTY_BPS,
  GROSS_ANNUAL_YIELD_BPS,
  PRODUCT_TERMS,
  addUtcDays,
  calculateDailyAccrual,
  calculateEarlyExit,
  createJournal,
  getUtcDay,
};
