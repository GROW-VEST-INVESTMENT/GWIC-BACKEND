const Wallet = require('../models/Wallet');

async function getOrCreateWallet(userId, session) {
  let query = Wallet.findOne({ userId });
  if (session) query = query.session(session);
  let wallet = await query;
  if (!wallet) {
    [wallet] = await Wallet.create([{ userId, balanceKobo: 0 }], session ? { session } : {});
  }
  return wallet;
}

module.exports = { getOrCreateWallet };
