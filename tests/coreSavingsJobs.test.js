const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const InvestmentPlan = require('../models/InvestmentPlan');
const LedgerEntry = require('../models/LedgerEntry');
const Wallet = require('../models/Wallet');
const { runDailyCoreSavingsSweep } = require('../services/coreSavingsJobs');

test('daily sweep catches up completed UTC days and pays a matured plan exactly once', async () => {
  const originalStartSession = mongoose.startSession;
  const originalPlanFind = InvestmentPlan.find;
  const originalPlanFindOne = InvestmentPlan.findOne;
  const originalWalletFindOne = Wallet.findOne;
  const originalWalletCreate = Wallet.create;
  const originalLedgerExists = LedgerEntry.exists;
  const originalLedgerInsertMany = LedgerEntry.insertMany;

  const plan = {
    _id: 'plan-1',
    userId: 'user-1',
    productType: 'CORE_TARGET',
    principalKobo: 10_000_000,
    accruedYieldKobo: 0,
    accruedSpreadKobo: 0,
    yieldRemainder: 0,
    spreadRemainder: 0,
    annualYieldBps: 1200,
    annualSpreadBps: 800,
    lockPeriodDays: 30,
    startDate: new Date('2026-06-01T00:00:00.000Z'),
    maturityDate: new Date('2026-07-01T00:00:00.000Z'),
    lastAccrualDate: new Date('2026-05-31T00:00:00.000Z'),
    status: 'ACTIVE',
    async save() {},
  };
  let wallet = {
    userId: 'user-1',
    balanceKobo: 0,
    async save() {},
  };
  const ledger = [];
  const session = {
    async withTransaction(callback) {
      await callback();
    },
    async endSession() {},
  };

  mongoose.startSession = async () => session;
  InvestmentPlan.find = (filter) => ({
    select() {
      return this;
    },
    lean: async () => (plan.status === filter.status ? [{ _id: plan._id }] : []),
  });
  InvestmentPlan.findOne = (filter) => ({
    session() {
      return Promise.resolve(plan.status === filter.status ? plan : null);
    },
  });
  Wallet.findOne = () => ({
    session() {
      return Promise.resolve(wallet);
    },
  });
  Wallet.create = async ([record]) => {
    wallet = { ...record, async save() {} };
    return [wallet];
  };
  LedgerEntry.exists = (filter) => ({
    session: async () => ledger.some((entry) => entry.idempotencyKey === filter.idempotencyKey),
  });
  LedgerEntry.insertMany = async (entries) => {
    ledger.push(...entries);
  };

  try {
    const firstRun = await runDailyCoreSavingsSweep(new Date('2026-07-01T00:00:00.000Z'));
    assert.deepEqual(firstRun, { processed: 1, accrued: 0, matured: 1, unchanged: 0 });
    assert.equal(plan.status, 'MATURED');
    assert.equal(plan.accruedYieldKobo, 98_630);
    assert.equal(plan.accruedSpreadKobo, 65_753);
    assert.equal(wallet.balanceKobo, 10_098_630);

    const maturityEntries = ledger.filter((entry) => entry.idempotencyKey === 'core-maturity:plan-1');
    assert.equal(maturityEntries.length, 3);
    const secondRun = await runDailyCoreSavingsSweep(new Date('2026-07-02T00:00:00.000Z'));
    assert.deepEqual(secondRun, { processed: 0, accrued: 0, matured: 0, unchanged: 0 });
    assert.equal(wallet.balanceKobo, 10_098_630);
    assert.equal(
      ledger.filter((entry) => entry.idempotencyKey === 'core-maturity:plan-1').length,
      3,
    );

    for (const journalId of [...new Set(ledger.map((entry) => entry.journalId))]) {
      const entries = ledger.filter((entry) => entry.journalId === journalId);
      const debits = entries
        .filter((entry) => entry.entryType === 'DEBIT')
        .reduce((total, entry) => total + entry.amountKobo, 0);
      const credits = entries
        .filter((entry) => entry.entryType === 'CREDIT')
        .reduce((total, entry) => total + entry.amountKobo, 0);
      assert.equal(debits, credits);
    }
  } finally {
    mongoose.startSession = originalStartSession;
    InvestmentPlan.find = originalPlanFind;
    InvestmentPlan.findOne = originalPlanFindOne;
    Wallet.findOne = originalWalletFindOne;
    Wallet.create = originalWalletCreate;
    LedgerEntry.exists = originalLedgerExists;
    LedgerEntry.insertMany = originalLedgerInsertMany;
  }
});
