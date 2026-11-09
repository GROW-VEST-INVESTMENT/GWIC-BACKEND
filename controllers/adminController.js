const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const InvestmentPlan = require('../models/InvestmentPlan');
const SavingsGoal = require('../models/SavingsGoal');
const SupportRequest = require('../models/SupportRequest');
const User = require('../models/User');
const VerificationRequest = require('../models/VerificationRequest');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');

const VERIFICATION_STATUSES = ['pending', 'verified', 'rejected'];
const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved'];
const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const formatTransaction = (transaction) => ({
  id: transaction.reference,
  reference: transaction.reference,
  user: transaction.userId?.name || 'Unknown user',
  email: transaction.userId?.email || '',
  type: transaction.type,
  amount: `₦${(transaction.amountKobo / 100).toLocaleString('en-NG')}`,
  amountValue: transaction.amountKobo / 100,
  status: transaction.status,
  createdAt: transaction.createdAt,
});

async function getOverview(_req, res, next) {
  try {
    const [
      totalUsers,
      activeUsers,
      adminUsers,
      pendingKyc,
      totalWalletBalance,
      recentTransactions,
      supportTickets,
      openSupportTickets,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: 'active' }),
      User.countDocuments({ role: { $in: ['admin', 'super_admin'] } }),
      VerificationRequest.countDocuments({ status: 'pending' }),
      Wallet.aggregate([{ $group: { _id: null, total: { $sum: '$balanceKobo' } } }]),
      WalletTransaction.find({}).sort({ createdAt: -1 }).limit(6).populate('userId', 'name email').lean(),
      SupportRequest.find({ status: { $in: ['open', 'in_progress'] } })
        .sort({ createdAt: -1 }).limit(6).populate('userId', 'name email').lean(),
      SupportRequest.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
    ]);

    return res.json({
      summary: {
        totalUsers,
        activeUsers,
        adminUsers,
        pendingKyc,
        walletBalance: (totalWalletBalance[0]?.total || 0) / 100,
        openSupportTickets,
      },
      transactions: recentTransactions.map(formatTransaction),
      supportTickets: supportTickets.map((ticket) => ({
        id: ticket.reference,
        customer: ticket.userId?.name || 'Unknown user',
        email: ticket.userId?.email || '',
        subject: ticket.subject,
        status: ticket.status,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function listUsers(_req, res, next) {
  try {
    const users = await User.find({})
      .sort({ createdAt: -1 })
      .select('name email role status transactionRestricted isKycVerified product')
      .lean();
    return res.json({
      users: users.map((user) => ({
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        status: user.status || 'active',
        transactionRestricted: user.transactionRestricted === true,
        kycVerified: user.isKycVerified === true,
        product: user.product,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function getUserDetail(req, res, next) {
  if (!isValidObjectId(req.params.userId)) {
    return res.status(400).json({ message: 'Invalid user ID.' });
  }

  try {
    const user = await User.findById(req.params.userId)
      .select('name email phone role status transactionRestricted transactionRestrictedAt +transactionRestrictionReason isKycVerified product goal createdAt')
      .lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const [wallet, transactions, verificationRequests, supportRequests, investmentPlans, savingsGoals] = await Promise.all([
      Wallet.findOne({ userId: user._id }).select('balanceKobo updatedAt').lean(),
      WalletTransaction.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('reference type amountKobo status createdAt')
        .lean(),
      VerificationRequest.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('status createdAt reviewedAt')
        .lean(),
      SupportRequest.find({ userId: user._id })
        .sort({ updatedAt: -1 })
        .limit(10)
        .select('reference category subject status createdAt updatedAt resolvedAt')
        .lean(),
      InvestmentPlan.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('productType principalKobo accruedYieldKobo status startDate maturityDate createdAt')
        .lean(),
      SavingsGoal.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('name targetAmount targetDate savedAmount createdAt')
        .lean(),
    ]);

    return res.json({
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        role: user.role || 'user',
        status: user.status || 'active',
        transactionRestricted: user.transactionRestricted === true,
        transactionRestrictionReason: user.transactionRestricted ? user.transactionRestrictionReason || '' : '',
        transactionRestrictedAt: user.transactionRestricted ? user.transactionRestrictedAt || null : null,
        kycVerified: user.isKycVerified === true,
        product: user.product,
        goal: user.goal,
        createdAt: user.createdAt,
      },
      wallet: wallet ? {
        balance: wallet.balanceKobo / 100,
        updatedAt: wallet.updatedAt,
      } : null,
      transactions: transactions.map((transaction) => ({
        reference: transaction.reference,
        type: transaction.type,
        amount: transaction.amountKobo / 100,
        status: transaction.status,
        createdAt: transaction.createdAt,
      })),
      verificationRequests: verificationRequests.map((request) => ({
        status: request.status,
        createdAt: request.createdAt,
        reviewedAt: request.reviewedAt,
      })),
      supportRequests: supportRequests.map((request) => ({
        reference: request.reference,
        category: request.category,
        subject: request.subject,
        status: request.status,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        resolvedAt: request.resolvedAt,
      })),
      investmentPlans: investmentPlans.map((plan) => ({
        productType: plan.productType,
        principal: plan.principalKobo / 100,
        accruedYield: plan.accruedYieldKobo / 100,
        status: plan.status,
        startDate: plan.startDate,
        maturityDate: plan.maturityDate,
      })),
      savingsGoals: savingsGoals.map((goal) => ({
        name: goal.name,
        targetAmount: goal.targetAmount,
        targetDate: goal.targetDate,
        savedAmount: goal.savedAmount,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateTransactionRestriction(req, res, next) {
  const { restricted, reason } = req.body || {};
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (typeof restricted !== 'boolean' || normalizedReason.length < 3 || normalizedReason.length > 500) {
    return res.status(400).json({
      message: 'Choose whether transaction access is restricted and provide a reason between 3 and 500 characters.',
    });
  }
  if (!isValidObjectId(req.params.userId)) {
    return res.status(400).json({ message: 'Invalid user ID.' });
  }

  const session = await mongoose.startSession();
  try {
    let updatedUser;
    await session.withTransaction(async () => {
      const user = await User.findById(req.params.userId).session(session);
      if (!user) {
        const error = new Error('User not found.');
        error.status = 404;
        throw error;
      }
      if (['admin', 'super_admin'].includes(user.role)) {
        const error = new Error('Transaction restrictions can only be applied to customer accounts.');
        error.status = 403;
        throw error;
      }

      const previousStatus = user.transactionRestricted ? 'restricted' : 'allowed';
      const nextStatus = restricted ? 'restricted' : 'allowed';
      if (previousStatus !== nextStatus) {
        user.transactionRestricted = restricted;
        user.transactionRestrictionReason = restricted ? normalizedReason : '';
        user.transactionRestrictedAt = restricted ? new Date() : null;
        await user.save({ session });
        await new AdminAuditLog({
          actorId: req.user.id,
          action: 'account.transaction_access_updated',
          targetType: 'user',
          targetId: user._id,
          previousStatus,
          nextStatus,
          note: normalizedReason,
        }).save({ session });
      }

      updatedUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        transactionRestricted: user.transactionRestricted === true,
        transactionRestrictionReason: user.transactionRestricted ? user.transactionRestrictionReason : '',
        transactionRestrictedAt: user.transactionRestricted ? user.transactionRestrictedAt : null,
      };
    });
    return res.json({
      message: restricted ? 'Transaction access restricted.' : 'Transaction access restored.',
      user: updatedUser,
    });
  } catch (error) {
    return next(error);
  } finally {
    await session.endSession();
  }
}

async function listTransactions(_req, res, next) {
  try {
    const transactions = await WalletTransaction.find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('userId', 'name email')
      .lean();
    return res.json({ transactions: transactions.map(formatTransaction) });
  } catch (error) {
    return next(error);
  }
}

async function getWalletSummary(_req, res, next) {
  try {
    const [summary, wallets] = await Promise.all([
      Wallet.aggregate([
        { $group: { _id: null, totalBalanceKobo: { $sum: '$balanceKobo' }, walletCount: { $sum: 1 } } },
      ]),
      Wallet.find({})
        .sort({ updatedAt: -1 })
        .limit(100)
        .populate('userId', 'name email')
        .lean(),
    ]);
    const totals = summary[0] || { totalBalanceKobo: 0, walletCount: 0 };
    return res.json({
      summary: {
        totalBalance: totals.totalBalanceKobo / 100,
        walletCount: totals.walletCount,
        recordsShown: wallets.length,
      },
      wallets: wallets.map((wallet) => ({
        id: wallet._id.toString(),
        user: wallet.userId?.name || 'Unknown user',
        email: wallet.userId?.email || '',
        balance: wallet.balanceKobo / 100,
        updatedAt: wallet.updatedAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function listVerificationRequests(req, res, next) {
  const status = req.query.status || 'pending';
  if (!['all', ...VERIFICATION_STATUSES].includes(status)) {
    return res.status(400).json({ message: 'Choose all, pending, verified, or rejected status.' });
  }

  try {
    const filter = status === 'all' ? {} : { status };
    const [requests, pending, verified, rejected] = await Promise.all([
      VerificationRequest.find(filter)
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('userId', 'name email phone')
        .lean(),
      VerificationRequest.countDocuments({ status: 'pending' }),
      VerificationRequest.countDocuments({ status: 'verified' }),
      VerificationRequest.countDocuments({ status: 'rejected' }),
    ]);
    return res.json({
      stats: { pending, verified, rejected },
      requests: requests.map((request) => ({
        id: request._id.toString(),
        user: request.userId ? {
          id: request.userId._id.toString(),
          name: request.userId.name,
          email: request.userId.email,
          phone: request.userId.phone,
        } : null,
        legalName: request.legalName,
        dateOfBirth: request.dateOfBirth,
        status: request.status,
        createdAt: request.createdAt,
        reviewedAt: request.reviewedAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function reviewVerification(req, res, next) {
  const { decision, note, evidenceReviewed } = req.body || {};
  const normalizedNote = typeof note === 'string' ? note.trim() : '';
  if (
    !['verified', 'rejected'].includes(decision)
    || normalizedNote.length < 3
    || normalizedNote.length > 500
    || evidenceReviewed !== true
  ) {
    return res.status(400).json({
      message: 'Choose verified or rejected, confirm evidence was reviewed, and provide a note between 3 and 500 characters.',
    });
  }
  if (!isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: 'Invalid verification request ID.' });
  }

  const session = await mongoose.startSession();
  try {
    let reviewed;
    await session.withTransaction(async () => {
      const request = await VerificationRequest.findOne({
        _id: req.params.requestId,
        status: 'pending',
      }).session(session);
      if (!request) {
        const error = new Error('Pending verification request not found.');
        error.status = 404;
        throw error;
      }

      const user = await User.findById(request.userId).session(session);
      if (!user) {
        const error = new Error('Account for this verification request was not found.');
        error.status = 404;
        throw error;
      }

      const previousStatus = request.status;
      request.status = decision;
      request.reviewedAt = new Date();
      request.reviewerNote = normalizedNote;
      user.isKycVerified = decision === 'verified';
      await request.save({ session });
      await user.save({ session });
      await new AdminAuditLog({
        actorId: req.user.id,
        action: 'kyc.reviewed',
        targetType: 'verification_request',
        targetId: request._id,
        previousStatus,
        nextStatus: decision,
        note: normalizedNote,
        evidenceReviewed: true,
      }).save({ session });
      reviewed = { id: request.id, status: request.status, reviewedAt: request.reviewedAt };
    });
    return res.json({ message: 'Verification review saved.', request: reviewed });
  } catch (error) {
    return next(error);
  } finally {
    await session.endSession();
  }
}

async function listSupportRequests(req, res, next) {
  const status = req.query.status || 'all';
  if (!['all', ...SUPPORT_STATUSES].includes(status)) {
    return res.status(400).json({ message: 'Choose all, open, in_progress, or resolved status.' });
  }

  try {
    const filter = status === 'all' ? {} : { status };
    const [requests, open, inProgress, resolved] = await Promise.all([
      SupportRequest.find(filter)
        .sort({ updatedAt: -1 })
        .limit(100)
        .populate('userId', 'name email phone')
        .lean(),
      SupportRequest.countDocuments({ status: 'open' }),
      SupportRequest.countDocuments({ status: 'in_progress' }),
      SupportRequest.countDocuments({ status: 'resolved' }),
    ]);
    return res.json({
      stats: { open, inProgress, resolved },
      requests: requests.map((request) => ({
        id: request._id.toString(),
        reference: request.reference,
        user: request.userId ? {
          id: request.userId._id.toString(),
          name: request.userId.name,
          email: request.userId.email,
          phone: request.userId.phone,
        } : null,
        category: request.category,
        subject: request.subject,
        message: request.message,
        status: request.status,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        resolvedAt: request.resolvedAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateSupportRequest(req, res, next) {
  const { status, note } = req.body || {};
  const normalizedNote = typeof note === 'string' ? note.trim() : '';
  if (!SUPPORT_STATUSES.includes(status) || normalizedNote.length < 3 || normalizedNote.length > 1000) {
    return res.status(400).json({ message: 'Choose a valid status and provide a note between 3 and 1,000 characters.' });
  }
  if (!isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: 'Invalid support request ID.' });
  }

  const session = await mongoose.startSession();
  try {
    let updated;
    await session.withTransaction(async () => {
      const request = await SupportRequest.findById(req.params.requestId).session(session);
      if (!request) {
        const error = new Error('Support request not found.');
        error.status = 404;
        throw error;
      }

      const previousStatus = request.status;
      request.status = status;
      request.staffNote = normalizedNote;
      request.resolvedAt = status === 'resolved' ? new Date() : null;
      await request.save({ session });
      await new AdminAuditLog({
        actorId: req.user.id,
        action: 'support.status_updated',
        targetType: 'support_request',
        targetId: request._id,
        previousStatus,
        nextStatus: status,
        note: normalizedNote,
      }).save({ session });
      updated = {
        id: request.id,
        reference: request.reference,
        status: request.status,
        updatedAt: request.updatedAt,
        resolvedAt: request.resolvedAt,
      };
    });
    return res.json({ message: 'Support request status updated.', request: updated });
  } catch (error) {
    return next(error);
  } finally {
    await session.endSession();
  }
}

async function listAuditLogs(_req, res, next) {
  try {
    const entries = await AdminAuditLog.find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('actorId', 'name email role')
      .lean();
    return res.json({
      entries: entries.map((entry) => ({
        id: entry._id.toString(),
        actor: entry.actorId ? {
          name: entry.actorId.name,
          email: entry.actorId.email,
          role: entry.actorId.role,
        } : null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId.toString(),
        previousStatus: entry.previousStatus,
        nextStatus: entry.nextStatus,
        note: entry.note,
        evidenceReviewed: entry.evidenceReviewed,
        createdAt: entry.createdAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getOverview,
  getUserDetail,
  getWalletSummary,
  listAuditLogs,
  listSupportRequests,
  listTransactions,
  listUsers,
  listVerificationRequests,
  reviewVerification,
  updateTransactionRestriction,
  updateSupportRequest,
};
