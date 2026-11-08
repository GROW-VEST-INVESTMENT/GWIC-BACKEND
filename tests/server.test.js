const assert = require('node:assert/strict');
const { after, test } = require('node:test');

const adminOrigin = 'https://admin.example.com';
const previousAdminUrl = process.env.ADMIN_URL;
process.env.ADMIN_URL = adminOrigin;

const { app } = require('../server');
if (previousAdminUrl === undefined) delete process.env.ADMIN_URL;
else process.env.ADMIN_URL = previousAdminUrl;

const server = app.listen(0, '127.0.0.1');
const listening = new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});

after(async () => {
  await listening;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('credentialed CORS accepts the configured admin origin', async () => {
  await listening;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
    headers: { Origin: adminOrigin },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), adminOrigin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('credentialed CORS accepts the public Vercel admin origin', async () => {
  await listening;
  const publicAdminOrigin = 'https://gwic-audit.vercel.app';
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
    headers: { Origin: publicAdminOrigin },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), publicAdminOrigin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('credentialed CORS rejects unconfigured admin origins', async () => {
  await listening;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
    headers: { Origin: 'https://untrusted.example.com' },
  });

  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('admin operations require a signed-in session', async () => {
  await listening;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/operations/wallets`, {
    headers: { Origin: adminOrigin },
  });

  assert.equal(response.status, 401);
});
