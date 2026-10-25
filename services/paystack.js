const crypto = require('node:crypto');

const PAYSTACK_API = 'https://api.paystack.co';

function getPaystackSecret() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    const error = new Error('Paystack is not configured.');
    error.status = 503;
    throw error;
  }
  return process.env.PAYSTACK_SECRET_KEY;
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
    const error = new Error(result.message || 'Paystack could not complete the request.');
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }

  return result.data;
}

function verifyWebhookSignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody) || !process.env.PAYSTACK_SECRET_KEY) {
    return false;
  }
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = { paystackRequest, verifyWebhookSignature };
