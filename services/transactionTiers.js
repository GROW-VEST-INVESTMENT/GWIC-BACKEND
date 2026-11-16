const WalletTransaction = require('../models/WalletTransaction');
const TransactionTierPolicy = require('../models/TransactionTierPolicy');

const DEFAULT_TIERS = [
  {
    level: 0,
    name: 'Unverified',
    deposit: { perTransaction: 10000, perDay: 20000, perMonth: 50000 },
    withdrawal: { perTransaction: 0, perDay: 0, perMonth: 0 },
  },
  {
    level: 1,
    name: 'Basic verified',
    deposit: { perTransaction: 100000, perDay: 200000, perMonth: 1000000 },
    withdrawal: { perTransaction: 50000, perDay: 100000, perMonth: 500000 },
  },
  {
    level: 2,
    name: 'Fully verified',
    deposit: { perTransaction: 500000, perDay: 1000000, perMonth: 5000000 },
    withdrawal: { perTransaction: 250000, perDay: 500000, perMonth: 2000000 },
  },
  {
    level: 3,
    name: 'Enhanced verification',
    deposit: { perTransaction: 2000000, perDay: 5000000, perMonth: 20000000 },
    withdrawal: { perTransaction: 1000000, perDay: 2000000, perMonth: 10000000 },
  },
];

const ACTIVE_STATUSES = {
  deposit: ['pending', 'processing', 'requires_approval', 'successful'],
  withdrawal: ['processing', 'requires_approval', 'successful'],
};

const TIER_VERIFICATION_STEPS = [
  {
    level: 0,
    title: 'Starter account',
    requirements: ['Your account is active. Deposit and withdrawal limits remain at Tier 0.'],
  },
  {
    level: 1,
    title: 'Identity verification',
    requirements: [
      'Confirm your legal name and date of birth.',
      'Complete identity matching through an approved BVN or NIN verification provider.',
      'An administrator reviews the provider result before this tier is approved.',
    ],
  },
  {
    level: 2,
    title: 'Address verification',
    requirements: [
      'Tier 1 identity verification must already be approved.',
      'Complete address checks through an approved verification provider.',
      'Complete any additional liveness check required by your licensed partner.',
      'An administrator reviews the provider result before this tier is approved.',
    ],
  },
  {
    level: 3,
    title: 'Enhanced review',
    requirements: [
      'Tier 2 checks must already be approved.',
      'Complete occupation and source-of-funds checks through an approved secure process.',
      'A super administrator must complete the final manual review.',
    ],
  },
];

function getTierLevel(user) {
  if (Number.isInteger(user?.transactionTier) && user.transactionTier >= 0 && user.transactionTier <= 3) {
    return user.transactionTier;
  }
  return user?.isKycVerified === true ? 2 : 0;
}

function serializeTier(tier) {
  const verification = TIER_VERIFICATION_STEPS[tier.level];
  return {
    level: tier.level,
    name: tier.name,
    title: verification.title,
    requirements: verification.requirements,
    deposit: {
      perTransaction: tier.deposit.perTransaction,
      perDay: tier.deposit.perDay,
      perMonth: tier.deposit.perMonth,
    },
    withdrawal: {
      perTransaction: tier.withdrawal.perTransaction,
      perDay: tier.withdrawal.perDay,
      perMonth: tier.withdrawal.perMonth,
    },
  };
}

async function getTierPolicy(session) {
  let query = TransactionTierPolicy.findOne({ key: 'default' }).lean();
  if (session) query = query.session(session);
  const savedPolicy = await query;
  return savedPolicy?.tiers?.length === 4 ? savedPolicy.tiers : DEFAULT_TIERS;
}

function getUtcPeriods(now = new Date()) {
  return {
    dayStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}

async function getTransactionUsage(userId, type, now = new Date(), session, excludeTransactionId = null) {
  const { dayStart, monthStart } = getUtcPeriods(now);
  const aggregate = WalletTransaction.aggregate([
    {
      $match: {
        userId,
        type,
        status: { $in: ACTIVE_STATUSES[type] },
        ...(excludeTransactionId ? { _id: { $ne: excludeTransactionId } } : {}),
      },
    },
    { $addFields: { quotaAt: { $ifNull: ['$tierUsageAt', '$createdAt'] } } },
    {
      $match: {
        $expr: {
          $and: [
            { $gte: ['$quotaAt', monthStart] },
            { $lte: ['$quotaAt', now] },
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        monthlyKobo: { $sum: '$amountKobo' },
        dailyKobo: {
          $sum: {
            $cond: [{ $gte: ['$quotaAt', dayStart] }, '$amountKobo', 0],
          },
        },
      },
    },
  ]);
  if (session) aggregate.session(session);
  const [usage] = await aggregate;
  return {
    daily: usage?.dailyKobo || 0,
    monthly: usage?.monthlyKobo || 0,
  };
}

function getLimitViolation(amountKobo, limits, usage) {
  if (amountKobo > limits.perTransaction * 100) return 'perTransaction';
  if (usage.daily + amountKobo > limits.perDay * 100) return 'perDay';
  if (usage.monthly + amountKobo > limits.perMonth * 100) return 'perMonth';
  return null;
}

function makeUpgradeMessage(operation, tier, limitType, nextTier) {
  const limitLabel = {
    perTransaction: 'per-transaction limit',
    perDay: 'daily limit',
    perMonth: 'monthly limit',
  }[limitType];
  const action = operation === 'deposit' ? 'deposit' : 'withdrawal';
  if (nextTier) {
    return `This ${action} exceeds your Tier ${tier.level} ${tier.name} ${limitLabel}. Upgrade to Tier ${nextTier.level} (${nextTier.name}) to make higher transactions.`;
  }
  return `This ${action} exceeds your Tier ${tier.level} ${tier.name} ${limitLabel}. Contact support to review your tier and available limits.`;
}

function serializeUsage(limits, usage) {
  return {
    perTransaction: limits.perTransaction,
    perDay: limits.perDay,
    perMonth: limits.perMonth,
    dailyUsed: usage.daily / 100,
    dailyRemaining: Math.max(0, limits.perDay - usage.daily / 100),
    monthlyUsed: usage.monthly / 100,
    monthlyRemaining: Math.max(0, limits.perMonth - usage.monthly / 100),
  };
}

async function getTierSummary(user, now = new Date()) {
  const tiers = await getTierPolicy();
  const level = getTierLevel(user);
  const tier = tiers[level] || DEFAULT_TIERS[level];
  const [depositUsage, withdrawalUsage] = await Promise.all([
    getTransactionUsage(user._id, 'deposit', now),
    getTransactionUsage(user._id, 'withdrawal', now),
  ]);
  const nextTier = tiers.find((item) => item.level > level) || null;
  return {
    level,
    name: tier.name,
    verificationStatus: user.isKycVerified ? 'verified' : 'unverified',
    deposit: serializeUsage(tier.deposit, depositUsage),
    withdrawal: serializeUsage(tier.withdrawal, withdrawalUsage),
    nextTier: nextTier ? {
      level: nextTier.level,
      name: nextTier.name,
    } : null,
  };
}

function validateTierPolicy(input) {
  if (!Array.isArray(input) || input.length !== 4) return null;
  const tiers = [];
  for (let level = 0; level < 4; level += 1) {
    const item = input.find((candidate) => candidate?.level === level);
    if (!item || typeof item.name !== 'string' || item.name.trim().length < 3 || item.name.trim().length > 60) {
      return null;
    }
    const tier = { level, name: item.name.trim() };
    for (const operation of ['deposit', 'withdrawal']) {
      const limits = item[operation];
      if (!limits || !['perTransaction', 'perDay', 'perMonth'].every((key) => (
        Number.isSafeInteger(limits[key]) && limits[key] >= 0 && limits[key] <= 100000000
      ))) {
        return null;
      }
      if (limits.perTransaction > limits.perDay || limits.perDay > limits.perMonth) return null;
      tier[operation] = {
        perTransaction: limits.perTransaction,
        perDay: limits.perDay,
        perMonth: limits.perMonth,
      };
    }
    tiers.push(tier);
  }
  if (tiers[0].withdrawal.perTransaction !== 0
    || tiers[0].withdrawal.perDay !== 0
    || tiers[0].withdrawal.perMonth !== 0) return null;
  return tiers;
}

module.exports = {
  ACTIVE_STATUSES,
  DEFAULT_TIERS,
  TIER_VERIFICATION_STEPS,
  getLimitViolation,
  getTierLevel,
  getTierPolicy,
  getTierSummary,
  getTransactionUsage,
  makeUpgradeMessage,
  serializeTier,
  validateTierPolicy,
};
