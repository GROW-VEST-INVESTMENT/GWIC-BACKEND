const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const {
  createCoreSavingsPlan,
  getCoreSavings,
  liquidateCoreSavingsPlan,
} = require('../controllers/coreSavingsController');

const router = express.Router();

router.use(requireAuth);
router.get('/', getCoreSavings);
router.post('/plans', createCoreSavingsPlan);
router.post('/plans/:planId/liquidate', liquidateCoreSavingsPlan);

module.exports = router;
