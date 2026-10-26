const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  updateProfile,
  updatePreferences,
  createVerificationRequest,
  createSupportRequest,
  createLinkedBank,
  uploadAccountPhoto,
} = require('../controllers/accountController');
const requireAccountReviewer = require('../middleware/requireAccountReviewer');
const User = require('../models/User');
const LinkedBankAccount = require('../models/LinkedBankAccount');
const bcrypt = require('bcryptjs');

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

test('profile updates cannot change the account name', async () => {
  const response = makeResponse();
  await updateProfile({ body: { name: 'New Legal Name' } }, response, (error) => { throw error; });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /name cannot be changed/i);
});

test('profile updates reject email changes', async () => {
  const response = makeResponse();
  await updateProfile({ body: { email: 'new@example.com' } }, response, (error) => { throw error; });
  assert.equal(response.statusCode, 400);
});

test('registration requires at least a first and last name before database access', async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        email: 'ada@example.com',
        phone: '',
        goal: 'Emergency savings',
        product: 'undecided',
        password: 'secure-password',
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /full legal name/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('profile photo upload rejects files whose content is not a supported image', async () => {
  const response = makeResponse();
  await uploadAccountPhoto(
    {
      user: { id: '507f1f77bcf86cd799439011' },
      file: { mimetype: 'image/png', buffer: Buffer.from('not an image') },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 415);
  assert.match(response.body.message, /not a supported image/i);
});

test('profile photo upload reports when Cloudinary has not been configured', async () => {
  const cloudinaryVariables = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previousValues = cloudinaryVariables.map((name) => process.env[name]);
  cloudinaryVariables.forEach((name) => { delete process.env[name]; });
  const response = makeResponse();
  try {
    await uploadAccountPhoto(
      {
        user: { id: '507f1f77bcf86cd799439011' },
        file: {
          mimetype: 'image/png',
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      },
      response,
      (error) => { throw error; },
    );
  } finally {
    cloudinaryVariables.forEach((name, index) => {
      if (previousValues[index] === undefined) delete process.env[name];
      else process.env[name] = previousValues[index];
    });
  }

  assert.equal(response.statusCode, 503);
  assert.match(response.body.message, /not available yet/i);
});

test('bank linking enforces the three-account limit before contacting Paystack', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const originalCompare = bcrypt.compare;
  const originalFindOne = LinkedBankAccount.findOne;
  const originalCountDocuments = LinkedBankAccount.countDocuments;
  process.env.JWT_SECRET = 'test-jwt-secret';
  User.findById = () => ({ select: async () => ({ passwordHash: 'hash', name: 'Ada Example' }) });
  bcrypt.compare = async () => true;
  LinkedBankAccount.findOne = () => ({ lean: async () => null });
  LinkedBankAccount.countDocuments = async () => 3;
  const response = makeResponse();
  try {
    await createLinkedBank(
      {
        user: { id: '507f1f77bcf86cd799439011' },
        body: { accountNumber: '0123456789', bankCode: '044', password: 'current-password' },
      },
      response,
      (error) => { throw error; },
    );
  } finally {
    User.findById = originalFindById;
    bcrypt.compare = originalCompare;
    LinkedBankAccount.findOne = originalFindOne;
    LinkedBankAccount.countDocuments = originalCountDocuments;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }

  assert.equal(response.statusCode, 409);
  assert.match(response.body.message, /up to 3 bank accounts/i);
});

test('account preferences reject unsupported values', async () => {
  for (const body of [
    { hideWalletBalance: 'true' },
    { theme: 'neon' },
    { language: 'fr' },
    { isKycVerified: true },
  ]) {
    const response = makeResponse();
    await updatePreferences({ body }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 400);
  }
});

test('verification requests require explicit consent and a valid date', async () => {
  for (const body of [
    { legalName: 'Ada Example', dateOfBirth: '1990-01-01', consent: false },
    { legalName: 'Ada Example', dateOfBirth: '1990-02-30', consent: true },
    { legalName: 'Ada Example', dateOfBirth: '1990-01-01', consent: true, bvn: '12345678901' },
  ]) {
    const response = makeResponse();
    await createVerificationRequest({ body }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 400);
  }
});

test('support tickets require a valid topic and a sufficiently detailed message', async () => {
  const response = makeResponse();
  await createSupportRequest(
    { body: { category: 'other', subject: 'Help', message: 'Short' } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
});

test('account review routes reject missing or incorrect credentials', () => {
  const originalToken = process.env.ACCOUNT_REVIEW_TOKEN;
  process.env.ACCOUNT_REVIEW_TOKEN = 'review-secret';
  try {
    for (const authorization of ['', 'Bearer wrong-secret']) {
      const response = makeResponse();
      let passed = false;
      requireAccountReviewer(
        { get: () => authorization },
        response,
        () => { passed = true; },
      );
      assert.equal(passed, false);
      assert.equal(response.statusCode, 401);
    }
  } finally {
    if (originalToken === undefined) delete process.env.ACCOUNT_REVIEW_TOKEN;
    else process.env.ACCOUNT_REVIEW_TOKEN = originalToken;
  }
});

test('account review routes return unavailable until configured and accept the configured token', () => {
  const originalToken = process.env.ACCOUNT_REVIEW_TOKEN;
  try {
    delete process.env.ACCOUNT_REVIEW_TOKEN;
    const unavailableResponse = makeResponse();
    requireAccountReviewer({ get: () => 'Bearer review-secret' }, unavailableResponse, () => {});
    assert.equal(unavailableResponse.statusCode, 503);

    process.env.ACCOUNT_REVIEW_TOKEN = 'review-secret';
    let passed = false;
    requireAccountReviewer(
      { get: () => 'Bearer review-secret' },
      makeResponse(),
      () => { passed = true; },
    );
    assert.equal(passed, true);
  } finally {
    if (originalToken === undefined) delete process.env.ACCOUNT_REVIEW_TOKEN;
    else process.env.ACCOUNT_REVIEW_TOKEN = originalToken;
  }
});
