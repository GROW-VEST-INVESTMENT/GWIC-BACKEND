const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const requireAdminOrigin = require('../middleware/requireAdminOrigin');
const {
  getOverview,
  getUserDetail,
  getWalletSummary,
  listAuditLogs,
  listSupportRequests,
  listTransactions,
  listUsers,
  listVerificationRequests,
  reviewVerification,
  updateSupportRequest,
} = require('../controllers/adminController');

const router = express.Router();

router.use(requireAuth, requireAdmin);
router.get('/overview', getOverview);
router.get('/users', listUsers);
router.get('/users/:userId', getUserDetail);
router.get('/transactions', listTransactions);
router.get('/operations/wallets', getWalletSummary);
router.get('/operations/verification-requests', listVerificationRequests);
router.patch('/operations/verification-requests/:requestId', requireAdminOrigin, reviewVerification);
router.get('/operations/support-requests', listSupportRequests);
router.patch('/operations/support-requests/:requestId', requireAdminOrigin, updateSupportRequest);
router.get('/operations/audit-logs', listAuditLogs);

module.exports = router;
