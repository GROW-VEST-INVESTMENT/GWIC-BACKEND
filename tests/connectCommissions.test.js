const assert = require('node:assert/strict');
const { test } = require('node:test');
const ConnectCommission = require('../models/ConnectCommission');
const ConnectPolicy = require('../models/ConnectPolicy');
const ConnectReferral = require('../models/ConnectReferral');
const {
  createRegistrationCommission,
  getQualifyingDepositMilestones,
  isValidRewardSchedule,
  MAX_REFERRAL_REWARD_NAIRA,
} = require('../services/connectCommissions');

const registeredAt = new Date('2026-01-01T10:00:00.000Z');
const kycApprovedAt = new Date('2026-01-05T12:00:00.000Z');

function deposit(id, settledAt, options = {}) {
  return {
    _id: id,
    type: options.type || 'deposit',
    status: options.status || 'successful',
    createdAt: options.createdAt || settledAt,
    tierUsageAt: settledAt,
  };
}

test('deposit milestones require successful settlements after KYC within 60 days of signup', () => {
  const beforeKyc = deposit('before-kyc', new Date('2026-01-05T11:59:59.999Z'));
  const first = deposit('first', new Date('2026-01-05T12:00:00.001Z'));
  const sameDay = deposit('same-day', new Date('2026-01-05T18:00:00.000Z'));
  const nextUtcDay = deposit('next-day', new Date('2026-01-06T00:00:00.000Z'));
  const reversed = deposit('reversed', new Date('2026-01-07T10:00:00.000Z'), { status: 'reversed' });
  const wrongType = deposit('withdrawal', new Date('2026-01-08T10:00:00.000Z'), { type: 'withdrawal' });
  const outsideWindow = deposit('outside-window', new Date('2026-03-02T10:00:00.000Z'));

  const milestones = getQualifyingDepositMilestones(
    [nextUtcDay, beforeKyc, sameDay, reversed, first, wrongType, outsideWindow],
    registeredAt,
    kycApprovedAt,
  );

  assert.equal(milestones.firstDeposit._id, 'first');
  assert.deepEqual(milestones.activeSaver.map((item) => item._id), ['first', 'next-day']);
  assert.equal(getQualifyingDepositMilestones(
    [first, sameDay],
    registeredAt,
    kycApprovedAt,
  ).activeSaver, null);
});

test('missing or invalid KYC approval time prevents deposit rewards', () => {
  const deposits = [deposit('first', new Date('2026-01-06T00:00:00.000Z'))];
  assert.deepEqual(getQualifyingDepositMilestones(deposits, registeredAt, null), {
    firstDeposit: null,
    activeSaver: null,
  });
  assert.deepEqual(getQualifyingDepositMilestones(deposits, registeredAt, 'invalid'), {
    firstDeposit: null,
    activeSaver: null,
  });
});

test('reward schedule validation enforces whole-naira amounts and the per-referral cap', () => {
  assert.equal(MAX_REFERRAL_REWARD_NAIRA, 400);
  assert.equal(isValidRewardSchedule({
    registrationRewardNaira: 40,
    kycRewardNaira: 60,
    firstDepositRewardNaira: 200,
    activeSaverBonusNaira: 100,
  }), true);
  assert.equal(isValidRewardSchedule({
    registrationRewardNaira: 41,
    kycRewardNaira: 60,
    firstDepositRewardNaira: 200,
    activeSaverBonusNaira: 100,
  }), false);
  assert.equal(isValidRewardSchedule({
    registrationRewardNaira: 40.5,
    kycRewardNaira: 60,
    firstDepositRewardNaira: 200,
    activeSaverBonusNaira: 100,
  }), false);
});

test('registration commission creation reserves the reward amount once per referral', async () => {
  const originals = {
    approvedGate: process.env.CONNECT_COMMISSION_POLICY_APPROVED,
    policyFindOneAndUpdate: ConnectPolicy.findOneAndUpdate,
    commissionFindOne: ConnectCommission.findOne,
    commissionAggregate: ConnectCommission.aggregate,
    commissionCreate: ConnectCommission.create,
    referralUpdateOne: ConnectReferral.updateOne,
  };
  const referral = {
    _id: '507f1f77bcf86cd799439011',
    partnerId: '507f1f77bcf86cd799439012',
    commissionReservedKobo: undefined,
  };
  const commissions = [];
  const policy = {
    registrationRewardNaira: 40,
    kycRewardNaira: 60,
    firstDepositRewardNaira: 200,
    activeSaverBonusNaira: 100,
    milestoneRewardsEnabled: true,
  };
  const query = (value) => ({
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  });
  process.env.CONNECT_COMMISSION_POLICY_APPROVED = 'true';
  ConnectPolicy.findOneAndUpdate = () => query(policy);
  ConnectCommission.findOne = ({ type }) => query(
    commissions.find((commission) => commission.type === type) || null,
  );
  ConnectCommission.aggregate = () => query([]);
  ConnectCommission.create = async (documents) => {
    commissions.push(...documents);
    return documents;
  };
  ConnectReferral.updateOne = async (filter, update) => {
    if (filter.commissionReservedKobo.$exists === false) {
      referral.commissionReservedKobo = update.$set.commissionReservedKobo;
      return { matchedCount: 1 };
    }
    if (referral.commissionReservedKobo > filter.commissionReservedKobo.$lte) {
      return { matchedCount: 0 };
    }
    referral.commissionReservedKobo += update.$inc.commissionReservedKobo;
    return { matchedCount: 1 };
  };

  try {
    await createRegistrationCommission(referral, {});
    await createRegistrationCommission(referral, {});
    assert.equal(commissions.length, 1);
    assert.equal(commissions[0].amountKobo, 4000);
    assert.equal(referral.commissionReservedKobo, 4000);
  } finally {
    if (originals.approvedGate === undefined) delete process.env.CONNECT_COMMISSION_POLICY_APPROVED;
    else process.env.CONNECT_COMMISSION_POLICY_APPROVED = originals.approvedGate;
    ConnectPolicy.findOneAndUpdate = originals.policyFindOneAndUpdate;
    ConnectCommission.findOne = originals.commissionFindOne;
    ConnectCommission.aggregate = originals.commissionAggregate;
    ConnectCommission.create = originals.commissionCreate;
    ConnectReferral.updateOne = originals.referralUpdateOne;
  }
});
