const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireTransactionAccess = require('../middleware/requireTransactionAccess');
const {
  createCoreSavingsPlan,
  getCoreSavings,
  liquidateCoreSavingsPlan,
} = require('../controllers/coreSavingsController');

const router = express.Router();

router.use(requireAuth);
router.get('/', getCoreSavings);
router.post('/plans', requireTransactionAccess, createCoreSavingsPlan);
router.post('/plans/:planId/liquidate', requireTransactionAccess, liquidateCoreSavingsPlan);

module.exports = router;
