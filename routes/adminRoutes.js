const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const requireAdminOrigin = require('../middleware/requireAdminOrigin');
const {
  listDepositReviews,
  reviewDeposit,
} = require('../controllers/walletController');
const {
  getOverview,
  getTransactionTierPolicy,
  getUserDetail,
  getWalletSummary,
  listAuditLogs,
  listSupportRequests,
  listTransactions,
  listUsers,
  listVerificationRequests,
  listNameChangeRequests,
  reviewVerification,
  reviewNameChangeRequest,
  updateSupportRequest,
  updateAccountStatus,
  updateTransactionTierPolicy,
  updateUserTransactionTier,
  updateTransactionRestriction,
} = require('../controllers/adminController');

const router = express.Router();

router.use(requireAuth, requireAdmin);
router.get('/overview', getOverview);
router.get('/users', listUsers);
router.get('/users/:userId', getUserDetail);
router.patch('/users/:userId/transaction-tier', requireAdminOrigin, updateUserTransactionTier);
router.patch('/users/:userId/account-status', requireAdminOrigin, updateAccountStatus);
router.patch('/users/:userId/transaction-restriction', requireAdminOrigin, updateTransactionRestriction);
router.get('/transactions', listTransactions);
router.get('/operations/wallets', getWalletSummary);
router.get('/operations/transaction-tiers', getTransactionTierPolicy);
router.put('/operations/transaction-tiers', requireAdminOrigin, updateTransactionTierPolicy);
router.get('/operations/deposit-reviews', listDepositReviews);
router.patch('/operations/deposit-reviews/:reference', requireAdminOrigin, reviewDeposit);
router.get('/operations/verification-requests', listVerificationRequests);
router.patch('/operations/verification-requests/:requestId', requireAdminOrigin, reviewVerification);
router.get('/operations/name-change-requests', listNameChangeRequests);
router.patch('/operations/name-change-requests/:requestId', requireAdminOrigin, reviewNameChangeRequest);
router.get('/operations/support-requests', listSupportRequests);
router.patch('/operations/support-requests/:requestId', requireAdminOrigin, updateSupportRequest);
router.get('/operations/audit-logs', listAuditLogs);

module.exports = router;
