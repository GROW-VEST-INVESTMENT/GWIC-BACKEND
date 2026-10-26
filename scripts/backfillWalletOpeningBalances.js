require('dotenv').config();
const mongoose = require('mongoose');
const LedgerEntry = require('../models/LedgerEntry');
const Wallet = require('../models/Wallet');
const { createJournal } = require('../services/coreSavings');

async function backfillWallet(walletId) {
  const session = await mongoose.startSession();
  let adjusted = false;
  try {
    await session.withTransaction(async () => {
      const wallet = await Wallet.findById(walletId).session(session);
      if (!wallet) return;

      const totals = await LedgerEntry.aggregate([
        { $match: { userId: wallet.userId, accountCode: 'USER_WALLET' } },
        {
          $group: {
            _id: null,
            credits: {
              $sum: { $cond: [{ $eq: ['$entryType', 'CREDIT'] }, '$amountKobo', 0] },
            },
            debits: {
              $sum: { $cond: [{ $eq: ['$entryType', 'DEBIT'] }, '$amountKobo', 0] },
            },
          },
        },
      ]).session(session);
      const ledgerBalance = (totals[0]?.credits || 0) - (totals[0]?.debits || 0);
      const difference = wallet.balanceKobo - ledgerBalance;
      if (!Number.isSafeInteger(difference)) {
        throw new RangeError(`Wallet opening balance is outside the supported range for user ${wallet.userId}.`);
      }
      if (difference === 0) return;

      const amountKobo = Math.abs(difference);
      await createJournal({
        session,
        idempotencyKey: `wallet-opening:${wallet.userId}`,
        transactionType: 'OPENING_BALANCE',
        description: 'Opening wallet balance reconciliation.',
        timestamp: new Date(),
        postings: difference > 0
          ? [
            { userId: null, accountCode: 'OPENING_BALANCE_EQUITY', amountKobo, entryType: 'DEBIT' },
            { userId: wallet.userId, accountCode: 'USER_WALLET', amountKobo, entryType: 'CREDIT' },
          ]
          : [
            { userId: wallet.userId, accountCode: 'USER_WALLET', amountKobo, entryType: 'DEBIT' },
            { userId: null, accountCode: 'OPENING_BALANCE_EQUITY', amountKobo, entryType: 'CREDIT' },
          ],
      });
      adjusted = true;
    });
  } finally {
    await session.endSession();
  }
  return adjusted;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI must be configured to reconcile wallet opening balances.');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const wallets = await Wallet.find().select('_id').lean();
    let adjusted = 0;
    for (const wallet of wallets) {
      if (await backfillWallet(wallet._id)) adjusted += 1;
    }
    console.log(`Wallet opening balance reconciliation completed: ${adjusted} wallets adjusted.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('Wallet opening balance reconciliation failed:', error.name, error.message);
  process.exitCode = 1;
});
