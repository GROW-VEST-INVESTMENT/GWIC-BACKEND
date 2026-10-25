const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const {
  getWallet,
  getBanks,
  initializeDeposit,
  verifyDeposit,
  createWithdrawal,
} = require('../controllers/walletController');

const router = express.Router();

router.use(requireAuth);
router.get('/', getWallet);
router.get('/banks', getBanks);
router.post('/deposits', initializeDeposit);
router.post('/deposits/verify', verifyDeposit);
router.post('/withdrawals', createWithdrawal);

module.exports = router;
