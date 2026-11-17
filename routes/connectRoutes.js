const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireConnectOrigin = require('../middleware/requireConnectOrigin');
const { applicationDocumentUpload } = require('../services/connectApplicationDocuments');
const { privateImageUpload } = require('../services/connectPrivateImages');
const opportunityController = require('../controllers/connectOpportunityController');
const communicationController = require('../controllers/connectCommunicationController');
const idCardController = require('../controllers/connectIdCardController');
const {
  getMyConnectSummary,
  createApplication,
  listMyReferrals,
  listMyCommissions,
  listMyPayouts,
  createPayoutRequest,
} = require('../controllers/connectController');

const router = express.Router();
const requireAppOrigin = requireConnectOrigin([process.env.CONNECT_APP_URL]);

router.get('/id-cards/verify/:verificationId', idCardController.verifyIssuedIdCard);
router.use(requireAuth);
router.get('/me', getMyConnectSummary);
router.get('/opportunities', opportunityController.listOpportunities);
router.put('/opportunities/:opportunityId/reaction', requireAppOrigin, communicationController.setOpportunityReaction);
router.delete('/opportunities/:opportunityId/reaction', requireAppOrigin, communicationController.removeOpportunityReaction);
router.put('/opportunities/:opportunityId/interest', requireAppOrigin, opportunityController.addOpportunityInterest);
router.delete('/opportunities/:opportunityId/interest', requireAppOrigin, opportunityController.removeOpportunityInterest);
router.get('/inbox', communicationController.listApplicantInbox);
router.get('/applications/:applicationId/messages', communicationController.listApplicantMessages);
router.post(
  '/applications/:applicationId/messages',
  requireAppOrigin,
  privateImageUpload('images', { maxFiles: 3 }),
  communicationController.sendApplicantMessage,
);
router.get(
  '/applications/:applicationId/messages/:messageId/attachments/:attachmentId',
  communicationController.getApplicantMessageAttachment,
);
router.get('/id-card', idCardController.getMyIdCard);
router.get('/id-cards/:requestId/photo', idCardController.getMyIdCardPhoto);
router.post(
  '/id-card',
  requireAppOrigin,
  privateImageUpload('photo', { maxFiles: 1, maxBytes: 2 * 1024 * 1024 }),
  idCardController.submitIdCardRequest,
);
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
router.post('/payouts', requireAppOrigin, createPayoutRequest);

module.exports = router;
