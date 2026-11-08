const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const requireAdmin = require('../middleware/requireAdmin');
const requireAdminOrigin = require('../middleware/requireAdminOrigin');
const InvestmentPlan = require('../models/InvestmentPlan');
const SavingsGoal = require('../models/SavingsGoal');
const SupportRequest = require('../models/SupportRequest');
const User = require('../models/User');
const VerificationRequest = require('../models/VerificationRequest');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const {
  getUserDetail,
  reviewVerification,
  updateSupportRequest,
} = require('../controllers/adminController');

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

function makeQuery(result, onSelect = () => {}) {
  return {
    select(fields) {
      onSelect(fields);
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean() {
      return Promise.resolve(result);
    },
  };
}

test('users default to regular-user role and active status', () => {
  const user = new User({
    name: 'Ada Example',
    email: 'ada@example.com',
    goal: 'Emergency savings',
    product: 'undecided',
    passwordHash: 'not-saved',
  });

  assert.equal(user.role, 'user');
  assert.equal(user.status, 'active');
});

test('admin middleware allows staff roles and rejects user accounts', () => {
  for (const role of ['admin', 'super_admin']) {
    let passed = false;
    requireAdmin({ user: { role } }, makeResponse(), () => { passed = true; });
    assert.equal(passed, true);
  }

  const response = makeResponse();
  let passed = false;
  requireAdmin({ user: { role: 'user' } }, response, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(response.statusCode, 403);
});

test('user detail returns read-only account, wallet, and activity data without private fields', async () => {
  const userId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
  const now = new Date('2026-11-08T12:00:00.000Z');
  const selectors = {};
  const originals = {
    findById: User.findById,
    walletFindOne: Wallet.findOne,
    transactionsFind: WalletTransaction.find,
    verificationFind: VerificationRequest.find,
    supportFind: SupportRequest.find,
    investmentFind: InvestmentPlan.find,
    savingsGoalFind: SavingsGoal.find,
  };

  User.findById = (id) => {
    assert.equal(id, userId.toString());
    return makeQuery({
      _id: userId,
      name: 'Ada Example',
      email: 'ada@example.com',
      phone: '+2348000000000',
      role: 'user',
      status: 'active',
      isKycVerified: false,
      product: 'core-lock',
      goal: 'Emergency savings',
      createdAt: now,
      passwordHash: 'must-not-be-returned',
      sessionVersion: 4,
    }, (fields) => { selectors.user = fields; });
  };
  Wallet.findOne = (filter) => {
    assert.equal(filter.userId, userId);
    return makeQuery({ balanceKobo: 1250000, updatedAt: now });
  };
  WalletTransaction.find = (filter) => {
    assert.equal(filter.userId, userId);
    return makeQuery([{ reference: 'TX-1', type: 'deposit', amountKobo: 500000, status: 'successful', createdAt: now }], (fields) => {
      selectors.transaction = fields;
    });
  };
  VerificationRequest.find = (filter) => {
    assert.equal(filter.userId, userId);
    return makeQuery([{ status: 'pending', createdAt: now, legalName: 'Private Legal Name', dateOfBirth: now }], (fields) => {
      selectors.verification = fields;
    });
  };
  SupportRequest.find = (filter) => {
    assert.equal(filter.userId, userId);
    return makeQuery([{ reference: 'SP-1', category: 'account', subject: 'Profile question', status: 'open', createdAt: now, updatedAt: now, message: 'Private message', staffNote: 'Private staff note' }], (fields) => {
      selectors.support = fields;
    });
  };
  InvestmentPlan.find = (filter) => {
    assert.equal(filter.userId, userId);
    return makeQuery([{ productType: 'CORE_LOCK', principalKobo: 1000000, accruedYieldKobo: 15000, status: 'ACTIVE', startDate: now, maturityDate: now }]);
  };
  SavingsGoal.find = (filter) => {
    assert.equal(filter.userId, userId);
    return makeQuery([{ name: 'Holiday', targetAmount: 100000, savedAmount: 20000, targetDate: now }]);
  };

  try {
    const response = makeResponse();
    await getUserDetail(
      { params: { userId: userId.toString() } },
      response,
      (error) => { throw error; },
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.user, {
      id: userId.toString(),
      name: 'Ada Example',
      email: 'ada@example.com',
      phone: '+2348000000000',
      role: 'user',
      status: 'active',
      kycVerified: false,
      product: 'core-lock',
      goal: 'Emergency savings',
      createdAt: now,
    });
    assert.deepEqual(response.body.wallet, { balance: 12500, updatedAt: now });
    assert.deepEqual(response.body.transactions, [{
      reference: 'TX-1',
      type: 'deposit',
      amount: 5000,
      status: 'successful',
      createdAt: now,
    }]);
    assert.deepEqual(response.body.verificationRequests, [{ status: 'pending', createdAt: now, reviewedAt: undefined }]);
    assert.deepEqual(response.body.supportRequests, [{
      reference: 'SP-1',
      category: 'account',
      subject: 'Profile question',
      status: 'open',
      createdAt: now,
      updatedAt: now,
      resolvedAt: undefined,
    }]);
    assert.equal(response.body.investmentPlans[0].principal, 10000);
    assert.deepEqual(response.body.savingsGoals, [{ name: 'Holiday', targetAmount: 100000, targetDate: now, savedAmount: 20000 }]);
    assert.doesNotMatch(selectors.user, /password|sessionVersion/i);
    assert.doesNotMatch(selectors.verification, /dateOfBirth|legalName/i);
    assert.doesNotMatch(selectors.support, /message|staffNote/i);
    assert.equal(JSON.stringify(response.body).includes('must-not-be-returned'), false);
    assert.equal(JSON.stringify(response.body).includes('Private staff note'), false);
    assert.equal(JSON.stringify(response.body).includes('Private Legal Name'), false);
  } finally {
    User.findById = originals.findById;
    Wallet.findOne = originals.walletFindOne;
    WalletTransaction.find = originals.transactionsFind;
    VerificationRequest.find = originals.verificationFind;
    SupportRequest.find = originals.supportFind;
    InvestmentPlan.find = originals.investmentFind;
    SavingsGoal.find = originals.savingsGoalFind;
  }
});

test('user detail validates IDs and returns 404 for missing users', async () => {
  const response = makeResponse();
  await getUserDetail({ params: { userId: 'not-an-id' } }, response, (error) => { throw error; });
  assert.equal(response.statusCode, 400);

  const originalFindById = User.findById;
  User.findById = () => makeQuery(null);
  try {
    const missingResponse = makeResponse();
    await getUserDetail(
      { params: { userId: '507f1f77bcf86cd799439011' } },
      missingResponse,
      (error) => { throw error; },
    );
    assert.equal(missingResponse.statusCode, 404);
  } finally {
    User.findById = originalFindById;
  }
});

test('admin write origin requires an approved origin', () => {
  const originalEnvironment = {
    adminUrl: process.env.ADMIN_URL,
    corsOrigins: process.env.CORS_ORIGINS,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.NODE_ENV = 'production';
  process.env.ADMIN_URL = 'https://admin.example.com';
  delete process.env.CORS_ORIGINS;
  try {
    let passed = false;
    requireAdminOrigin({ get: () => 'https://admin.example.com' }, makeResponse(), () => { passed = true; });
    assert.equal(passed, true);

    passed = false;
    requireAdminOrigin({ get: () => 'https://gwic-audit.vercel.app' }, makeResponse(), () => { passed = true; });
    assert.equal(passed, true);

    const response = makeResponse();
    requireAdminOrigin({ get: () => 'https://untrusted.example.com' }, response, () => {});
    assert.equal(response.statusCode, 403);
  } finally {
    if (originalEnvironment.adminUrl === undefined) delete process.env.ADMIN_URL;
    else process.env.ADMIN_URL = originalEnvironment.adminUrl;
    if (originalEnvironment.corsOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = originalEnvironment.corsOrigins;
    if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment.nodeEnv;
  }
});

test('KYC decisions require evidence confirmation and a meaningful reviewer note', async () => {
  for (const body of [
    { decision: 'verified', note: 'Documents checked', evidenceReviewed: false },
    { decision: 'rejected', note: 'No', evidenceReviewed: true },
    { decision: 'pending', note: 'Documents checked', evidenceReviewed: true },
  ]) {
    const response = makeResponse();
    await reviewVerification(
      { body, params: { requestId: '507f1f77bcf86cd799439011' } },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 400);
  }
});

test('support status changes require a valid status and staff note', async () => {
  for (const body of [
    { status: 'closed', note: 'Handled this request' },
    { status: 'resolved', note: '' },
  ]) {
    const response = makeResponse();
    await updateSupportRequest(
      { body, params: { requestId: '507f1f77bcf86cd799439011' } },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 400);
  }
});
