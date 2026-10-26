const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const InvestmentPlan = require('../models/InvestmentPlan');
const LedgerEntry = require('../models/LedgerEntry');
const User = require('../models/User');
const {
  calculateDailyAccrual,
  calculateEarlyExit,
  createJournal,
  DAILY_RATE_DENOMINATOR,
  PRODUCT_TERMS,
} = require('../services/coreSavings');
const {
  createCoreSavingsPlan,
  getCoreSavings,
  liquidateCoreSavingsPlan,
} = require('../controllers/coreSavingsController');

const originalFeatureFlag = process.env.CORE_SAVINGS_ENABLED;

after(() => {
  if (originalFeatureFlag === undefined) delete process.env.CORE_SAVINGS_ENABLED;
  else process.env.CORE_SAVINGS_ENABLED = originalFeatureFlag;
});

test('Core Target and Core Lock use the approved terms and preserve a 20% gross yield', () => {
  assert.equal(PRODUCT_TERMS.CORE_TARGET.annualYieldBps, 1200);
  assert.equal(PRODUCT_TERMS.CORE_TARGET.annualSpreadBps, 800);
  assert.equal(PRODUCT_TERMS.CORE_LOCK.annualYieldBps, 1500);
  assert.equal(PRODUCT_TERMS.CORE_LOCK.annualSpreadBps, 500);
  assert.equal(
    PRODUCT_TERMS.CORE_TARGET.annualYieldBps + PRODUCT_TERMS.CORE_TARGET.annualSpreadBps,
    2000,
  );
  assert.equal(
    PRODUCT_TERMS.CORE_LOCK.annualYieldBps + PRODUCT_TERMS.CORE_LOCK.annualSpreadBps,
    2000,
  );
  assert.equal(PRODUCT_TERMS.CORE_FLEX.available, false);
  assert.equal(PRODUCT_TERMS.CORE_FLEX.withdrawalEnabled, false);
});

test('daily kobo accrual carries fractional kobo remainder without losing it', () => {
  let userRemainder = 0;
  let spreadRemainder = 0;
  let userYieldKobo = 0;
  let spreadKobo = 0;

  for (let day = 0; day < 30; day += 1) {
    const user = calculateDailyAccrual(10_000_000, 1200, userRemainder);
    const spread = calculateDailyAccrual(10_000_000, 800, spreadRemainder);
    userYieldKobo += user.amountKobo;
    spreadKobo += spread.amountKobo;
    userRemainder = user.remainder;
    spreadRemainder = spread.remainder;
  }

  assert.equal(userYieldKobo, 98_630);
  assert.equal(spreadKobo, 65_753);
  assert.ok(userRemainder < DAILY_RATE_DENOMINATOR);
  assert.ok(spreadRemainder < DAILY_RATE_DENOMINATOR);
});

test('early liquidation charges the greater of 3.5% of principal or accrued yield', () => {
  assert.deepEqual(calculateEarlyExit(10_000_000, 98_630), {
    penaltyKobo: 350_000,
    payoutKobo: 9_650_000,
    forfeitedYieldKobo: 98_630,
  });
  assert.deepEqual(calculateEarlyExit(10_000_000, 400_000), {
    penaltyKobo: 400_000,
    payoutKobo: 9_600_000,
    forfeitedYieldKobo: 400_000,
  });
});

test('ledger journals reject unbalanced postings before writing entries', async () => {
  const originalExists = LedgerEntry.exists;
  const originalInsertMany = LedgerEntry.insertMany;
  let inserted = false;
  LedgerEntry.exists = () => ({ session: async () => null });
  LedgerEntry.insertMany = async () => { inserted = true; };
  try {
    await assert.rejects(
      createJournal({
        session: {},
        idempotencyKey: 'unbalanced-test',
        transactionType: 'DEPOSIT',
        description: 'Test journal.',
        postings: [
          { accountCode: 'PAYSTACK_CLEARING', amountKobo: 200, entryType: 'DEBIT' },
          { accountCode: 'USER_WALLET', amountKobo: 100, entryType: 'CREDIT' },
        ],
      }),
      /Unbalanced ledger journal/,
    );
  } finally {
    LedgerEntry.exists = originalExists;
    LedgerEntry.insertMany = originalInsertMany;
  }
  assert.equal(inserted, false);
});

test('Core savings is disabled by default and Core Flex remains disabled when enabled', async () => {
  delete process.env.CORE_SAVINGS_ENABLED;
  const originalFind = InvestmentPlan.find;
  InvestmentPlan.find = () => ({
    sort() {
      return this;
    },
    lean: async () => [],
  });
  let responseBody;
  try {
    await getCoreSavings(
      { user: { id: 'user-1' } },
      { json: (body) => { responseBody = body; return body; } },
      (error) => { throw error; },
    );
  } finally {
    InvestmentPlan.find = originalFind;
  }
  assert.equal(responseBody.products.find((product) => product.productType === 'CORE_LOCK').available, false);
  assert.equal(responseBody.products.find((product) => product.productType === 'CORE_FLEX').available, false);

  process.env.CORE_SAVINGS_ENABLED = 'true';
  const flexResult = await new Promise((resolve) => {
    createCoreSavingsPlan(
      {
        user: { id: 'user-1', isKycVerified: true },
        body: {
          productType: 'CORE_FLEX',
          amount: 1000,
          lockPeriodDays: 30,
          idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
        },
      },
      {
        status(code) {
          assert.equal(code, 400);
          return this;
        },
        json: resolve,
      },
      (error) => { throw error; },
    );
  });
  assert.equal(flexResult.message, 'This Core savings product is not currently available.');
});

test('Core savings plan creation is gated by the feature flag and KYC state', async () => {
  const baseRequest = {
    user: { id: 'user-1', isKycVerified: true },
    body: {
      productType: 'CORE_TARGET',
      amount: 1000,
      lockPeriodDays: 30,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    },
  };
  const invoke = (request) => new Promise((resolve) => {
    createCoreSavingsPlan(
      request,
      {
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          resolve({ statusCode: this.statusCode, body });
          return body;
        },
      },
      (error) => { throw error; },
    );
  });

  delete process.env.CORE_SAVINGS_ENABLED;
  const disabled = await invoke(baseRequest);
  assert.equal(disabled.statusCode, 400);
  assert.equal(disabled.body.message, 'This Core savings product is not currently available.');

  process.env.CORE_SAVINGS_ENABLED = 'true';
  const unverified = await invoke({
    ...baseRequest,
    user: { id: 'user-1', isKycVerified: false },
  });
  assert.equal(unverified.statusCode, 403);
  assert.match(unverified.body.message, /identity verification/);
});

test('new users are not marked KYC verified by default', () => {
  const user = new User({
    name: 'Test Customer',
    email: 'customer@example.test',
    goal: User.GOALS[0],
    product: User.PRODUCTS[0],
    passwordHash: 'not-used-in-this-test',
  });
  assert.equal(user.isKycVerified, false);
});

test('a retried early liquidation returns the original amounts without moving funds again', async () => {
  const originalFindOne = LedgerEntry.findOne;
  const originalFind = LedgerEntry.find;
  const key = '123e4567-e89b-42d3-a456-426614174000';
  LedgerEntry.findOne = () => ({ userId: 'user-1' });
  LedgerEntry.find = (filter) => {
    assert.equal(filter.idempotencyKey, `core-liquidate:plan-1:${key}`);
    return {
      select() {
        return this;
      },
      lean: async () => [
        { accountCode: 'USER_WALLET', amountKobo: 9_650_000, entryType: 'CREDIT' },
        { accountCode: 'EARLY_EXIT_PENALTY_REVENUE', amountKobo: 350_000, entryType: 'CREDIT' },
        { accountCode: 'FORFEITED_YIELD_REVENUE', amountKobo: 98_630, entryType: 'CREDIT' },
      ],
    };
  };

  let responseBody;
  try {
    await liquidateCoreSavingsPlan(
      {
        params: { planId: 'plan-1' },
        user: { id: 'user-1' },
        body: { password: 'unused-for-an-already-completed-retry', idempotencyKey: key },
      },
      { json: (body) => { responseBody = body; return body; } },
      (error) => { throw error; },
    );
  } finally {
    LedgerEntry.findOne = originalFindOne;
    LedgerEntry.find = originalFind;
  }

  assert.equal(responseBody.returnedToWallet, 96_500);
  assert.equal(responseBody.penalty, 3_500);
  assert.equal(responseBody.forfeitedYield, 986.3);
  assert.equal(responseBody.reused, true);
});

test('Core savings API requires an authenticated session', async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/core-savings`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, 'Please log in to continue.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
