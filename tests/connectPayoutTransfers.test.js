const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const mongoose = require('mongoose');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectPayout = require('../models/ConnectPayout');
const LinkedBankAccount = require('../models/LinkedBankAccount');
const Notification = require('../models/Notification');
const {
  handleConnectPayoutWebhook,
  providerStatusToPayoutStatus,
  updateConnectPayoutTransfer,
} = require('../services/connectPayoutTransfers');

const originalPaystackKey = process.env.PAYSTACK_SECRET_KEY;
process.env.PAYSTACK_SECRET_KEY = 'sk_test_connect-payout-tests';

after(() => {
  if (originalPaystackKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalPaystackKey;
});

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

function stubSession() {
  return {
    async withTransaction(callback) {
      await callback();
    },
    async endSession() {},
  };
}

test('Paystack transfer statuses map to reserved or terminal Connect payout states', () => {
  assert.equal(providerStatusToPayoutStatus('otp'), 'requires_otp');
  assert.equal(providerStatusToPayoutStatus('pending'), 'processing');
  assert.equal(providerStatusToPayoutStatus('success'), 'paid');
  assert.equal(providerStatusToPayoutStatus('failed'), 'failed');
  assert.equal(providerStatusToPayoutStatus('reversed'), 'reversed');
  assert.equal(providerStatusToPayoutStatus('unknown'), null);
});

test('a successful Paystack webhook marks a Connect payout paid and notifies the partner once', async () => {
  const methods = [
    [mongoose, 'startSession'],
    [ConnectPayout, 'findOneAndUpdate'],
    [ConnectAdminAudit, 'create'],
    [Notification, 'create'],
  ];
  const originals = methods.map(([target, key]) => target[key]);
  const audits = [];
  const notifications = [];
  let filter;
  let update;
  mongoose.startSession = async () => stubSession();
  ConnectPayout.findOneAndUpdate = async (query, changes) => {
    filter = query;
    update = changes;
    return {
      _id: 'payout-1',
      userId: 'partner-1',
      amountKobo: 250000,
    };
  };
  ConnectAdminAudit.create = async (records) => audits.push(...records);
  Notification.create = async (records) => notifications.push(...records);
  try {
    const result = await handleConnectPayoutWebhook({
      event: 'transfer.success',
      data: { reference: 'KALMA_CONNECT_ref-1' },
    });
    assert.equal(result.userId, 'partner-1');
    assert.deepEqual(filter, {
      transferReference: 'KALMA_CONNECT_ref-1',
      status: { $in: ['processing', 'requires_otp'] },
    });
    assert.equal(update.$set.status, 'paid');
    assert.equal(update.$set.paymentReference, 'KALMA_CONNECT_ref-1');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'payout_transfer_succeeded');
    assert.equal(audits[0].actorId, null);
    assert.match(notifications[0].message, /confirmed/i);
  } finally {
    methods.forEach(([target, key], index) => { target[key] = originals[index]; });
  }
});

test('Paystack failures release reserved Connect payouts and duplicate webhooks are harmless', async () => {
  const methods = [
    [mongoose, 'startSession'],
    [ConnectPayout, 'findOneAndUpdate'],
    [ConnectAdminAudit, 'create'],
    [Notification, 'create'],
  ];
  const originals = methods.map(([target, key]) => target[key]);
  let audits = 0;
  let notifications = 0;
  let filter;
  mongoose.startSession = async () => stubSession();
  ConnectPayout.findOneAndUpdate = async (query) => {
    filter = query;
    return null;
  };
  ConnectAdminAudit.create = async () => { audits += 1; };
  Notification.create = async () => { notifications += 1; };
  try {
    const result = await handleConnectPayoutWebhook({
      event: 'transfer.failed',
      data: { reference: 'KALMA_CONNECT_ref-2', failure_reason: 'Insufficient balance' },
    });
    assert.equal(result, null);
    assert.deepEqual(filter.status, { $in: ['processing', 'requires_otp'] });
    assert.equal(audits, 0);
    assert.equal(notifications, 0);
  } finally {
    methods.forEach(([target, key], index) => { target[key] = originals[index]; });
  }
});

test('a transfer reversal can reverse a previously paid Connect payout', async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindOneAndUpdate = ConnectPayout.findOneAndUpdate;
  const originalAuditCreate = ConnectAdminAudit.create;
  const originalNotificationCreate = Notification.create;
  let filter;
  mongoose.startSession = async () => stubSession();
  ConnectPayout.findOneAndUpdate = async (query, changes) => {
    filter = query;
    assert.equal(changes.$set.status, 'reversed');
    assert.equal(changes.$set.transferError, 'Transfer reversed by Paystack.');
    assert.equal(changes.$unset, undefined);
    return { _id: 'payout-3', userId: 'partner-3', amountKobo: 100000 };
  };
  ConnectAdminAudit.create = async () => {};
  Notification.create = async () => {};
  try {
    await updateConnectPayoutTransfer('KALMA_CONNECT_ref-3', 'reversed', 'Transfer reversed by Paystack.');
    assert.deepEqual(filter.status, { $in: ['processing', 'requires_otp', 'paid'] });
  } finally {
    mongoose.startSession = originalStartSession;
    ConnectPayout.findOneAndUpdate = originalFindOneAndUpdate;
    ConnectAdminAudit.create = originalAuditCreate;
    Notification.create = originalNotificationCreate;
  }
});

test('admin approval creates one Paystack transfer and reserves the payout before calling the provider', async () => {
  const connectController = require('../controllers/connectController');
  const originalFetch = global.fetch;
  const originals = [
    [mongoose, 'startSession'],
    [ConnectPayout, 'findById'],
    [ConnectPayout, 'findOneAndUpdate'],
    [ConnectPayout, 'updateOne'],
    [LinkedBankAccount, 'findOne'],
    [ConnectAdminAudit, 'create'],
    [Notification, 'create'],
  ];
  const saved = originals.map(([target, key]) => target[key]);
  const payout = {
    _id: 'payout-4',
    userId: 'partner-4',
    partnerId: 'partner-profile-4',
    linkedBankId: 'bank-4',
    amountKobo: 125000,
    status: 'pending',
  };
  let transferRequest;
  mongoose.startSession = async () => stubSession();
  ConnectPayout.findById = () => ({
    select() { return this; },
    lean: async () => ({ ...payout }),
    then(resolve, reject) { return Promise.resolve({ ...payout }).then(resolve, reject); },
  });
  ConnectPayout.findOneAndUpdate = async (_filter, changes) => {
    Object.assign(payout, changes.$set);
    return { ...payout };
  };
  ConnectPayout.updateOne = async (_filter, changes) => {
    Object.assign(payout, changes.$set);
    return { matchedCount: 1 };
  };
  LinkedBankAccount.findOne = () => ({
    select: async () => ({ recipientCode: 'RCP_connect-recipient' }),
  });
  ConnectAdminAudit.create = async () => {};
  Notification.create = async () => {};
  global.fetch = async (url, options) => {
    transferRequest = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      status: true,
      data: { transfer_code: 'TRF_connect-4', status: 'pending' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const response = makeResponse();
  try {
    await connectController.reviewPayout({
      params: { payoutId: 'payout-4' },
      body: { status: 'approved', reviewNote: '' },
      user: { _id: 'admin-1' },
    }, response, (error) => { throw error; });
  } finally {
    global.fetch = originalFetch;
    originals.forEach(([target, key], index) => { target[key] = saved[index]; });
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.payout.status, 'processing');
  assert.equal(payout.status, 'processing');
  assert.equal(transferRequest.url, 'https://api.paystack.co/transfer');
  assert.equal(transferRequest.body.source, 'balance');
  assert.equal(transferRequest.body.amount, 125000);
  assert.equal(transferRequest.body.recipient, 'RCP_connect-recipient');
  assert.match(transferRequest.body.reference, /^KALMA_CONNECT_/);
});

test('an OTP-required Paystack transfer remains reserved for admin confirmation', async () => {
  const connectController = require('../controllers/connectController');
  const originalFetch = global.fetch;
  const originals = [
    [mongoose, 'startSession'],
    [ConnectPayout, 'findById'],
    [ConnectPayout, 'findOneAndUpdate'],
    [ConnectPayout, 'updateOne'],
    [LinkedBankAccount, 'findOne'],
    [ConnectAdminAudit, 'create'],
    [Notification, 'create'],
  ];
  const saved = originals.map(([target, key]) => target[key]);
  const payout = {
    _id: 'payout-5',
    userId: 'partner-5',
    linkedBankId: 'bank-5',
    amountKobo: 100000,
    status: 'pending',
  };
  mongoose.startSession = async () => stubSession();
  ConnectPayout.findById = () => ({
    select() { return this; },
    lean: async () => ({ ...payout }),
    then(resolve, reject) { return Promise.resolve({ ...payout }).then(resolve, reject); },
  });
  ConnectPayout.findOneAndUpdate = async (_filter, changes) => {
    Object.assign(payout, changes.$set);
    return { ...payout };
  };
  ConnectPayout.updateOne = async (_filter, changes) => {
    Object.assign(payout, changes.$set);
    return { matchedCount: 1 };
  };
  LinkedBankAccount.findOne = () => ({
    select: async () => ({ recipientCode: 'RCP_connect-recipient' }),
  });
  ConnectAdminAudit.create = async () => {};
  Notification.create = async () => {};
  global.fetch = async () => new Response(JSON.stringify({
    status: true,
    data: { transfer_code: 'TRF_connect-5', status: 'otp' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const response = makeResponse();
  try {
    await connectController.reviewPayout({
      params: { payoutId: 'payout-5' },
      body: { status: 'approved' },
      user: { _id: 'admin-1' },
    }, response, (error) => { throw error; });
  } finally {
    global.fetch = originalFetch;
    originals.forEach(([target, key], index) => { target[key] = saved[index]; });
  }

  assert.equal(response.body.payout.status, 'requires_otp');
  assert.equal(payout.status, 'requires_otp');
  assert.equal(payout.transferCode, 'TRF_connect-5');
});

test('a Paystack OTP is sent to the provider and never persisted on the payout', async () => {
  const connectController = require('../controllers/connectController');
  const originalFetch = global.fetch;
  const originals = [
    [ConnectPayout, 'findById'],
    [ConnectPayout, 'updateOne'],
    [ConnectAdminAudit, 'create'],
  ];
  const saved = originals.map(([target, key]) => target[key]);
  const payout = {
    _id: 'payout-6',
    status: 'requires_otp',
    transferCode: 'TRF_connect-6',
    transferReference: 'KALMA_CONNECT_ref-6',
  };
  let requestBody;
  ConnectPayout.findById = () => ({
    select() { return this; },
    lean: async () => ({ ...payout }),
    then(resolve, reject) { return Promise.resolve({ ...payout }).then(resolve, reject); },
  });
  ConnectPayout.updateOne = async (_filter, changes) => {
    Object.assign(payout, changes.$set);
    return { matchedCount: 1 };
  };
  ConnectAdminAudit.create = async () => {};
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      status: true,
      data: { status: 'pending' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const response = makeResponse();
  try {
    await connectController.submitPayoutTransferOtp({
      params: { payoutId: 'payout-6' },
      body: { otp: '123456' },
      user: { _id: 'admin-1' },
    }, response, (error) => { throw error; });
  } finally {
    global.fetch = originalFetch;
    originals.forEach(([target, key], index) => { target[key] = saved[index]; });
  }

  assert.equal(response.statusCode, 200);
  assert.deepEqual(requestBody, { transfer_code: 'TRF_connect-6', otp: '123456' });
  assert.equal(payout.status, 'processing');
  assert.equal(Object.hasOwn(payout, 'otp'), false);
});

test('processing and pre-automation approved payouts cannot trigger a duplicate Paystack transfer', async () => {
  const connectController = require('../controllers/connectController');
  const originalFindById = ConnectPayout.findById;
  const originalFetch = global.fetch;
  let transferCalls = 0;
  global.fetch = async () => {
    transferCalls += 1;
    throw new Error('A duplicate transfer must not be sent.');
  };
  try {
    for (const payout of [
      { _id: 'payout-processing', status: 'processing', transferReference: 'KALMA_CONNECT_existing' },
      { _id: 'payout-legacy', status: 'approved' },
    ]) {
      ConnectPayout.findById = async () => payout;
      const response = makeResponse();
      await connectController.reviewPayout({
        params: { payoutId: payout._id },
        body: { status: 'approved' },
        user: { _id: 'admin-1' },
      }, response, (error) => { throw error; });
      assert.equal(response.statusCode, 409);
    }
  } finally {
    global.fetch = originalFetch;
    ConnectPayout.findById = originalFindById;
  }

  assert.equal(transferCalls, 0);
});

test('legacy approved payouts can be recorded as paid only with an external payment reference', async () => {
  const connectController = require('../controllers/connectController');
  const originals = [
    [mongoose, 'startSession'],
    [ConnectPayout, 'findById'],
    [ConnectPayout, 'findOneAndUpdate'],
    [ConnectAdminAudit, 'create'],
    [Notification, 'create'],
  ];
  const saved = originals.map(([target, key]) => target[key]);
  const payout = {
    _id: 'payout-legacy-paid',
    userId: 'partner-legacy',
    amountKobo: 100000,
    status: 'approved',
  };
  mongoose.startSession = async () => stubSession();
  ConnectPayout.findById = async () => ({ ...payout });
  ConnectPayout.findOneAndUpdate = async (_filter, changes) => {
    Object.assign(payout, changes.$set);
    return { ...payout, toObject: () => ({ ...payout }) };
  };
  ConnectAdminAudit.create = async () => {};
  Notification.create = async () => {};
  const response = makeResponse();
  try {
    await connectController.reviewPayout({
      params: { payoutId: payout._id },
      body: { status: 'paid', paymentReference: 'bank-transfer-123' },
      user: { _id: 'admin-1' },
    }, response, (error) => { throw error; });
  } finally {
    originals.forEach(([target, key], index) => { target[key] = saved[index]; });
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.payout.status, 'paid');
  assert.equal(payout.paymentReference, 'bank-transfer-123');
});

test('Paystack reconciliation releases a transfer reference that the provider confirms does not exist', async () => {
  const connectController = require('../controllers/connectController');
  const originalFetch = global.fetch;
  const originals = [
    [mongoose, 'startSession'],
    [ConnectPayout, 'findById'],
    [ConnectPayout, 'findOneAndUpdate'],
    [ConnectAdminAudit, 'create'],
    [Notification, 'create'],
  ];
  const saved = originals.map(([target, key]) => target[key]);
  const payout = {
    _id: 'payout-8',
    userId: 'partner-8',
    amountKobo: 100000,
    status: 'processing',
    transferReference: 'KALMA_CONNECT_missing',
  };
  let verifiedUrl;
  mongoose.startSession = async () => stubSession();
  ConnectPayout.findById = () => ({
    select() { return this; },
    lean: async () => ({ ...payout }),
    then(resolve, reject) { return Promise.resolve({ ...payout }).then(resolve, reject); },
  });
  ConnectPayout.findOneAndUpdate = async (_filter, changes) => {
    Object.assign(payout, changes.$set);
    return { ...payout };
  };
  ConnectAdminAudit.create = async () => {};
  Notification.create = async () => {};
  global.fetch = async (url) => {
    verifiedUrl = url;
    return new Response(JSON.stringify({
      status: false,
      message: 'Transfer not found',
    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  const response = makeResponse();
  try {
    await connectController.reconcilePayoutTransfer({
      params: { payoutId: 'payout-8' },
    }, response, (error) => { throw error; });
  } finally {
    global.fetch = originalFetch;
    originals.forEach(([target, key], index) => { target[key] = saved[index]; });
  }

  assert.equal(verifiedUrl, 'https://api.paystack.co/transfer/verify/KALMA_CONNECT_missing');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.payout.status, 'failed');
  assert.equal(payout.status, 'failed');
});
