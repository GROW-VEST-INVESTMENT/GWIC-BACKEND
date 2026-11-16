const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const { createWithdrawal, initializeDeposit, verifyAndCreditDeposit } = require('../controllers/walletController');
const TransactionTierPolicy = require('../models/TransactionTierPolicy');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

function makeQuery(value) {
  return {
    select() { return this; },
    session() { return this; },
    lean() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function mockTier0Reads(t, userId) {
  const originals = {
    userFindById: User.findById,
    policyFindOne: TransactionTierPolicy.findOne,
    aggregate: WalletTransaction.aggregate,
  };
  const user = {
    _id: userId,
    email: 'customer@example.com',
    isKycVerified: false,
    transactionTier: null,
    tierUsageRevision: 0,
    async save() {},
  };
  User.findById = () => makeQuery(user);
  TransactionTierPolicy.findOne = () => makeQuery(null);
  WalletTransaction.aggregate = () => ({
    session() { return this; },
    then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
  });
  t.after(() => {
    User.findById = originals.userFindById;
    TransactionTierPolicy.findOne = originals.policyFindOne;
    WalletTransaction.aggregate = originals.aggregate;
  });
  return user;
}

test('deposit requests over the current tier limit are rejected before checkout is initialized', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  mockTier0Reads(t, userId);
  const originalCreate = WalletTransaction.create;
  const originalStartSession = mongoose.startSession;
  const originalFrontendUrl = process.env.FRONTEND_URL;
  WalletTransaction.create = async () => {
    throw new Error('A blocked deposit must not create a pending payment.');
  };
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    async endSession() {},
  });
  process.env.FRONTEND_URL = 'https://example.test';
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('A blocked deposit must not contact Paystack.');
  };

  try {
    const response = makeResponse();
    await initializeDeposit(
      { body: { amount: 10001 }, user: { id: userId, email: 'customer@example.com' } },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.upgradeRequired, true);
    assert.match(response.body.message, /Tier 0.*Upgrade to Tier 1/i);
    assert.equal(fetchCalled, false);
  } finally {
    WalletTransaction.create = originalCreate;
    mongoose.startSession = originalStartSession;
    global.fetch = originalFetch;
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  }
});

test('Tier 0 may withdraw no amount and receives an upgrade message', async (t) => {
  mockTier0Reads(t, new mongoose.Types.ObjectId());
  const originalFindOne = WalletTransaction.findOne;
  WalletTransaction.findOne = async () => null;
  try {
    const response = makeResponse();
    await createWithdrawal(
      {
        body: {
          amount: 100,
          accountNumber: '0123456789',
          bankCode: '044',
          password: 'valid-password',
          idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
        },
        user: { id: '507f1f77bcf86cd799439011' },
      },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.upgradeRequired, true);
    assert.match(response.body.message, /withdrawal.*Tier 0.*Upgrade to Tier 1/i);
  } finally {
    WalletTransaction.findOne = originalFindOne;
  }
});

test('a provider-confirmed deposit that exceeds tier limits is held for review', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  mockTier0Reads(t, userId);
  const originalFetch = global.fetch;
  const originalUpdateOne = WalletTransaction.updateOne;
  const originalKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_tier-check';
  let update;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: true,
      data: {
        status: 'success',
        reference: 'GWIC_DEP_test',
        amount: 1000100,
        currency: 'NGN',
      },
    }),
  });
  WalletTransaction.updateOne = async (_filter, change) => {
    update = change;
  };

  try {
    const status = await verifyAndCreditDeposit({
      _id: new mongoose.Types.ObjectId(),
      userId,
      reference: 'GWIC_DEP_test',
      amountKobo: 1000100,
      tierAtInitiation: 0,
    });
    assert.equal(status, 'requires_approval');
    assert.equal(update.$set.status, 'requires_approval');
    assert.match(update.$set.reviewReason, /Upgrade to Tier 1/i);
  } finally {
    global.fetch = originalFetch;
    WalletTransaction.updateOne = originalUpdateOne;
    if (originalKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalKey;
  }
});
