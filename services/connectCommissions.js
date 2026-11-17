const ConnectCommission = require('../models/ConnectCommission');
const ConnectPartner = require('../models/ConnectPartner');
const ConnectPolicy = require('../models/ConnectPolicy');
const ConnectReferral = require('../models/ConnectReferral');
const VerificationRequest = require('../models/VerificationRequest');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_REFERRAL_REWARD_NAIRA = 400;
const REVERSED_DEPOSIT_REVIEW_NOTE = 'The qualifying deposit was refunded or reversed.';
const REWARD_FIELDS = {
  registration: 'registrationRewardNaira',
  kyc_verification: 'kycRewardNaira',
  first_deposit: 'firstDepositRewardNaira',
  active_saver: 'activeSaverBonusNaira',
};

function isValidRewardSchedule(schedule) {
  const amounts = Object.values(REWARD_FIELDS).map((field) => schedule[field]);
  return amounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0)
    && amounts.reduce((total, amount) => total + amount, 0) <= MAX_REFERRAL_REWARD_NAIRA;
}

function getQualifyingDepositMilestones(deposits, registeredAt, kycApprovedAt) {
  if (!registeredAt || !kycApprovedAt) return { firstDeposit: null, activeSaver: null };
  const start = new Date(registeredAt).getTime();
  const kycTime = new Date(kycApprovedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(kycTime)) {
    return { firstDeposit: null, activeSaver: null };
  }
  const end = start + (60 * DAY_IN_MILLISECONDS);
  const qualifyingDeposits = deposits
    .filter((deposit) => {
      const settledAt = new Date(deposit.tierUsageAt || deposit.createdAt).getTime();
      return deposit.status === 'successful'
        && deposit.type === 'deposit'
        && Number.isFinite(settledAt)
        && settledAt > Math.max(start, kycTime)
        && settledAt < end;
    })
    .sort((left, right) => (
      new Date(left.tierUsageAt || left.createdAt) - new Date(right.tierUsageAt || right.createdAt)
    ));
  if (!qualifyingDeposits.length) return { firstDeposit: null, activeSaver: null };

  const depositsByUtcDate = new Map();
  qualifyingDeposits.forEach((deposit) => {
    const date = new Date(deposit.tierUsageAt || deposit.createdAt).toISOString().slice(0, 10);
    if (!depositsByUtcDate.has(date)) depositsByUtcDate.set(date, deposit);
  });
  const separateDates = [...depositsByUtcDate.values()];
  return {
    firstDeposit: qualifyingDeposits[0],
    activeSaver: separateDates.length >= 2 ? separateDates.slice(0, 2) : null,
  };
}

function transactionQuery(query, session) {
  return session ? query.session(session) : query;
}

async function getPolicy(session) {
  return transactionQuery(
    ConnectPolicy.findOneAndUpdate(
      { key: 'default' },
      { $setOnInsert: { key: 'default' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ),
    session,
  );
}

function rewardsAreEnabled(policy) {
  return process.env.CONNECT_COMMISSION_POLICY_APPROVED === 'true'
    && policy?.milestoneRewardsEnabled === true;
}

async function createPendingCommission(referral, type, policy, sourceTransactionIds = [], session) {
  const rewardField = REWARD_FIELDS[type];
  const amountNaira = policy?.[rewardField];
  if (!Number.isSafeInteger(amountNaira) || amountNaira <= 0) return;

  const existing = await transactionQuery(
    ConnectCommission.findOne({ referralId: referral._id, type }),
    session,
  );
  const canReissue = ['first_deposit', 'active_saver'].includes(type)
    && existing?.status === 'rejected'
    && existing.reviewNote === REVERSED_DEPOSIT_REVIEW_NOTE;
  if (existing && !canReissue) return;

  const amountKobo = amountNaira * 100;
  const reservedKobo = await getCommissionReservation(referral, session);
  const reservation = await ConnectReferral.updateOne(
    { _id: referral._id, commissionReservedKobo: { $lte: (MAX_REFERRAL_REWARD_NAIRA * 100) - amountKobo } },
    { $inc: { commissionReservedKobo: amountKobo } },
    session ? { session } : {},
  );
  if (reservation.matchedCount !== 1) {
    console.error(`Connect commission skipped: referral ${referral._id} has reached its reward cap.`);
    return;
  }
  if (canReissue) {
    const updated = await ConnectCommission.findOneAndUpdate(
      { _id: existing._id, status: 'rejected', reviewNote: REVERSED_DEPOSIT_REVIEW_NOTE },
      {
        $set: {
          amountKobo,
          sourceTransactionIds,
          status: 'pending',
          reviewNote: '',
          reviewedBy: null,
          reviewedAt: null,
        },
      },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    );
    if (!updated) {
      await releaseCommissionReservation({ referralId: referral._id, amountKobo }, session);
      return;
    }
  } else {
    await ConnectCommission.create([{
      partnerId: referral.partnerId,
      referralId: referral._id,
      type,
      amountKobo,
      sourceTransactionIds,
    }], session ? { session } : {});
  }
  referral.commissionReservedKobo = reservedKobo + amountKobo;
}

async function getCommissionReservation(referral, session) {
  if (Number.isSafeInteger(referral.commissionReservedKobo) && referral.commissionReservedKobo >= 0) {
    return referral.commissionReservedKobo;
  }

  const aggregate = ConnectCommission.aggregate([
    {
      $match: {
        referralId: referral._id,
        status: { $in: ['pending', 'approved'] },
      },
    },
    { $group: { _id: null, totalKobo: { $sum: '$amountKobo' } } },
  ]);
  if (session) aggregate.session(session);
  const [result] = await aggregate;
  const initialReservedKobo = result?.totalKobo || 0;
  const initialized = await ConnectReferral.updateOne(
    { _id: referral._id, commissionReservedKobo: { $exists: false } },
    { $set: { commissionReservedKobo: initialReservedKobo } },
    session ? { session } : {},
  );
  if (initialized.matchedCount === 1) return initialReservedKobo;

  const current = await transactionQuery(
    ConnectReferral.findById(referral._id).select('commissionReservedKobo'),
    session,
  );
  return current?.commissionReservedKobo || 0;
}

async function releaseCommissionReservation(commission, session) {
  await ConnectReferral.updateOne(
    {
      _id: commission.referralId,
      commissionReservedKobo: { $gte: commission.amountKobo },
    },
    { $inc: { commissionReservedKobo: -commission.amountKobo } },
    session ? { session } : {},
  );
}

async function createRegistrationCommission(referral, session) {
  const policy = await getPolicy(session);
  if (!rewardsAreEnabled(policy)) return;
  if (!isValidRewardSchedule(policy)) {
    console.error('Connect commission awards skipped: configured rewards exceed the per-referral limit.');
    return;
  }
  await createPendingCommission(referral, 'registration', policy, [], session);
}

async function awardVerifiedReferralMilestones(userId, session) {
  const [referral, user, verification, policy] = await Promise.all([
    transactionQuery(ConnectReferral.findOne({ referredUserId: userId }), session),
    transactionQuery(User.findById(userId).select('isKycVerified'), session),
    transactionQuery(
      VerificationRequest.findOne({ userId, status: 'verified' })
        .sort({ reviewedAt: -1, createdAt: -1 })
        .select('reviewedAt'),
      session,
    ),
    getPolicy(session),
  ]);
  if (!referral || !user?.isKycVerified || !verification?.reviewedAt || !rewardsAreEnabled(policy)) return;
  if (!isValidRewardSchedule(policy)) {
    console.error('Connect commission awards skipped: configured rewards exceed the per-referral limit.');
    return;
  }

  await createPendingCommission(referral, 'kyc_verification', policy, [], session);

  const windowEnd = new Date(new Date(referral.registeredAt).getTime() + (60 * DAY_IN_MILLISECONDS));
  const deposits = await transactionQuery(
    WalletTransaction.find({
      userId,
      type: 'deposit',
      status: 'successful',
      createdAt: { $gte: referral.registeredAt, $lt: windowEnd },
    })
      .sort({ createdAt: 1, _id: 1 })
      .select('_id type status createdAt tierUsageAt'),
    session,
  );
  const milestones = getQualifyingDepositMilestones(
    deposits,
    referral.registeredAt,
    verification.reviewedAt,
  );
  if (milestones.firstDeposit) {
    await createPendingCommission(
      referral,
      'first_deposit',
      policy,
      [milestones.firstDeposit._id],
      session,
    );
  }
  if (milestones.activeSaver) {
    await createPendingCommission(
      referral,
      'active_saver',
      policy,
      milestones.activeSaver.map((deposit) => deposit._id),
      session,
    );
  }
}

async function rejectPendingCommissionsForReversedDeposit(transactionId, session) {
  const pendingCommissions = await transactionQuery(
    ConnectCommission.find({
      status: 'pending',
      type: { $in: ['first_deposit', 'active_saver'] },
      sourceTransactionIds: transactionId,
    }),
    session,
  );
  for (const commission of pendingCommissions) {
    const updated = await ConnectCommission.findOneAndUpdate(
      { _id: commission._id, status: 'pending' },
      {
        $set: {
          status: 'rejected',
          reviewNote: REVERSED_DEPOSIT_REVIEW_NOTE,
          reviewedAt: new Date(),
        },
      },
      { new: true, ...(session ? { session } : {}) },
    );
    if (updated) await releaseCommissionReservation(updated, session);
  }
}

module.exports = {
  MAX_REFERRAL_REWARD_NAIRA,
  REVERSED_DEPOSIT_REVIEW_NOTE,
  awardVerifiedReferralMilestones,
  createRegistrationCommission,
  getQualifyingDepositMilestones,
  isValidRewardSchedule,
  releaseCommissionReservation,
  rejectPendingCommissionsForReversedDeposit,
};
