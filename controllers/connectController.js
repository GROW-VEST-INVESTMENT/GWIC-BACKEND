const crypto = require('node:crypto');
const mongoose = require('mongoose');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectApplication = require('../models/ConnectApplication');
const ConnectApplicationMessage = require('../models/ConnectApplicationMessage');
const ConnectAssociate = require('../models/ConnectAssociate');
const ConnectCommission = require('../models/ConnectCommission');
const ConnectPartner = require('../models/ConnectPartner');
const ConnectOpportunity = require('../models/ConnectOpportunity');
const ConnectPayout = require('../models/ConnectPayout');
const ConnectPolicy = require('../models/ConnectPolicy');
const ConnectReferral = require('../models/ConnectReferral');
const LinkedBankAccount = require('../models/LinkedBankAccount');
const Notification = require('../models/Notification');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const { paystackRequest } = require('../services/paystack');
const {
  MAX_REFERRAL_REWARD_NAIRA,
  isValidRewardSchedule,
  releaseCommissionReservation,
} = require('../services/connectCommissions');
const {
  ACTIVE_PAYOUT_STATUSES,
  providerStatusToPayoutStatus,
  updateConnectPayoutTransfer,
} = require('../services/connectPayoutTransfers');

const APPLICATION_TYPES = ['applicant', 'partner'];
const APPLICATION_STATUSES = ['pending', 'in_review', 'interview_scheduled', 'approved', 'rejected'];
const APPLICATION_ROLES = [
  'Customer Care Assistant',
  'Marketing Assistant',
  'Business Development Personnel',
  'Community Manager',
  'Support Personnel',
  'Other',
];
const PROMOTION_CHANNELS = ['social_media', 'community', 'email', 'other'];
const MAX_PAGE_SIZE = 100;

function messageError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function pageOptions(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function toNaira(amountKobo) {
  return amountKobo / 100;
}

async function getPolicy() {
  return ConnectPolicy.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function getBalance(partnerId, session) {
  const [approved, reserved] = await Promise.all([
    ConnectCommission.aggregate([
      { $match: { partnerId, status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amountKobo' } } },
    ]).session(session || null),
    ConnectPayout.aggregate([
      { $match: { partnerId, status: { $in: ['pending', 'approved', ...ACTIVE_PAYOUT_STATUSES, 'paid'] } } },
      { $group: { _id: null, total: { $sum: '$amountKobo' } } },
    ]).session(session || null),
  ]);
  return Math.max(0, (approved[0]?.total || 0) - (reserved[0]?.total || 0));
}

async function buildPartnerSummary(userId) {
  const partner = await ConnectPartner.findOne({ userId }).lean();
  if (!partner) return null;

  const [referrals, commissions, payouts, availableBalanceKobo] = await Promise.all([
    ConnectReferral.countDocuments({ partnerId: partner._id }),
    ConnectCommission.aggregate([
      { $match: { partnerId: partner._id } },
      { $group: { _id: '$status', amountKobo: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
    ]),
    ConnectPayout.aggregate([
      { $match: { partnerId: partner._id } },
      { $group: { _id: '$status', amountKobo: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
    ]),
    getBalance(partner._id),
  ]);
  const commissionByStatus = Object.fromEntries(commissions.map((item) => [item._id, item]));
  const payoutByStatus = Object.fromEntries(payouts.map((item) => [item._id, item]));

  return {
    status: partner.status,
    promoCode: partner.promoCode,
    referralCount: referrals,
    earnings: {
      pendingNaira: toNaira(commissionByStatus.pending?.amountKobo || 0),
      approvedNaira: toNaira(commissionByStatus.approved?.amountKobo || 0),
      rejectedNaira: toNaira(commissionByStatus.rejected?.amountKobo || 0),
    },
    withdrawals: {
      pendingNaira: toNaira(payoutByStatus.pending?.amountKobo || 0),
      approvedNaira: toNaira(payoutByStatus.approved?.amountKobo || 0),
      processingNaira: toNaira(payoutByStatus.processing?.amountKobo || 0),
      requiresOtpNaira: toNaira(payoutByStatus.requires_otp?.amountKobo || 0),
      paidNaira: toNaira(payoutByStatus.paid?.amountKobo || 0),
      failedNaira: toNaira(payoutByStatus.failed?.amountKobo || 0),
      reversedNaira: toNaira(payoutByStatus.reversed?.amountKobo || 0),
    },
    availableBalanceNaira: toNaira(availableBalanceKobo),
  };
}

function applicationToClient(application) {
  return {
    id: application._id,
    type: application.type,
    opportunityId: application.opportunityId || null,
    opportunityTitle: application.opportunityId && application.opportunityId.title
      ? application.opportunityId.title
      : '',
    status: application.status,
    roleInterest: application.roleInterest,
    assignedRole: application.assignedRole,
    motivation: application.motivation,
    experience: application.experience,
    promotionChannels: application.promotionChannels,
    reviewNote: application.reviewNote,
    interviewAt: application.interviewAt,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    documents: (application.documents || []).map((document) => ({
      id: document._id,
      name: document.name,
      format: document.format,
      bytes: document.bytes,
    })),
  };
}

const getMyConnectSummary = asyncHandler(async (req, res) => {
  const [applications, partner, associate, policy] = await Promise.all([
    ConnectApplication.find({ userId: req.user._id })
      .populate('opportunityId', 'title')
      .sort({ createdAt: -1 })
      .lean(),
    buildPartnerSummary(req.user._id),
    ConnectAssociate.findOne({ userId: req.user._id, status: 'active' }).select('assignedRole').lean(),
    getPolicy(),
  ]);
  return res.json({
    profile: { name: req.user.name, email: req.user.email, phone: req.user.phone || '' },
    applications: applications.map(applicationToClient),
    partner,
    associate,
    minimumPayoutNaira: policy.minimumPayoutNaira,
    commissionPolicy: {
      rewardsEnabled: process.env.CONNECT_COMMISSION_POLICY_APPROVED === 'true'
        && policy.milestoneRewardsEnabled,
      maxPerReferralNaira: MAX_REFERRAL_REWARD_NAIRA,
      registrationRewardNaira: policy.registrationRewardNaira,
      kycRewardNaira: policy.kycRewardNaira,
      firstDepositRewardNaira: policy.firstDepositRewardNaira,
      activeSaverBonusNaira: policy.activeSaverBonusNaira,
    },
  });
});

const createApplication = asyncHandler(async (req, res) => {
  const { type, motivation, roleInterest = '', experience = '', promotionChannels = [] } = req.body || {};
  if (!APPLICATION_TYPES.includes(type)
    || typeof motivation !== 'string'
    || motivation.trim().length < 30
    || motivation.trim().length > 2000
    || typeof roleInterest !== 'string'
    || typeof experience !== 'string'
    || experience.length > 3000
    || !Array.isArray(promotionChannels)
    || promotionChannels.some((channel) => !PROMOTION_CHANNELS.includes(channel))) {
    return res.status(400).json({ message: 'Please check the application details and try again.' });
  }
  if (type === 'applicant') {
    return res.status(400).json({ message: 'Choose an open role from the Opportunities feed to apply.' });
  }
  if (type === 'applicant' && !APPLICATION_ROLES.includes(roleInterest)) {
    return res.status(400).json({ message: 'Choose a valid opportunity for your application.' });
  }
  if (type === 'partner' && promotionChannels.length === 0) {
    return res.status(400).json({ message: 'Select at least one promotion channel.' });
  }
  if (type === 'applicant' && promotionChannels.length > 0) {
    return res.status(400).json({ message: 'Promotion channels are only used for partner applications.' });
  }
  const existingAccess = type === 'applicant'
    ? await ConnectAssociate.exists({ userId: req.user._id, status: 'active' })
    : await ConnectPartner.exists({ userId: req.user._id });
  if (existingAccess) {
    return res.status(409).json({
      message: type === 'applicant'
        ? 'You already have an active Associate role.'
        : 'You already have a Connect Partner profile.',
    });
  }

  try {
    const application = await ConnectApplication.create({
      userId: req.user._id,
      type,
      motivation: motivation.trim(),
      roleInterest: type === 'applicant' ? roleInterest : '',
      experience: experience.trim(),
      promotionChannels: type === 'partner' ? [...new Set(promotionChannels)] : [],
    });
    return res.status(201).json({ application: applicationToClient(application) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'You already have an active application of this type.' });
    }
    throw error;
  }
});

const listMyReferrals = asyncHandler(async (req, res) => {
  const partner = await ConnectPartner.findOne({ userId: req.user._id }).lean();
  if (!partner) return res.json({ referrals: [] });
  const { page, limit, skip } = pageOptions(req);
  const [referrals, total] = await Promise.all([
    ConnectReferral.find({ partnerId: partner._id })
      .sort({ registeredAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('status registeredAt createdAt')
      .lean(),
    ConnectReferral.countDocuments({ partnerId: partner._id }),
  ]);
  return res.json({ referrals, page, limit, total });
});

const listMyCommissions = asyncHandler(async (req, res) => {
  const partner = await ConnectPartner.findOne({ userId: req.user._id }).lean();
  if (!partner) return res.json({ commissions: [], page: 1, limit: 20, total: 0 });
  const { page, limit, skip } = pageOptions(req);
  const [commissions, total] = await Promise.all([
    ConnectCommission.find({ partnerId: partner._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('type amountKobo status reviewNote createdAt reviewedAt')
      .lean(),
    ConnectCommission.countDocuments({ partnerId: partner._id }),
  ]);
  return res.json({
    commissions: commissions.map((commission) => ({ ...commission, amountNaira: toNaira(commission.amountKobo) })),
    page,
    limit,
    total,
  });
});

const listMyPayouts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req);
  const [payouts, total] = await Promise.all([
    ConnectPayout.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('amountKobo status reviewNote paymentReference transferReference transferStatus transferError createdAt reviewedAt paidAt reversedAt')
      .lean(),
    ConnectPayout.countDocuments({ userId: req.user._id }),
  ]);
  return res.json({
    payouts: payouts.map((payout) => ({ ...payout, amountNaira: toNaira(payout.amountKobo) })),
    page,
    limit,
    total,
  });
});

const createPayoutRequest = asyncHandler(async (req, res) => {
  const amountNaira = Number(req.body?.amountNaira);
  if (!Number.isSafeInteger(amountNaira) || amountNaira < 1 || amountNaira > 10_000_000) {
    return res.status(400).json({ message: 'Enter a valid whole-naira withdrawal amount.' });
  }
  const linkedBankId = req.body?.linkedBankId;
  if (!mongoose.isValidObjectId(linkedBankId)) {
    return res.status(400).json({ message: 'Choose a linked bank account.' });
  }
  const [partner, bank, policy] = await Promise.all([
    ConnectPartner.findOne({ userId: req.user._id, status: 'active' }),
    LinkedBankAccount.findOne({ _id: linkedBankId, userId: req.user._id }).select('_id bankName accountLast4'),
    getPolicy(),
  ]);
  if (!partner) return res.status(403).json({ message: 'An active Connect Partner account is required.' });
  if (!bank) return res.status(400).json({ message: 'Choose one of your linked bank accounts.' });
  if (amountNaira < policy.minimumPayoutNaira) {
    return res.status(400).json({ message: `The minimum withdrawal is ₦${policy.minimumPayoutNaira.toLocaleString()}.` });
  }

  const session = await mongoose.startSession();
  let payout;
  try {
    await session.withTransaction(async () => {
      const partnerUpdate = await ConnectPartner.updateOne(
        { _id: partner._id, status: 'active' },
        { $inc: { payoutRevision: 1 } },
        { session },
      );
      if (partnerUpdate.matchedCount !== 1) throw messageError(403, 'An active Connect Partner account is required.');
      const availableBalanceKobo = await getBalance(partner._id, session);
      if (amountNaira * 100 > availableBalanceKobo) {
        throw messageError(400, 'The requested amount exceeds your available Connect earnings.');
      }
      [payout] = await ConnectPayout.create([{
        partnerId: partner._id,
        userId: req.user._id,
        linkedBankId: bank._id,
        bankName: bank.bankName,
        accountLast4: bank.accountLast4,
        amountKobo: amountNaira * 100,
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  return res.status(201).json({
    payout: { id: payout._id, amountNaira, status: payout.status, createdAt: payout.createdAt },
  });
});

const listAdminApplications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req);
  const filter = {};
  if (APPLICATION_TYPES.includes(req.query.type)) filter.type = req.query.type;
  if (APPLICATION_STATUSES.includes(req.query.status)) filter.status = req.query.status;
  const [applications, total] = await Promise.all([
    ConnectApplication.find(filter)
      .populate('userId', 'name email phone')
      .populate('opportunityId', 'title type')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ConnectApplication.countDocuments(filter),
  ]);
  return res.json({
    applications: applications.map((application) => ({
      ...application,
      documents: (application.documents || []).map((document) => ({
        _id: document._id,
        name: document.name,
        format: document.format,
        bytes: document.bytes,
      })),
    })),
    page,
    limit,
    total,
  });
});

const getAdminOverview = asyncHandler(async (_req, res) => {
  const [
    totalApplications,
    pendingApplications,
    openOpportunities,
    unreadApplicantMessages,
    approvedAssociates,
    activePartners,
    totalReferrals,
    commissionTotals,
    payoutTotals,
  ] = await Promise.all([
    ConnectApplication.countDocuments(),
    ConnectApplication.countDocuments({ active: true }),
    ConnectOpportunity.countDocuments({ status: 'open' }),
    ConnectApplicationMessage.countDocuments({ senderRole: 'applicant', readAt: null }),
    ConnectAssociate.countDocuments({ status: 'active' }),
    ConnectPartner.countDocuments({ status: 'active' }),
    ConnectReferral.countDocuments(),
    ConnectCommission.aggregate([
      { $match: { status: { $in: ['pending', 'approved'] } } },
      { $group: { _id: '$status', amountKobo: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
    ]),
    ConnectPayout.aggregate([
      { $match: { status: { $in: ['pending', 'approved', ...ACTIVE_PAYOUT_STATUSES, 'paid'] } } },
      { $group: { _id: '$status', amountKobo: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
    ]),
  ]);
  const commissions = Object.fromEntries(commissionTotals.map((item) => [item._id, item]));
  const payouts = Object.fromEntries(payoutTotals.map((item) => [item._id, item]));
  return res.json({
    summary: {
      totalApplications,
      pendingApplications,
      openOpportunities,
      unreadApplicantMessages,
      approvedAssociates,
      activePartners,
      totalReferrals,
      pendingCommissionNaira: toNaira(commissions.pending?.amountKobo || 0),
      approvedCommissionNaira: toNaira(commissions.approved?.amountKobo || 0),
      pendingPayoutNaira: toNaira(payouts.pending?.amountKobo || 0),
      approvedPayoutNaira: toNaira(payouts.approved?.amountKobo || 0),
      processingPayoutNaira: toNaira(
        (payouts.processing?.amountKobo || 0) + (payouts.requires_otp?.amountKobo || 0),
      ),
      failedPayoutNaira: toNaira(
        (payouts.failed?.amountKobo || 0) + (payouts.reversed?.amountKobo || 0),
      ),
      paidPayoutNaira: toNaira(payouts.paid?.amountKobo || 0),
    },
  });
});

const listAdminAudit = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req);
  const [audit, total] = await Promise.all([
    ConnectAdminAudit.find()
      .populate('actorId', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ConnectAdminAudit.countDocuments(),
  ]);
  return res.json({ audit, page, limit, total });
});

function createPromoCode(name) {
  const prefix = String(name || 'PARTNER')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6) || 'PARTNER';
  return `KC-${prefix}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

const reviewApplication = asyncHandler(async (req, res) => {
  const { status, reviewNote = '', interviewAt = null, assignedRole = '' } = req.body || {};
  if (!['in_review', 'interview_scheduled', 'approved', 'rejected'].includes(status)
    || typeof reviewNote !== 'string'
    || reviewNote.length > 1000
    || typeof assignedRole !== 'string') {
    return res.status(400).json({ message: 'Choose a valid application decision.' });
  }
  if (status === 'interview_scheduled' && (!interviewAt || Number.isNaN(Date.parse(interviewAt)))) {
    return res.status(400).json({ message: 'Provide a valid interview date and time.' });
  }
  const application = await ConnectApplication.findById(req.params.applicationId)
    .populate('opportunityId', 'title');
  if (!application) return res.status(404).json({ message: 'Application not found.' });
  if (!application.active) return res.status(409).json({ message: 'This application has already been completed.' });
  const opportunityRole = application.opportunityId && application.type === 'applicant';
  const finalAssignedRole = opportunityRole ? (assignedRole.trim() || application.roleInterest) : assignedRole;
  if (status === 'approved' && application.type === 'applicant'
    && (opportunityRole
      ? finalAssignedRole !== application.roleInterest
      : !APPLICATION_ROLES.includes(finalAssignedRole))) {
    return res.status(400).json({ message: 'Assign a valid role before approving an applicant.' });
  }

  const session = await mongoose.startSession();
  let reviewedApplication;
  try {
    await session.withTransaction(async () => {
      if (status === 'approved') {
        const user = await User.findById(application.userId).select('name').session(session);
        if (application.type === 'partner') {
          let created = false;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              await ConnectPartner.create([{
                userId: application.userId,
                applicationId: application._id,
                promoCode: createPromoCode(user?.name),
              }], { session });
              created = true;
              break;
            } catch (error) {
              if (error.code === 11000 && attempt < 3) continue;
              if (error.code === 11000) {
                throw messageError(409, 'A partner profile already exists or a promo code could not be generated.');
              }
              throw error;
            }
          }
          if (!created) throw messageError(500, 'Partner profile could not be created.');
        } else {
          await ConnectAssociate.create([{
            userId: application.userId,
            applicationId: application._id,
            assignedRole,
          }], { session });
        }
      }
      reviewedApplication = await ConnectApplication.findOneAndUpdate(
        { _id: application._id, active: true },
        {
          $set: {
            status,
            active: !['approved', 'rejected'].includes(status),
            reviewNote: reviewNote.trim(),
            assignedRole: status === 'approved' && application.type === 'applicant' ? finalAssignedRole : '',
            interviewAt: status === 'interview_scheduled' ? new Date(interviewAt) : null,
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
          },
        },
        { new: true, runValidators: true, session },
      );
      if (!reviewedApplication) throw messageError(409, 'This application has already been completed.');
      await ConnectAdminAudit.create([{
        actorId: req.user._id,
        action: 'application_reviewed',
        entityType: 'application',
        entityId: reviewedApplication._id,
        details: { status, reviewNote: reviewedApplication.reviewNote, assignedRole: reviewedApplication.assignedRole },
      }], { session });
      await Notification.create([{
        userId: application.userId,
        title: 'Your Kalma Connect application was updated',
        message: `Your ${application.opportunityId?.title ? `${application.opportunityId.title} ` : ''}${application.type === 'partner' ? 'Connect Partner' : 'talent'} application is now ${status.replaceAll('_', ' ')}.${reviewedApplication.reviewNote ? ` ${reviewedApplication.reviewNote}` : ''}`.slice(0, 500),
        category: 'System',
        type: status === 'approved' ? 'success' : status === 'rejected' ? 'warning' : 'info',
        icon: 'briefcase',
        color: status === 'rejected' ? 'orange' : 'green',
        connectApplicationId: application._id,
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  return res.json({ application: applicationToClient(reviewedApplication) });
});

const listAdminPartners = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req);
  const filter = {};
  if (['active', 'suspended'].includes(req.query.status)) filter.status = req.query.status;
  const [partners, total] = await Promise.all([
    ConnectPartner.find(filter)
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ConnectPartner.countDocuments(filter),
  ]);
  const partnerIds = partners.map((partner) => partner._id);
  const [referralCounts, commissionTotals] = await Promise.all([
    ConnectReferral.aggregate([{ $match: { partnerId: { $in: partnerIds } } }, { $group: { _id: '$partnerId', count: { $sum: 1 } } }]),
    ConnectCommission.aggregate([
      { $match: { partnerId: { $in: partnerIds } } },
      { $group: { _id: { partnerId: '$partnerId', status: '$status' }, amountKobo: { $sum: '$amountKobo' } } },
    ]),
  ]);
  const referralsByPartner = new Map(referralCounts.map((item) => [String(item._id), item.count]));
  const commissionsByPartner = new Map();
  commissionTotals.forEach((item) => {
    const key = String(item._id.partnerId);
    const current = commissionsByPartner.get(key) || {};
    current[item._id.status] = toNaira(item.amountKobo);
    commissionsByPartner.set(key, current);
  });
  return res.json({
    partners: partners.map((partner) => ({
      ...partner,
      referralCount: referralsByPartner.get(String(partner._id)) || 0,
      earnings: commissionsByPartner.get(String(partner._id)) || {},
    })),
    page,
    limit,
    total,
  });
});

const updatePartnerStatus = asyncHandler(async (req, res) => {
  const { status, note = '' } = req.body || {};
  if (!['active', 'suspended'].includes(status) || typeof note !== 'string' || note.length > 500) {
    return res.status(400).json({ message: 'Choose a valid partner account status.' });
  }
  const partner = await ConnectPartner.findByIdAndUpdate(
    req.params.partnerId,
    { $set: { status, statusNote: note.trim(), statusUpdatedBy: req.user._id } },
    { new: true, runValidators: true },
  );
  if (!partner) return res.status(404).json({ message: 'Connect Partner not found.' });
  await ConnectAdminAudit.create({
    actorId: req.user._id,
    action: 'partner_status_changed',
    entityType: 'partner',
    entityId: partner._id,
    details: { status, note: partner.statusNote },
  });
  return res.json({ partner: { id: partner._id, status: partner.status, statusNote: partner.statusNote } });
});

const listAdminCommissions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req);
  const filter = {};
  if (['pending', 'approved', 'rejected'].includes(req.query.status)) filter.status = req.query.status;
  const [commissions, total] = await Promise.all([
    ConnectCommission.find(filter)
      .populate({ path: 'partnerId', select: 'promoCode userId', populate: { path: 'userId', select: 'name email' } })
      .populate({
        path: 'referralId',
        select: 'registeredAt referredUserId',
        populate: { path: 'referredUserId', select: 'name email' },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ConnectCommission.countDocuments(filter),
  ]);
  return res.json({
    commissions: commissions.map((commission) => ({ ...commission, amountNaira: toNaira(commission.amountKobo) })),
    page,
    limit,
    total,
  });
});

const reviewCommission = asyncHandler(async (req, res) => {
  const { status, reviewNote = '' } = req.body || {};
  if (!['approved', 'rejected'].includes(status) || typeof reviewNote !== 'string' || reviewNote.length > 500) {
    return res.status(400).json({ message: 'Choose a valid commission decision.' });
  }
  const commission = await ConnectCommission.findOne({ _id: req.params.commissionId, status: 'pending' });
  if (!commission) return res.status(404).json({ message: 'Pending commission not found.' });
  const partner = await ConnectPartner.findById(commission.partnerId).select('userId');
  if (!partner) throw messageError(409, 'The commission partner profile no longer exists.');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (status === 'approved' && ['first_deposit', 'active_saver'].includes(commission.type)) {
        const sourceIds = commission.sourceTransactionIds || [];
        const successfulSources = await WalletTransaction.countDocuments({
          _id: { $in: sourceIds },
          type: 'deposit',
          status: 'successful',
        }).session(session);
        if (!sourceIds.length || successfulSources !== sourceIds.length) {
          throw messageError(409, 'A qualifying deposit has been refunded or reversed, so this commission cannot be approved.');
        }
      }
      const updated = await ConnectCommission.findOneAndUpdate(
        { _id: commission._id, status: 'pending' },
        {
          $set: {
            status,
            reviewNote: reviewNote.trim(),
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
          },
        },
        { new: true, runValidators: true, session },
      );
      if (!updated) throw messageError(409, 'This commission was already reviewed.');
      Object.assign(commission, updated.toObject());
      if (status === 'rejected') {
        await releaseCommissionReservation(commission, session);
      }
      await ConnectAdminAudit.create([{
        actorId: req.user._id,
        action: 'commission_reviewed',
        entityType: 'commission',
        entityId: commission._id,
        details: { status, reviewNote: commission.reviewNote },
      }], { session });
      await Notification.create([{
        userId: partner.userId,
        title: 'Your Connect earnings were reviewed',
        message: `Your ${commission.type.replaceAll('_', ' ')} commission was ${status}.${commission.reviewNote ? ` ${commission.reviewNote}` : ''}`,
        category: 'System',
        type: status === 'approved' ? 'success' : 'warning',
        icon: 'wallet',
        color: status === 'approved' ? 'green' : 'orange',
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  return res.json({ commission: { id: commission._id, status: commission.status } });
});

const listAdminPayouts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req);
  const filter = {};
  if (['pending', 'approved', 'processing', 'requires_otp', 'rejected', 'paid', 'failed', 'reversed'].includes(req.query.status)) {
    filter.status = req.query.status;
  }
  const [payouts, total] = await Promise.all([
    ConnectPayout.find(filter)
      .populate('userId', 'name email phone')
      .populate('partnerId', 'promoCode')
      .populate('linkedBankId', 'bankName accountName accountLast4')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ConnectPayout.countDocuments(filter),
  ]);
  return res.json({
    payouts: payouts.map((payout) => ({ ...payout, amountNaira: toNaira(payout.amountKobo) })),
    page,
    limit,
    total,
  });
});

const reviewPayout = asyncHandler(async (req, res) => {
  const { status, reviewNote = '', paymentReference = '' } = req.body || {};
  if (!['approved', 'rejected', 'paid'].includes(status)
    || typeof reviewNote !== 'string'
    || reviewNote.length > 500
    || typeof paymentReference !== 'string'
    || paymentReference.length > 120) {
    return res.status(400).json({ message: 'Choose a valid payout decision.' });
  }
  const payout = await ConnectPayout.findById(req.params.payoutId);
  if (!payout) return res.status(404).json({ message: 'Withdrawal request not found.' });
  if (status === 'paid') {
    if (payout.status !== 'approved' || payout.transferReference || !paymentReference.trim()) {
      return res.status(409).json({ message: 'Only a previously approved legacy withdrawal with a confirmed external payment can be recorded as paid.' });
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await ConnectPayout.findOneAndUpdate(
          {
            _id: payout._id,
            status: 'approved',
            transferReference: { $in: [null, ''] },
          },
          {
            $set: {
              status: 'paid',
              reviewNote: reviewNote.trim(),
              paymentReference: paymentReference.trim(),
              reviewedBy: req.user._id,
              reviewedAt: new Date(),
              paidAt: new Date(),
            },
          },
          { new: true, runValidators: true, session },
        );
        if (!updated) throw messageError(409, 'This legacy withdrawal was already updated.');
        Object.assign(payout, updated.toObject());
        await ConnectAdminAudit.create([{
          actorId: req.user._id,
          action: 'payout_reviewed',
          entityType: 'payout',
          entityId: payout._id,
          details: { status: 'paid', paymentReference: payout.paymentReference, legacyManualPayment: true },
        }], { session });
        await Notification.create([{
          userId: payout.userId,
          title: 'Your Connect withdrawal was updated',
          message: `Your previously approved Connect withdrawal was recorded as paid. Payment reference: ${payout.paymentReference}.`,
          category: 'System',
          type: 'success',
          icon: 'wallet',
          color: 'green',
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    return res.json({ payout: { id: payout._id, status: payout.status } });
  }
  if (status === 'rejected' && payout.status !== 'pending') {
    return res.status(409).json({ message: `A ${payout.status} withdrawal cannot be rejected.` });
  }

  if (status === 'approved') {
    if (payout.status !== 'pending') {
      return res.status(409).json({ message: `A ${payout.status} withdrawal cannot be approved and paid again.` });
    }
    const bank = await LinkedBankAccount.findOne({
      _id: payout.linkedBankId,
      userId: payout.userId,
    }).select('+recipientCode');
    if (!bank?.recipientCode) {
      return res.status(409).json({ message: "The partner's linked Paystack bank recipient is unavailable. Ask them to relink their bank account." });
    }

    const transferReference = payout.transferReference || `KALMA_CONNECT_${crypto.randomUUID()}`;
    const session = await mongoose.startSession();
    let processingPayout;
    try {
      await session.withTransaction(async () => {
        processingPayout = await ConnectPayout.findOneAndUpdate(
          { _id: payout._id, status: 'pending' },
          {
            $set: {
              status: 'processing',
              reviewNote: reviewNote.trim(),
              reviewedBy: req.user._id,
              reviewedAt: new Date(),
              transferReference,
              transferStartedAt: new Date(),
              transferStatus: 'pending',
              transferError: '',
            },
          },
          { new: true, runValidators: true, session },
        );
        if (!processingPayout) throw messageError(409, 'This withdrawal was already reviewed or submitted to Paystack.');

        await ConnectAdminAudit.create([{
          actorId: req.user._id,
          action: 'payout_reviewed',
          entityType: 'payout',
          entityId: payout._id,
          details: {
            status: 'processing',
            reviewNote: reviewNote.trim(),
            transferReference,
          },
        }], { session });
        await Notification.create([{
          userId: payout.userId,
          title: 'Your Connect withdrawal was approved',
          message: 'Your withdrawal was approved and is being sent to Paystack. We will notify you when the transfer is confirmed.',
          category: 'System',
          type: 'info',
          icon: 'wallet',
          color: 'blue',
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    let transfer;
    try {
      transfer = await paystackRequest('/transfer', {
        method: 'POST',
        body: JSON.stringify({
          source: 'balance',
          amount: processingPayout.amountKobo,
          recipient: bank.recipientCode,
          reason: 'Kalma Connect partner withdrawal',
          reference: transferReference,
        }),
      });
      if (!transfer.transfer_code) throw new Error('Paystack did not return a transfer confirmation.');
    } catch (error) {
      await ConnectPayout.updateOne(
        { _id: payout._id, status: 'processing' },
        { $set: { transferError: 'Paystack did not confirm the transfer request. Check the Paystack status before taking further action.' } },
      );
      return res.status(error.status === 503 ? 503 : 502).json({
        message: 'The withdrawal approval was recorded, but Paystack did not confirm the transfer request. The amount remains reserved. Check Paystack status before retrying or paying manually.',
      });
    }

    const statusAfterSubmission = transfer.status === 'otp' ? 'requires_otp' : 'processing';
    await ConnectPayout.updateOne(
      { _id: payout._id, status: 'processing' },
      {
        $set: {
          status: statusAfterSubmission,
          transferCode: transfer.transfer_code,
          transferStatus: transfer.status || 'pending',
          transferError: '',
        },
      },
    );
    const latestPayout = await ConnectPayout.findById(payout._id).select('status').lean();
    return res.json({
      payout: { id: payout._id, status: latestPayout?.status || statusAfterSubmission },
      message: statusAfterSubmission === 'requires_otp'
        ? 'Paystack requires an OTP confirmation. Enter the code in the admin withdrawal screen.'
        : 'Withdrawal submitted to Paystack. It will be marked paid after Paystack confirms the transfer.',
    });
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const updated = await ConnectPayout.findOneAndUpdate(
        { _id: payout._id, status: 'pending' },
        {
          $set: {
            status,
            reviewNote: reviewNote.trim(),
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
          },
        },
        { new: true, runValidators: true, session },
      );
      if (!updated) throw messageError(409, 'This withdrawal was already updated.');
      Object.assign(payout, updated.toObject());
      await ConnectAdminAudit.create([{
        actorId: req.user._id,
        action: 'payout_reviewed',
        entityType: 'payout',
        entityId: payout._id,
        details: { status, reviewNote: payout.reviewNote },
      }], { session });
      await Notification.create([{
        userId: payout.userId,
        title: 'Your Connect withdrawal was updated',
        message: `Your ${toNaira(payout.amountKobo).toLocaleString('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 })} withdrawal was rejected.${payout.reviewNote ? ` ${payout.reviewNote}` : ''}`,
        category: 'System',
        type: 'warning',
        icon: 'wallet',
        color: 'orange',
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  return res.json({ payout: { id: payout._id, status: payout.status } });
});

const submitPayoutTransferOtp = asyncHandler(async (req, res) => {
  const { otp } = req.body || {};
  if (typeof otp !== 'string' || !/^\d{4,10}$/.test(otp)) {
    return res.status(400).json({ message: 'Enter the numeric OTP supplied by Paystack.' });
  }
  const payout = await ConnectPayout.findById(req.params.payoutId).select('+transferCode');
  if (!payout || payout.status !== 'requires_otp' || !payout.transferCode) {
    return res.status(409).json({ message: 'This withdrawal is not awaiting a Paystack OTP.' });
  }
  const transfer = await paystackRequest('/transfer/finalize_transfer', {
    method: 'POST',
    body: JSON.stringify({ transfer_code: payout.transferCode, otp }),
  });
  const transferStatus = transfer.status || 'pending';
  await ConnectPayout.updateOne(
    { _id: payout._id, status: 'requires_otp' },
    {
      $set: {
        status: transferStatus === 'otp' ? 'requires_otp' : 'processing',
        transferStatus,
        transferError: '',
      },
    },
  );
  await ConnectAdminAudit.create({
    actorId: req.user._id,
    action: 'payout_transfer_otp_submitted',
    entityType: 'payout',
    entityId: payout._id,
    details: { transferReference: payout.transferReference },
  });
  const latestPayout = await ConnectPayout.findById(payout._id).select('status').lean();
  return res.json({
    payout: { id: payout._id, status: latestPayout?.status || 'processing' },
    message: 'Paystack accepted the OTP. The transfer will be marked paid after confirmation.',
  });
});

const reconcilePayoutTransfer = asyncHandler(async (req, res) => {
  const payout = await ConnectPayout.findById(req.params.payoutId).select('+transferCode');
  if (!payout || !payout.transferReference) {
    return res.status(404).json({ message: 'Paystack transfer reference not found.' });
  }
  if (payout.status !== 'processing') {
    return res.status(409).json({ message: `A ${payout.status} withdrawal cannot be reconciled.` });
  }

  let transfer;
  try {
    transfer = await paystackRequest(`/transfer/verify/${encodeURIComponent(payout.transferReference)}`);
  } catch (error) {
    if (error.providerStatus === 404) {
      await updateConnectPayoutTransfer(
        payout.transferReference,
        'failed',
        'Paystack could not find the transfer. The reserved amount is available again.',
      );
      return res.json({
        payout: { id: payout._id, status: 'failed' },
        message: 'Paystack confirmed there is no transfer for this reference. The amount is available again; a new request can be submitted.',
      });
    }
    throw error;
  }

  const mappedStatus = providerStatusToPayoutStatus(transfer.status);
  if (!mappedStatus) {
    return res.status(502).json({ message: 'Paystack returned an unrecognized transfer status. The withdrawal remains reserved.' });
  }
  if (['paid', 'failed', 'reversed'].includes(mappedStatus)) {
    await updateConnectPayoutTransfer(
      payout.transferReference,
      transfer.status,
      transfer.failure_reason || '',
    );
  } else {
    await ConnectPayout.updateOne(
      { _id: payout._id, status: 'processing' },
      {
        $set: {
          status: mappedStatus,
          transferStatus: String(transfer.status).toLowerCase(),
          ...(transfer.transfer_code ? { transferCode: transfer.transfer_code } : {}),
          transferError: '',
        },
      },
    );
  }
  const latestPayout = await ConnectPayout.findById(payout._id).select('status').lean();
  return res.json({
    payout: { id: payout._id, status: latestPayout?.status || mappedStatus },
    message: 'Paystack transfer status refreshed.',
  });
});

const getAdminPolicy = asyncHandler(async (_req, res) => {
  const policy = await getPolicy();
  return res.json({
    policy: {
      registrationRewardNaira: policy.registrationRewardNaira,
      kycRewardNaira: policy.kycRewardNaira,
      firstDepositRewardNaira: policy.firstDepositRewardNaira,
      activeSaverBonusNaira: policy.activeSaverBonusNaira,
      milestoneRewardsEnabled: policy.milestoneRewardsEnabled,
      minimumPayoutNaira: policy.minimumPayoutNaira,
      rewardsMayBeEnabled: process.env.CONNECT_COMMISSION_POLICY_APPROVED === 'true',
      maxPerReferralNaira: MAX_REFERRAL_REWARD_NAIRA,
    },
  });
});

const updateAdminPolicy = asyncHandler(async (req, res) => {
  const {
    registrationRewardNaira,
    kycRewardNaira,
    firstDepositRewardNaira,
    activeSaverBonusNaira,
    milestoneRewardsEnabled,
    minimumPayoutNaira,
  } = req.body || {};
  const rewardSchedule = {
    registrationRewardNaira,
    kycRewardNaira,
    firstDepositRewardNaira,
    activeSaverBonusNaira,
  };
  if (!isValidRewardSchedule(rewardSchedule)
    || !Number.isSafeInteger(minimumPayoutNaira)
    || minimumPayoutNaira < 1
    || minimumPayoutNaira > 10_000_000
    || typeof milestoneRewardsEnabled !== 'boolean') {
    return res.status(400).json({
      message: `Enter valid whole-naira amounts. The total reward schedule cannot exceed ₦${MAX_REFERRAL_REWARD_NAIRA} per referral.`,
    });
  }
  if (milestoneRewardsEnabled && process.env.CONNECT_COMMISSION_POLICY_APPROVED !== 'true') {
    return res.status(403).json({ message: 'Commission rewards cannot be enabled until the policy is approved and configured by the service operator.' });
  }
  const policy = await ConnectPolicy.findOneAndUpdate(
    { key: 'default' },
    {
      $set: {
        ...rewardSchedule,
        milestoneRewardsEnabled,
        minimumPayoutNaira,
        updatedBy: req.user._id,
      },
      $setOnInsert: { key: 'default' },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  await ConnectAdminAudit.create({
    actorId: req.user._id,
    action: 'policy_updated',
    entityType: 'policy',
    entityId: policy._id,
    details: { ...rewardSchedule, milestoneRewardsEnabled, minimumPayoutNaira },
  });
  return res.json({
    policy: {
      registrationRewardNaira: policy.registrationRewardNaira,
      kycRewardNaira: policy.kycRewardNaira,
      firstDepositRewardNaira: policy.firstDepositRewardNaira,
      activeSaverBonusNaira: policy.activeSaverBonusNaira,
      milestoneRewardsEnabled: policy.milestoneRewardsEnabled,
      minimumPayoutNaira: policy.minimumPayoutNaira,
      rewardsMayBeEnabled: process.env.CONNECT_COMMISSION_POLICY_APPROVED === 'true',
      maxPerReferralNaira: MAX_REFERRAL_REWARD_NAIRA,
    },
  });
});

module.exports = {
  getMyConnectSummary,
  createApplication,
  listMyReferrals,
  listMyCommissions,
  listMyPayouts,
  createPayoutRequest,
  getAdminOverview,
  listAdminAudit,
  listAdminApplications,
  reviewApplication,
  listAdminPartners,
  updatePartnerStatus,
  listAdminCommissions,
  reviewCommission,
  listAdminPayouts,
  reviewPayout,
  submitPayoutTransferOtp,
  reconcilePayoutTransfer,
  getAdminPolicy,
  updateAdminPolicy,
};
