const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireConnectAdmin = require('../middleware/requireConnectAdmin');
const requireConnectOrigin = require('../middleware/requireConnectOrigin');
const {
  listAdminApplications,
  reviewApplication,
  listAdminPartners,
  updatePartnerStatus,
  listAdminCommissions,
  reviewCommission,
  listAdminPayouts,
  reviewPayout,
  getAdminPolicy,
  updateAdminPolicy,
  getAdminOverview,
  listAdminAudit,
} = require('../controllers/connectController');

const router = express.Router();
const requireAdminOrigin = requireConnectOrigin([
  process.env.CONNECT_ADMIN_URL,
  process.env.ADMIN_URL,
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ORIGINS || '').split(','),
]);

router.use(requireAuth, requireConnectAdmin);
router.get('/summary', getAdminOverview);
router.get('/audit', listAdminAudit);
router.get('/applications', listAdminApplications);
router.patch('/applications/:applicationId', requireAdminOrigin, reviewApplication);
router.get('/partners', listAdminPartners);
router.patch('/partners/:partnerId', requireAdminOrigin, updatePartnerStatus);
router.get('/commissions', listAdminCommissions);
router.patch('/commissions/:commissionId', requireAdminOrigin, reviewCommission);
router.get('/payouts', listAdminPayouts);
router.patch('/payouts/:payoutId', requireAdminOrigin, reviewPayout);
router.get('/policy', getAdminPolicy);
router.patch('/policy', requireAdminOrigin, updateAdminPolicy);

module.exports = router;
