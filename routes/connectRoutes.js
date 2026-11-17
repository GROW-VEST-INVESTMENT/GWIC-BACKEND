const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireConnectOrigin = require('../middleware/requireConnectOrigin');
const { applicationDocumentUpload } = require('../services/connectApplicationDocuments');
const opportunityController = require('../controllers/connectOpportunityController');
const communicationController = require('../controllers/connectCommunicationController');
const {
  getMyConnectSummary,
  createApplication,
  listMyReferrals,
  claimReferralCode,
  listMyCommissions,
  listMyPayouts,
  createPayoutRequest,
} = require('../controllers/connectController');

const router = express.Router();
const requireAppOrigin = requireConnectOrigin([process.env.CONNECT_APP_URL]);

router.use(requireAuth);
router.get('/me', getMyConnectSummary);
router.get('/opportunities', opportunityController.listOpportunities);
router.put('/opportunities/:opportunityId/reaction', requireAppOrigin, communicationController.setOpportunityReaction);
router.delete('/opportunities/:opportunityId/reaction', requireAppOrigin, communicationController.removeOpportunityReaction);
router.put('/opportunities/:opportunityId/interest', requireAppOrigin, opportunityController.addOpportunityInterest);
router.delete('/opportunities/:opportunityId/interest', requireAppOrigin, opportunityController.removeOpportunityInterest);
router.get('/inbox', communicationController.listApplicantInbox);
router.get('/applications/:applicationId/messages', communicationController.listApplicantMessages);
router.post('/applications/:applicationId/messages', requireAppOrigin, communicationController.sendApplicantMessage);
router.post(
  '/opportunities/:opportunityId/applications',
  requireAppOrigin,
  applicationDocumentUpload.array('documents', 5),
  opportunityController.createOpportunityApplication,
);
router.get(
  '/applications/:applicationId/documents/:documentId',
  opportunityController.getMyApplicationDocument,
);
router.get('/referrals', listMyReferrals);
router.get('/commissions', listMyCommissions);
router.get('/payouts', listMyPayouts);
router.post('/applications', requireAppOrigin, createApplication);
router.post('/referrals/claim', requireAppOrigin, claimReferralCode);
router.post('/payouts', requireAppOrigin, createPayoutRequest);

module.exports = router;
