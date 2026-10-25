const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, test } = require('node:test');
const { normalizeAccountName } = require('../controllers/walletController');
const { verifyWebhookSignature } = require('../services/paystack');

const previousPaystackKey = process.env.PAYSTACK_SECRET_KEY;
process.env.PAYSTACK_SECRET_KEY = 'test-secret-for-webhook-tests';

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

test('wallet APIs require an authenticated session', async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/wallet`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, 'Please log in to continue.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
