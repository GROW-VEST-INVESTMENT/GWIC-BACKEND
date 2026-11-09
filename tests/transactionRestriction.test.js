const assert = require('node:assert/strict');
const { test } = require('node:test');
const requireTransactionAccess = require('../middleware/requireTransactionAccess');

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

test('transaction-restricted users are blocked from guarded actions', () => {
  const response = makeResponse();
  let passed = false;
  requireTransactionAccess({ user: { transactionRestricted: true } }, response, () => { passed = true; });

  assert.equal(passed, false);
  assert.equal(response.statusCode, 423);
  assert.match(response.body.message, /temporarily restricted/i);
});

test('users without a transaction restriction can continue guarded actions', () => {
  const response = makeResponse();
  let passed = false;
  requireTransactionAccess({ user: { transactionRestricted: false } }, response, () => { passed = true; });

  assert.equal(passed, true);
  assert.equal(response.statusCode, 200);
});
