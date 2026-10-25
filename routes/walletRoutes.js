const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const {
  getWallet,
  getWalletTransactions,
  getBanks,
  initializeDeposit,
  verifyDeposit,
  resolveWithdrawalAccount,
  createWithdrawal,
} = require('../controllers/walletController');

const router = express.Router();

router.use(requireAuth);
router.get('/transactions', getWalletTransactions);
router.get('/', getWallet);
router.get('/banks', getBanks);
router.post('/deposits', initializeDeposit);
router.post('/deposits/verify', verifyDeposit);
router.post('/withdrawals/resolve', resolveWithdrawalAccount);
router.post('/withdrawals', createWithdrawal);

module.exports = router;
