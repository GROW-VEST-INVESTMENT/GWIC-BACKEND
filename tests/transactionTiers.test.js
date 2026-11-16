const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DEFAULT_TIERS,
  getLimitViolation,
  getTierLevel,
  validateTierPolicy,
} = require('../services/transactionTiers');

test('default verification tiers use the agreed deposit and withdrawal limits', () => {
  assert.deepEqual(DEFAULT_TIERS.map((tier) => ({
    level: tier.level,
    deposit: tier.deposit,
    withdrawal: tier.withdrawal,
  })), [
    {
      level: 0,
      deposit: { perTransaction: 10000, perDay: 20000, perMonth: 50000 },
      withdrawal: { perTransaction: 0, perDay: 0, perMonth: 0 },
    },
    {
      level: 1,
      deposit: { perTransaction: 100000, perDay: 200000, perMonth: 1000000 },
      withdrawal: { perTransaction: 50000, perDay: 100000, perMonth: 500000 },
    },
    {
      level: 2,
      deposit: { perTransaction: 500000, perDay: 1000000, perMonth: 5000000 },
      withdrawal: { perTransaction: 250000, perDay: 500000, perMonth: 2000000 },
    },
    {
      level: 3,
      deposit: { perTransaction: 2000000, perDay: 5000000, perMonth: 20000000 },
      withdrawal: { perTransaction: 1000000, perDay: 2000000, perMonth: 10000000 },
    },
  ]);
});

test('legacy approved users map to Tier 2 unless an admin explicitly assigned a tier', () => {
  assert.equal(getTierLevel({ isKycVerified: true }), 2);
  assert.equal(getTierLevel({ isKycVerified: false }), 0);
  assert.equal(getTierLevel({ isKycVerified: true, transactionTier: 1 }), 1);
  assert.equal(getTierLevel({ isKycVerified: false, transactionTier: 8 }), 0);
});

test('transaction limits reject per-transaction and cumulative daily or monthly overages', () => {
  const limits = { perTransaction: 500000, perDay: 1000000, perMonth: 5000000 };
  assert.equal(getLimitViolation(50000001, limits, { daily: 0, monthly: 0 }), 'perTransaction');
  assert.equal(getLimitViolation(40000000, limits, { daily: 70000000, monthly: 0 }), 'perDay');
  assert.equal(getLimitViolation(10000000, limits, { daily: 0, monthly: 499500000 }), 'perMonth');
  assert.equal(getLimitViolation(10000000, limits, { daily: 0, monthly: 0 }), null);
});

test('admin policy validation requires four ordered, whole-naira tier schedules', () => {
  const validTiers = DEFAULT_TIERS.map((tier) => ({
    ...tier,
    deposit: { ...tier.deposit },
    withdrawal: { ...tier.withdrawal },
  }));
  assert.equal(validateTierPolicy(validTiers).length, 4);
  assert.equal(validateTierPolicy(validTiers.slice(0, 3)), null);
  assert.equal(validateTierPolicy([
    ...validTiers.slice(0, 3),
    { ...validTiers[3], deposit: { ...validTiers[3].deposit, perDay: 100 } },
  ]), null);
  assert.equal(validateTierPolicy([
    { ...validTiers[0], withdrawal: { perTransaction: 1, perDay: 1, perMonth: 1 } },
    ...validTiers.slice(1),
  ]), null);
});
