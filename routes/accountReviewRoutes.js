const express = require('express');
const requireAccountReviewer = require('../middleware/requireAccountReviewer');
const {
  listVerifications,
  reviewVerification,
  listSupportRequests,
  updateSupportRequest,
} = require('../controllers/accountReviewController');

const router = express.Router();

router.use(requireAccountReviewer);
router.get('/verifications', listVerifications);
router.patch('/verifications/:requestId', reviewVerification);
router.get('/support', listSupportRequests);
router.patch('/support/:requestId', updateSupportRequest);

module.exports = router;
