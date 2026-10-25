const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const { paystackRequest, verifyWebhookSignature } = require('../services/paystack');

const MINIMUM_KOBO = 10000;
const MAXIMUM_DEPOSIT_KOBO = 100000000;
const MINIMUM_WITHDRAWAL_KOBO = 10000;

function normalizeAccountName(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function getOrCreateWallet(userId, session) {
  let query = Wallet.findOne({ userId });
  if (session) query = query.session(session);
  let wallet = await query;
  if (!wallet) {
    [wallet] = await Wallet.create([{ userId, balanceKobo: 0 }], session ? { session } : {});
  }
  return wallet;
}

async function creditVerifiedDeposit(transaction) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await WalletTransaction.findById(transaction._id).session(session);
      if (!current || current.status === 'successful') return;
      if (current.status !== 'pending') return;

      const wallet = await getOrCreateWallet(current.userId, session);
      wallet.balanceKobo += current.amountKobo;
      await wallet.save({ session });
      current.status = 'successful';
      await current.save({ session });
    });
  } finally {
    await session.endSession();
  }
}

async function refundWithdrawal(transaction, status, reason = null) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await WalletTransaction.findById(transaction._id).session(session);
      if (!current || current.refundedAt || !['processing', 'requires_approval', 'successful'].includes(current.status)) return;
      const wallet = await getOrCreateWallet(current.userId, session);
      wallet.balanceKobo += current.amountKobo;
      await wallet.save({ session });
      current.status = status;
      current.failureReason = reason;
      current.refundedAt = new Date();
      await current.save({ session });
    });
  } finally {
    await session.endSession();
  }
}

async function verifyAndCreditDeposit(transaction) {
  const verified = await paystackRequest(`/transaction/verify/${encodeURIComponent(transaction.reference)}`);
  if (
    verified.status !== 'success'
    || verified.reference !== transaction.reference
    || verified.amount !== transaction.amountKobo
    || verified.currency !== 'NGN'
  ) {
    if (['failed', 'abandoned'].includes(verified.status)) {
      await WalletTransaction.updateOne(
        { _id: transaction._id, status: 'pending' },
        { $set: { status: 'failed', failureReason: 'Payment was not successful.' } },
      );
    }
    const error = new Error('Paystack could not confirm this deposit.');
    error.status = 409;
    throw error;
  }

  await creditVerifiedDeposit(transaction);
}

async function getWallet(req, res, next) {
  try {
    const [wallet, transactions] = await Promise.all([
      Wallet.findOne({ userId: req.user.id }).lean(),
      WalletTransaction.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('reference type amountKobo status bankName accountLast4 createdAt')
        .lean(),
    ]);
    return res.json({
      currency: 'NGN',
      balance: (wallet?.balanceKobo || 0) / 100,
      transactions: transactions.map((item) => ({
        reference: item.reference,
        type: item.type,
        amount: item.amountKobo / 100,
        status: item.status,
        bankName: item.bankName,
        accountLast4: item.accountLast4,
        createdAt: item.createdAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function getBanks(req, res, next) {
  try {
    const banks = await paystackRequest('/bank?country=nigeria&use_cursor=false&perPage=100');
    return res.json({
      banks: banks.map(({ name, code }) => ({ name, code })).filter((bank) => bank.name && bank.code),
    });
  } catch (error) {
    return next(error);
  }
}

async function initializeDeposit(req, res, next) {
  const amountNaira = req.body?.amount;
  if (!Number.isSafeInteger(amountNaira) || amountNaira * 100 < MINIMUM_KOBO || amountNaira * 100 > MAXIMUM_DEPOSIT_KOBO) {
    return res.status(400).json({ message: 'Deposit between ₦100 and ₦1,000,000.' });
  }
  if (!req.user.email) {
    return res.status(400).json({ message: 'Add an email address to your account before depositing.' });
  }

  let transaction;
  try {
    const reference = `GWIC_DEP_${crypto.randomUUID()}`;
    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
      return res.status(503).json({ message: 'Payment return address is not configured.' });
    }
    [transaction] = await WalletTransaction.create([{
      reference,
      userId: req.user.id,
      type: 'deposit',
      amountKobo: amountNaira * 100,
      status: 'pending',
    }]);
    const payment = await paystackRequest('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: req.user.email,
        amount: amountNaira * 100,
        currency: 'NGN',
        reference,
        callback_url: `${frontendUrl.replace(/\/+$/, '')}/dashboard?payment=paystack`,
        metadata: { user_id: req.user.id, purpose: 'wallet_deposit' },
      }),
    });
    transaction.authorizationUrl = payment.authorization_url;
    await transaction.save();
    return res.status(201).json({
      authorizationUrl: payment.authorization_url,
      reference,
    });
  } catch (error) {
    if (transaction && !transaction.authorizationUrl) {
      await WalletTransaction.updateOne(
        { _id: transaction._id, status: 'pending' },
        { $set: { status: 'failed', failureReason: 'Payment initialization failed.' } },
      );
    }
    return next(error);
  }
}

async function verifyDeposit(req, res, next) {
  const reference = typeof req.body?.reference === 'string' ? req.body.reference : '';
  try {
    const transaction = await WalletTransaction.findOne({
      reference,
      userId: req.user.id,
      type: 'deposit',
    });
    if (!transaction) return res.status(404).json({ message: 'Deposit reference was not found.' });
    if (transaction.status === 'successful') return res.json({ status: 'successful' });
    if (transaction.status !== 'pending') return res.status(409).json({ message: 'This deposit is no longer pending.' });

    await verifyAndCreditDeposit(transaction);
    return res.json({ status: 'successful' });
  } catch (error) {
    return next(error);
  }
}

async function createWithdrawal(req, res, next) {
  const { amount: amountNaira, accountNumber, bankCode } = req.body || {};
  if (
    !Number.isSafeInteger(amountNaira)
    || !Number.isSafeInteger(amountNaira * 100)
    || amountNaira * 100 < MINIMUM_WITHDRAWAL_KOBO
  ) {
    return res.status(400).json({ message: 'The minimum withdrawal is ₦100.' });
  }
  if (
    typeof accountNumber !== 'string'
    || !/^\d{10}$/.test(accountNumber)
    || typeof bankCode !== 'string'
    || !/^[A-Za-z0-9_-]{2,20}$/.test(bankCode)
  ) {
    return res.status(400).json({ message: 'Enter a valid Nigerian bank and 10-digit account number.' });
  }

  let transaction;
  let transferAttempted = false;
  try {
    const availableWallet = await Wallet.findOne({ userId: req.user.id }).select('balanceKobo').lean();
    if (!availableWallet || availableWallet.balanceKobo < amountNaira * 100) {
      return res.status(400).json({ message: 'Your available wallet balance is too low for this withdrawal.' });
    }

    const account = await paystackRequest(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    if (normalizeAccountName(account.account_name || '') !== normalizeAccountName(req.user.name)) {
      return res.status(422).json({
        message: 'The bank account holder name must match your GWIC profile name. No withdrawal was made.',
      });
    }

    const banks = await paystackRequest('/bank?country=nigeria&use_cursor=false&perPage=100');
    const bankName = banks.find((bank) => bank.code === bankCode)?.name || 'Bank account';
    const recipient = await paystackRequest('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({
        type: 'nuban',
        name: account.account_name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      }),
    });

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const wallet = await getOrCreateWallet(req.user.id, session);
        const amountKobo = amountNaira * 100;
        if (wallet.balanceKobo < amountKobo) {
          const error = new Error('Your available wallet balance is too low for this withdrawal.');
          error.status = 400;
          throw error;
        }
        wallet.balanceKobo -= amountKobo;
        await wallet.save({ session });
        [transaction] = await WalletTransaction.create([{
          reference: `GWIC_WD_${crypto.randomUUID()}`,
          userId: req.user.id,
          type: 'withdrawal',
          amountKobo,
          status: 'processing',
          recipientCode: recipient.recipient_code,
          accountName: account.account_name,
          bankName,
          accountLast4: accountNumber.slice(-4),
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    transferAttempted = true;
    const transfer = await paystackRequest('/transfer', {
      method: 'POST',
      body: JSON.stringify({
        source: 'balance',
        amount: transaction.amountKobo,
        recipient: recipient.recipient_code,
        reason: 'GWIC wallet withdrawal',
        reference: transaction.reference,
      }),
    });
    if (!transfer.transfer_code) {
      throw new Error('Paystack did not return a transfer confirmation.');
    }
    const transferStatus = transfer.status === 'otp' ? 'requires_approval' : 'processing';
    await WalletTransaction.updateOne(
      { _id: transaction._id, status: 'processing' },
      { $set: { transferCode: transfer.transfer_code, status: transferStatus } },
    );
    return res.status(202).json({
      message: transferStatus === 'requires_approval'
        ? 'Your wallet funds are reserved. Paystack requires approval from the account owner before this transfer can complete.'
        : 'Withdrawal submitted. Your wallet balance is reserved while Paystack processes the transfer.',
      reference: transaction.reference,
      status: transferStatus,
    });
  } catch (error) {
    if (transaction && (!transferAttempted || error.status === 400)) {
      await refundWithdrawal(transaction, 'failed', 'The transfer could not be started.');
    }
    if (transaction && transferAttempted && error.status !== 400) {
      return res.status(202).json({
        message: 'Paystack has not confirmed the transfer result yet. The amount remains reserved; do not submit another withdrawal.',
        reference: transaction.reference,
        status: 'processing',
      });
    }
    return next(error);
  }
}

async function handlePaystackWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];
  if (!verifyWebhookSignature(req.body, signature)) {
    return res.status(401).json({ message: 'Invalid webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Invalid webhook payload.' });
  }

  try {
    const reference = event.data?.reference;
    if (event.event === 'charge.success' && typeof reference === 'string') {
      const transaction = await WalletTransaction.findOne({ reference, type: 'deposit', status: 'pending' });
      if (transaction) await verifyAndCreditDeposit(transaction);
    }
    if (
      ['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event.event)
      && typeof reference === 'string'
    ) {
      const transaction = await WalletTransaction.findOne({ reference, type: 'withdrawal' });
      if (transaction) {
        if (event.event === 'transfer.success') {
          await WalletTransaction.updateOne(
            { _id: transaction._id, status: { $in: ['processing', 'requires_approval'] } },
            { $set: { status: 'successful' } },
          );
        } else {
          await refundWithdrawal(
            transaction,
            event.event === 'transfer.reversed' ? 'reversed' : 'failed',
            'Paystack could not complete the transfer.',
          );
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error('Paystack webhook processing failed:', error.name);
    return res.sendStatus(500);
  }
}

module.exports = {
  getWallet,
  getBanks,
  initializeDeposit,
  verifyDeposit,
  createWithdrawal,
  handlePaystackWebhook,
  normalizeAccountName,
};
