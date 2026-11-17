const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Writable } = require('node:stream');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectApplicationMessage = require('../models/ConnectApplicationMessage');
const ConnectAssociate = require('../models/ConnectAssociate');
const ConnectIdCardRequest = require('../models/ConnectIdCardRequest');
const idCardController = require('../controllers/connectIdCardController');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { privateImageUrl, streamPrivateImage, validatePrivateImage } = require('../services/connectPrivateImages');

const userId = '507f1f77bcf86cd799439011';
const associateId = '507f1f77bcf86cd799439012';
const applicationId = '507f1f77bcf86cd799439013';

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

test('private image uploads require a supported MIME type and matching file signature', () => {
  const png = {
    mimetype: 'image/png',
    size: 8,
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  };
  assert.equal(validatePrivateImage(png).format, 'png');
  assert.throws(() => validatePrivateImage({ ...png, mimetype: 'image/jpeg' }), { status: 415 });
  assert.throws(() => validatePrivateImage({ ...png, size: 2 * 1024 * 1024 + 1 }, 2 * 1024 * 1024), { status: 413 });
});

test('private image links are authenticated and expire within five minutes', () => {
  const variables = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = variables.map((name) => process.env[name]);
  process.env.CLOUDINARY_CLOUD_NAME = 'connect-test';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';
  try {
    const url = new URL(privateImageUrl('gwic/connect-id-cards/user/photo', 'png'));
    const expiresAt = Number(url.searchParams.get('expires_at'));
    const now = Math.floor(Date.now() / 1000);
    assert.equal(url.searchParams.get('type'), 'authenticated');
    assert.equal(url.searchParams.get('attachment'), 'false');
    assert.ok(expiresAt > now && expiresAt <= now + 300);
  } finally {
    variables.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test('private image delivery streams bytes with a fixed image type and private cache policy', async () => {
  const variables = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = variables.map((name) => process.env[name]);
  const originalFetch = global.fetch;
  const chunks = [];
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  response.status = function setStatus(status) { this.statusCode = status; return this; };
  response.set = function setHeaders(headers) { this.headers = headers; return this; };
  process.env.CLOUDINARY_CLOUD_NAME = 'connect-test';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(Buffer.from('private image bytes'), { status: 200 });
  };
  try {
    await streamPrivateImage(response, 'gwic/connect-id-cards/user/photo', 'png');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'image/png');
    assert.equal(response.headers['Cache-Control'], 'private, max-age=60');
    assert.equal(Buffer.concat(chunks).toString(), 'private image bytes');
    assert.ok(requestedUrl.searchParams.has('signature'));
  } finally {
    global.fetch = originalFetch;
    variables.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test('Connect ID card requests validate their associate, application, and private photo metadata', async () => {
  const request = new ConnectIdCardRequest({
    userId,
    associateId,
    applicationId,
    photoPublicId: 'gwic/connect-id-cards/user/photo',
    photoFormat: 'png',
    photoBytes: 512,
    status: 'approved',
    issuedAt: new Date(),
  });
  await request.validate();

  const associate = new ConnectAssociate({
    userId,
    applicationId,
    assignedRole: 'Customer Care Assistant',
    employeeId: 'KALMA-123ABC',
  });
  await associate.validate();
});

test('inbox messages may contain text or up to three valid private images', async () => {
  const attachment = {
    name: 'headshot.png',
    publicId: 'gwic/connect-message-images/user/photo',
    format: 'png',
    mimeType: 'image/png',
    bytes: 512,
  };
  await new ConnectApplicationMessage({
    applicationId,
    senderId: userId,
    senderRole: 'applicant',
    body: '',
    attachments: [attachment],
  }).validate();

  await assert.rejects(
    new ConnectApplicationMessage({
      applicationId,
      senderId: userId,
      senderRole: 'applicant',
      body: ' ',
    }).validate(),
    (error) => error.name === 'ValidationError' && Boolean(error.errors.body),
  );
  await assert.rejects(
    new ConnectApplicationMessage({
      applicationId,
      senderId: userId,
      senderRole: 'applicant',
      body: 'Please review these.',
      attachments: Array(4).fill(attachment),
    }).validate(),
    (error) => error.name === 'ValidationError' && Boolean(error.errors.attachments),
  );
});

test('ID card admin audits accept submit and review actions', async () => {
  await new ConnectAdminAudit({
    actorId: userId,
    action: 'connect_id_card_submitted',
    entityType: 'connect_id_card',
    entityId: associateId,
  }).validate();
  await new ConnectAdminAudit({
    actorId: userId,
    action: 'connect_id_card_reviewed',
    entityType: 'connect_id_card',
    entityId: associateId,
  }).validate();
});

test('ID card reviews reject invalid status and missing change-request notes before database access', async () => {
  for (const body of [
    { status: 'issued' },
    { status: 'changes_requested', reviewNote: '' },
    { status: 'revoked', reviewNote: '' },
  ]) {
    const response = makeResponse();
    await idCardController.reviewIdCardRequest({
      params: { requestId: associateId },
      body,
      user: { _id: userId },
    }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /valid ID card decision/i);
  }
});

test('admin can unissue only an issued card with a reason and notify the owner', async () => {
  const methods = [
    [ConnectIdCardRequest, 'findById'],
    [ConnectIdCardRequest, 'findOneAndUpdate'],
    [ConnectAdminAudit, 'create'],
    [Notification, 'create'],
    [User, 'findById'],
    [require('mongoose'), 'startSession'],
  ];
  const originals = methods.map(([target, key]) => target[key]);
  const issuedCard = {
    _id: '507f1f77bcf86cd799439014',
    userId,
    associateId,
    status: 'approved',
  };
  const auditEntries = [];
  const notifications = [];
  let updateFilter;
  let update;
  ConnectIdCardRequest.findById = () => ({ select: async () => issuedCard });
  ConnectIdCardRequest.findOneAndUpdate = async (filter, changes) => {
    updateFilter = filter;
    update = changes;
    return {
      _id: issuedCard._id,
      userId,
      status: 'revoked',
      reviewNote: 'Associate is no longer with the organization.',
      reviewedAt: new Date(),
      issuedAt: new Date('2026-11-01T00:00:00.000Z'),
      verificationId: 'b'.repeat(48),
    };
  };
  ConnectAdminAudit.create = async (records) => { auditEntries.push(...records); };
  Notification.create = async (records) => { notifications.push(...records); };
  User.findById = () => ({ select: async () => ({ name: 'Kalma Associate', email: 'associate@example.com' }) });
  require('mongoose').startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  const response = makeResponse();
  try {
    await idCardController.reviewIdCardRequest({
      params: { requestId: issuedCard._id },
      body: { status: 'revoked', reviewNote: 'Associate is no longer with the organization.' },
      user: { _id: '507f1f77bcf86cd799439015' },
    }, response, (error) => { throw error; });
    assert.deepEqual(updateFilter, { _id: issuedCard._id, status: 'approved' });
    assert.equal(update.$set.status, 'revoked');
    assert.equal(update.$set.reviewNote, 'Associate is no longer with the organization.');
    assert.equal(Object.hasOwn(update.$set, 'verificationId'), false);
    assert.equal(auditEntries[0].action, 'connect_id_card_unissued');
    assert.equal(notifications[0].title, 'Your ID card was unissued');
    assert.match(notifications[0].message, /no longer with the organization/);
    assert.equal(response.body.request.status, 'revoked');
    assert.equal(response.body.request.photoUrl, '/api/admin/connect/id-cards/507f1f77bcf86cd799439014/photo');
  } finally {
    methods.forEach(([target, key], index) => { target[key] = originals[index]; });
  }
});

test('admin cannot unissue a card that is not currently issued', async () => {
  const originalFindById = ConnectIdCardRequest.findById;
  const originalStartSession = require('mongoose').startSession;
  ConnectIdCardRequest.findById = () => ({
    select: async () => ({ status: 'pending' }),
  });
  require('mongoose').startSession = async () => {
    throw new Error('A transaction should not start for a pending card.');
  };
  const response = makeResponse();
  try {
    await idCardController.reviewIdCardRequest({
      params: { requestId: '507f1f77bcf86cd799439014' },
      body: { status: 'revoked', reviewNote: 'No longer employed.' },
      user: { _id: '507f1f77bcf86cd799439015' },
    }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /Only an issued ID card can be unissued/);
  } finally {
    ConnectIdCardRequest.findById = originalFindById;
    require('mongoose').startSession = originalStartSession;
  }
});

test('public card verification discloses only active issuance details for an unguessable token', async () => {
  const originalFindOne = ConnectIdCardRequest.findOne;
  const validToken = 'a'.repeat(48);
  let filter;
  ConnectIdCardRequest.findOne = (query) => {
    filter = query;
    return {
      select() { return this; },
      populate() { return this; },
      lean: async () => ({
        status: 'approved',
        issuedAt: new Date('2026-11-17T00:00:00.000Z'),
        userId: { name: 'Kalma Associate' },
        associateId: {
          status: 'active',
          employeeId: 'KALMA-123ABC',
          assignedRole: 'Customer Care Assistant',
        },
      }),
    };
  };
  const response = makeResponse();
  response.headers = {};
  response.set = function setHeader(name, value) { this.headers[name] = value; return this; };
  try {
    await idCardController.verifyIssuedIdCard({ params: { verificationId: validToken } }, response, (error) => { throw error; });
    assert.deepEqual(filter, { verificationId: validToken });
    assert.deepEqual(response.body, {
      verified: true,
      status: 'active',
      name: 'Kalma Associate',
      employeeId: 'KALMA-123ABC',
      role: 'Customer Care Assistant',
      issuedAt: new Date('2026-11-17T00:00:00.000Z'),
    });
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(Object.hasOwn(response.body, 'email'), false);
  } finally {
    ConnectIdCardRequest.findOne = originalFindOne;
  }
});

test('public card verification rejects malformed tokens without database access', async () => {
  const originalFindOne = ConnectIdCardRequest.findOne;
  ConnectIdCardRequest.findOne = () => { throw new Error('Malformed token reached the database'); };
  const response = makeResponse();
  try {
    await idCardController.verifyIssuedIdCard({ params: { verificationId: 'guessable' } }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { verified: false, status: 'invalid' });
  } finally {
    ConnectIdCardRequest.findOne = originalFindOne;
  }
});

test('public card verification reports unissued cards as no longer valid', async () => {
  const originalFindOne = ConnectIdCardRequest.findOne;
  ConnectIdCardRequest.findOne = () => ({
    select() { return this; },
    populate() { return this; },
    lean: async () => ({
      status: 'revoked',
      issuedAt: new Date('2026-11-17T00:00:00.000Z'),
      userId: { name: 'Kalma Associate' },
      associateId: {
        status: 'active',
        employeeId: 'KALMA-123ABC',
        assignedRole: 'Customer Care Assistant',
      },
    }),
  });
  const response = makeResponse();
  response.set = function setHeader() { return this; };
  try {
    await idCardController.verifyIssuedIdCard({
      params: { verificationId: 'c'.repeat(48) },
    }, response, (error) => { throw error; });
    assert.deepEqual(response.body, {
      verified: false,
      status: 'unissued',
      name: 'Kalma Associate',
      employeeId: 'KALMA-123ABC',
      role: 'Customer Care Assistant',
      issuedAt: new Date('2026-11-17T00:00:00.000Z'),
    });
  } finally {
    ConnectIdCardRequest.findOne = originalFindOne;
  }
});
