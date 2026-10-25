const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, test } = require('node:test');
const { getWalletTransactions, normalizeAccountName } = require('../controllers/walletController');
const { getPaystackSecret, paystackRequest, verifyWebhookSignature } = require('../services/paystack');
const WalletTransaction = require('../models/WalletTransaction');

const previousPaystackKey = process.env.PAYSTACK_SECRET_KEY;
process.env.PAYSTACK_SECRET_KEY = 'sk_test_webhook-test-secret';

after(() => {
  if (previousPaystackKey === undefined) {
    delete process.env.PAYSTACK_SECRET_KEY;
  } else {
    process.env.PAYSTACK_SECRET_KEY = previousPaystackKey;
  }
});

test('bank account matching ignores case, whitespace and punctuation only', () => {
  assert.equal(normalizeAccountName('Ada O’Connor'), normalizeAccountName('ADA O Connor'));
  assert.notEqual(normalizeAccountName('Ada Smith'), normalizeAccountName('Ada Jones'));
});

test('Paystack webhook signatures must match the raw request body', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
  const signature = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(body)
    .digest('hex');

  assert.equal(verifyWebhookSignature(body, signature), true);
  assert.equal(verifyWebhookSignature(body, `${signature.slice(0, -2)}00`), false);
  assert.equal(verifyWebhookSignature(Buffer.from('different body'), signature), false);
});

test('Paystack secret configuration trims accidental whitespace and wrapping quotes', () => {
  const original = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = '  "sk_test_example-secret"  ';
  assert.equal(getPaystackSecret(), 'sk_test_example-secret');
  process.env.PAYSTACK_SECRET_KEY = original;
});

test('Paystack credential rejection returns actionable guidance without key material', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_example-secret';
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer sk_test_example-secret');
    return new Response(JSON.stringify({ status: false, message: 'Invalid key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await assert.rejects(
      paystackRequest('/transaction/initialize'),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'PAYSTACK_AUTH');
        assert.match(error.message, /PAYSTACK_SECRET_KEY in the Render backend/);
        assert.equal(error.message.includes('example-secret'), false);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalKey;
  }
});

test('wallet APIs require an authenticated session', async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  try {
    const address = server.address();
    for (const path of ['/api/wallet', '/api/wallet/transactions?page=1&type=all']) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).message, 'Please log in to continue.');
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('wallet activity endpoint returns a stable paginated response', async () => {
  const originalFind = WalletTransaction.find;
  const originalCountDocuments = WalletTransaction.countDocuments;
  let skipValue;
  const sample = {
    _id: 'transaction-21',
    reference: 'GWIC_DEP_test',
    type: 'deposit',
    amountKobo: 25000,
    status: 'successful',
    bankName: null,
    accountLast4: null,
    createdAt: new Date('2026-10-01T12:00:00Z'),
  };
  WalletTransaction.find = (filter) => {
    assert.deepEqual(filter, { userId: 'user-1' });
    return {
      sort() {
        return this;
      },
      skip(value) {
        skipValue = value;
        return this;
      },
      limit(value) {
        assert.equal(value, 20);
        return this;
      },
      select() {
        return this;
      },
      lean: async () => [sample],
    };
  };
  WalletTransaction.countDocuments = async () => 45;
  let responseBody;
  try {
    await getWalletTransactions(
      { user: { id: 'user-1' }, query: { page: '2', type: 'all' } },
      { json: (body) => { responseBody = body; return body; } },
      (error) => { throw error; },
    );
  } finally {
    WalletTransaction.find = originalFind;
    WalletTransaction.countDocuments = originalCountDocuments;
  }
  assert.equal(skipValue, 20);
  assert.equal(responseBody.pageSize, 20);
  assert.equal(responseBody.total, 45);
  assert.equal(responseBody.hasMore, true);
  assert.equal(responseBody.transactions[0].amount, 250);
  assert.equal(responseBody.transactions[0].reference, 'GWIC_DEP_test');
});
