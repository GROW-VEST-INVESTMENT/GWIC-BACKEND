const assert = require('node:assert/strict');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const User = require('../models/User');
const { updateAccountStatus } = require('../controllers/adminController');
const requireAuth = require('../middleware/requireAuth');

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

test('account status updates require a supported state and a meaningful reason', async () => {
  for (const body of [
    { status: 'pending', reason: 'Reviewed account' },
    { status: 'suspended', reason: 'No' },
    { status: 'suspended', reason: '' },
  ]) {
    const response = makeResponse();
    await updateAccountStatus(
      { body, params: { userId: '507f1f77bcf86cd799439011' } },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 400);
  }
});

test('freezing and restoring a customer records reasons and invalidates their sessions', async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindById = User.findById;
  const originalAuditSave = AdminAuditLog.prototype.save;
  const userId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const user = {
    _id: userId,
    id: userId.toString(),
    role: 'user',
    status: 'pending',
    sessionVersion: 4,
    async save() {},
  };
  const audits = [];

  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    async endSession() {},
  });
  User.findById = () => ({ session: () => user });
  AdminAuditLog.prototype.save = async function save() {
    audits.push(this);
    return this;
  };

  try {
    const freezeResponse = makeResponse();
    await updateAccountStatus(
      {
        body: { status: 'suspended', reason: 'Review requested' },
        params: { userId: userId.toString() },
        user: { _id: actorId },
      },
      freezeResponse,
      (error) => { throw error; },
    );

    assert.equal(freezeResponse.statusCode, 200);
    assert.equal(user.status, 'suspended');
    assert.equal(user.statusBeforeSuspension, 'pending');
    assert.equal(user.suspensionReason, 'Review requested');
    assert.equal(user.sessionVersion, 5);
    assert.equal(freezeResponse.body.user.status, 'suspended');
    assert.equal(audits[0].action, 'account.status_updated');
    assert.equal(audits[0].previousStatus, 'pending');
    assert.equal(audits[0].nextStatus, 'suspended');

    const restoreResponse = makeResponse();
    await updateAccountStatus(
      {
        body: { status: 'active', reason: 'Review complete' },
        params: { userId: userId.toString() },
        user: { _id: actorId },
      },
      restoreResponse,
      (error) => { throw error; },
    );
    assert.equal(restoreResponse.statusCode, 200);
    assert.equal(user.status, 'pending');
    assert.equal(user.statusBeforeSuspension, null);
    assert.equal(user.suspensionReason, '');
    assert.equal(user.sessionVersion, 6);
    assert.equal(audits[1].previousStatus, 'suspended');
    assert.equal(audits[1].nextStatus, 'pending');
    assert.equal(audits[1].note, 'Review complete');

    let restoreError;
    await updateAccountStatus(
      {
        body: { status: 'active', reason: 'Premature access' },
        params: { userId: userId.toString() },
        user: { _id: actorId },
      },
      makeResponse(),
      (error) => { restoreError = error; },
    );
    assert.equal(restoreError.status, 409);
  } finally {
    mongoose.startSession = originalStartSession;
    User.findById = originalFindById;
    AdminAuditLog.prototype.save = originalAuditSave;
  }
});

test('authentication blocks suspended users even when an existing token is otherwise valid', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  process.env.JWT_SECRET = 'test-secret';
  User.findById = () => ({
    select: async () => ({ sessionVersion: 0, status: 'suspended' }),
  });

  try {
    const token = jwt.sign(
      { sub: '507f1f77bcf86cd799439011', ver: 0 },
      process.env.JWT_SECRET,
    );
    const response = makeResponse();
    let passed = false;
    await requireAuth(
      { headers: { cookie: `gwic_session=${token}` } },
      response,
      () => { passed = true; },
    );
    assert.equal(passed, false);
    assert.equal(response.statusCode, 403);
    assert.match(response.body.message, /suspended/i);
  } finally {
    User.findById = originalFindById;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});
