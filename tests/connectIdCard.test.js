const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Writable } = require('node:stream');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectApplicationMessage = require('../models/ConnectApplicationMessage');
const ConnectAssociate = require('../models/ConnectAssociate');
const ConnectIdCardRequest = require('../models/ConnectIdCardRequest');
const idCardController = require('../controllers/connectIdCardController');
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
