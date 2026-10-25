const crypto = require('node:crypto');

const PAYSTACK_API = 'https://api.paystack.co';

function getPaystackSecret() {
  const secret = process.env.PAYSTACK_SECRET_KEY
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
  if (!secret) {
    const error = new Error('Paystack is not configured.');
    error.status = 503;
    throw error;
  }
  if (!/^sk_(test|live)_/.test(secret)) {
    const error = new Error('PAYSTACK_SECRET_KEY must be a Paystack secret key beginning with sk_test_ or sk_live_.');
    error.status = 503;
    throw error;
  }
  return secret;
}

async function paystackRequest(path, options = {}) {
  const response = await fetch(`${PAYSTACK_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getPaystackSecret()}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Paystack returned an invalid response.');
  }

  if (!response.ok || result.status !== true) {
    if (response.status === 401 || response.status === 403) {
      const error = new Error(
        'Paystack rejected the secret key. Check that PAYSTACK_SECRET_KEY in the Render backend is the active secret key from the same Paystack account and environment, then redeploy.',
      );
      error.status = 503;
      error.code = 'PAYSTACK_AUTH';
      throw error;
    }
    const error = new Error(result.message || 'Paystack could not complete the request.');
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }

  return result.data;
}

function verifyWebhookSignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) {
    return false;
  }
  let expected;
  try {
    expected = crypto.createHmac('sha512', getPaystackSecret()).update(rawBody).digest();
  } catch {
    return false;
  }
  let supplied;
  try {
    supplied = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = { getPaystackSecret, paystackRequest, verifyWebhookSignature };
