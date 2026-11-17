const assert = require('node:assert/strict');
const { test } = require('node:test');
const requireConnectAdmin = require('../middleware/requireConnectAdmin');
const requireConnectOrigin = require('../middleware/requireConnectOrigin');
const ConnectOpportunity = require('../models/ConnectOpportunity');
const { reserveOpportunityCapacity } = require('../controllers/connectOpportunityController');
const {
  applicationDocumentDownloadUrl,
  validateApplicationDocuments,
} = require('../services/connectApplicationDocuments');
const { createApplication } = require('../controllers/connectController');
const ConnectApplication = require('../models/ConnectApplication');
const { getMyApplicationDocument } = require('../controllers/connectOpportunityController');

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
    const opportunitiesResponse = await fetch(`${baseUrl}/api/connect/opportunities`);
    assert.equal(opportunitiesResponse.status, 401);
    const publishResponse = await fetch(`${baseUrl}/api/admin/connect/opportunities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untrusted post' }),
    });
    assert.equal(publishResponse.status, 401);
    const documentResponse = await fetch(`${baseUrl}/api/connect/applications/507f1f77bcf86cd799439011/documents/507f1f77bcf86cd799439012`);
    assert.equal(documentResponse.status, 401);
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

test('application documents accept only allowlisted files with matching content and stay under the combined limit', () => {
  const validPdf = {
    originalname: 'cv.pdf',
    mimetype: 'application/pdf',
    size: 5,
    buffer: Buffer.from('%PDF-'),
  };
  assert.doesNotThrow(() => validateApplicationDocuments([validPdf]));
  assert.throws(
    () => validateApplicationDocuments([{ ...validPdf, buffer: Buffer.from('not a PDF') }]),
    { status: 415 },
  );
  assert.throws(
    () => validateApplicationDocuments(Array(6).fill(validPdf)),
    { status: 415 },
  );
  assert.throws(
    () => validateApplicationDocuments([
      { ...validPdf, size: 12 * 1024 * 1024 },
      { ...validPdf, size: 9 * 1024 * 1024 },
    ]),
    { status: 413 },
  );
});

test('application document links use authenticated Cloudinary downloads with a short expiry', () => {
  const variables = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = variables.map((name) => process.env[name]);
  process.env.CLOUDINARY_CLOUD_NAME = 'connect-test';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';
  try {
    const url = new URL(applicationDocumentDownloadUrl({
      publicId: 'private/application/cv.pdf',
      format: 'pdf',
    }));
    const expiresAt = Number(url.searchParams.get('expires_at'));
    const now = Math.floor(Date.now() / 1000);
    assert.equal(url.searchParams.get('type'), 'authenticated');
    assert.equal(url.searchParams.get('attachment'), 'true');
    assert.ok(expiresAt > now && expiresAt <= now + 300);
  } finally {
    variables.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test('role applications must be tied to a published opportunity instead of bypassing capacity controls', async () => {
  const response = makeResponse();
  await createApplication({
    user: { _id: '507f1f77bcf86cd799439011' },
    body: {
      type: 'applicant',
      roleInterest: 'Customer Care Assistant',
      motivation: 'I am motivated to contribute to the Kalma team and support its customers.',
      experience: '',
      promotionChannels: [],
    },
  }, response, (error) => { throw error; });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /open role from the opportunities feed/i);
});

test('applicants cannot retrieve another user’s private Connect document', async () => {
  const originalFindById = ConnectApplication.findById;
  ConnectApplication.findById = () => ({
    select() { return this; },
    lean: async () => ({
      userId: '507f1f77bcf86cd799439011',
      documents: [{
        _id: '507f1f77bcf86cd799439013',
        publicId: 'private/cv.pdf',
        format: 'pdf',
      }],
    }),
  });
  const response = makeResponse();
  try {
    await getMyApplicationDocument({
      params: {
        applicationId: '507f1f77bcf86cd799439012',
        documentId: '507f1f77bcf86cd799439013',
      },
      user: { _id: '507f1f77bcf86cd799439014' },
    }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 404);
    assert.match(response.body.message, /document not found/i);
  } finally {
    ConnectApplication.findById = originalFindById;
  }
});

test('application capacity reservation stays within the limit under concurrent submissions', async () => {
  const originalFindOneAndUpdate = ConnectOpportunity.findOneAndUpdate;
  const originalFindById = ConnectOpportunity.findById;
  let applicationCount = 0;
  let status = 'open';
  const maximumApplications = 2;
  ConnectOpportunity.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.applicationCount.$lt, maximumApplications);
    assert.equal(update.$inc.applicationCount, 1);
    if (status !== 'open' || applicationCount >= maximumApplications) return null;
    applicationCount += 1;
    return {
      applicationCount,
      maximumApplications,
      status,
      async save() { status = this.status; },
    };
  };
  ConnectOpportunity.findById = () => ({
    session: async () => ({ applicationCount, maximumApplications }),
  });
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveOpportunityCapacity({
      _id: '507f1f77bcf86cd799439011',
      maximumApplications,
    }, null)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, maximumApplications);
    assert.equal(applicationCount, maximumApplications);
    assert.equal(status, 'closed');
    assert.ok(results.filter((result) => result.status === 'rejected')
      .every((result) => /capacity reached/i.test(result.reason.message)));
  } finally {
    ConnectOpportunity.findOneAndUpdate = originalFindOneAndUpdate;
    ConnectOpportunity.findById = originalFindById;
  }
});
