const assert = require('node:assert/strict');
const { test } = require('node:test');
const requireConnectAdmin = require('../middleware/requireConnectAdmin');
const requireConnectOrigin = require('../middleware/requireConnectOrigin');

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

test('Connect management access requires a provisioned staff or admin role', () => {
  const response = makeResponse();
  let continued = false;
  requireConnectAdmin({ user: { role: 'customer' } }, response, () => { continued = true; });
  assert.equal(response.statusCode, 403);
  assert.equal(continued, false);

  requireConnectAdmin({ user: { role: 'staff' } }, response, () => { continued = true; });
  assert.equal(continued, true);
});

test('Connect write routes allow only configured browser origins', () => {
  const checkOrigin = requireConnectOrigin(['https://connect.example.com']);
  const response = makeResponse();
  let continued = false;

  checkOrigin({ get: () => 'https://untrusted.example' }, response, () => { continued = true; });
  assert.equal(response.statusCode, 403);
  assert.equal(continued, false);

  checkOrigin({ get: () => 'https://connect.example.com' }, response, () => { continued = true; });
  assert.equal(continued, true);
});

test('Connect APIs require an authenticated account and signup rejects malformed partner codes', async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const sessionResponse = await fetch(`${baseUrl}/api/connect/me`);
    assert.equal(sessionResponse.status, 401);
    const adminResponse = await fetch(`${baseUrl}/api/admin/connect/summary`);
    assert.equal(adminResponse.status, 401);
    const notificationsResponse = await fetch(`${baseUrl}/api/notifications`);
    assert.equal(notificationsResponse.status, 401);
    const registrationResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Okafor',
        email: 'ada@example.com',
        password: 'secure-password',
        goal: 'I’m still exploring',
        product: 'undecided',
        promoCode: 'not a code',
      }),
    });
    assert.equal(registrationResponse.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
