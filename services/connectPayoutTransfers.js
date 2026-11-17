const mongoose = require('mongoose');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectPayout = require('../models/ConnectPayout');
const Notification = require('../models/Notification');

const ACTIVE_PAYOUT_STATUSES = ['processing', 'requires_otp'];

function providerStatusToPayoutStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'success':
    case 'successful':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'otp':
      return 'requires_otp';
    case 'pending':
    case 'processing':
      return 'processing';
    default:
      return null;
  }
}

async function updateConnectPayoutTransfer(reference, providerStatus, providerMessage = '') {
  const status = providerStatusToPayoutStatus(providerStatus);
  if (!reference || !status) return null;
  const failureMessage = typeof providerMessage === 'string' ? providerMessage.slice(0, 500) : '';

  const session = await mongoose.startSession();
  let updatedPayout = null;
  try {
    await session.withTransaction(async () => {
      const allowedStatuses = status === 'reversed'
        ? [...ACTIVE_PAYOUT_STATUSES, 'paid']
        : ACTIVE_PAYOUT_STATUSES;
      const now = new Date();
      const update = {
        $set: {
          status,
          transferStatus: String(providerStatus).toLowerCase(),
          ...(status === 'paid' ? { paidAt: now, paymentReference: reference } : {}),
          ...(status === 'reversed' ? { reversedAt: now } : {}),
          ...(['failed', 'reversed'].includes(status)
            ? { transferError: failureMessage || `Paystack transfer ${status}.` }
            : {}),
        },
        ...(status === 'paid' ? { $unset: { transferError: 1 } } : {}),
      };
      updatedPayout = await ConnectPayout.findOneAndUpdate(
        { transferReference: reference, status: { $in: allowedStatuses } },
        update,
        { new: true, runValidators: true, session },
      );
      if (!updatedPayout) return;

      const action = {
        paid: 'payout_transfer_succeeded',
        failed: 'payout_transfer_failed',
        reversed: 'payout_transfer_reversed',
      }[status];
      if (!action) return;

      const payoutAmount = (updatedPayout.amountKobo / 100).toLocaleString('en-NG', {
        style: 'currency',
        currency: 'NGN',
        maximumFractionDigits: 0,
      });
      const message = {
        paid: `Your ${payoutAmount} Connect withdrawal was sent to Paystack and confirmed.`,
        failed: `Paystack could not complete your ${payoutAmount} Connect withdrawal. The amount is available again.`,
        reversed: `Paystack reversed your ${payoutAmount} Connect withdrawal. The amount is available again.`,
      }[status];
      await ConnectAdminAudit.create([{
        actorId: null,
        action,
        entityType: 'payout',
        entityId: updatedPayout._id,
        details: { status, transferReference: reference },
      }], { session });
      await Notification.create([{
        userId: updatedPayout.userId,
        title: status === 'paid' ? 'Connect withdrawal paid' : 'Connect withdrawal update',
        message,
        category: 'System',
        type: status === 'paid' ? 'success' : 'error',
        icon: 'wallet',
        color: status === 'paid' ? 'green' : 'orange',
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  return updatedPayout;
}

function handleConnectPayoutWebhook(event) {
  const statuses = {
    'transfer.success': 'success',
    'transfer.failed': 'failed',
    'transfer.reversed': 'reversed',
  };
  const status = statuses[event?.event];
  const reference = event?.data?.reference;
  if (!status || typeof reference !== 'string') return Promise.resolve(null);
  return updateConnectPayoutTransfer(reference, status, event.data?.failure_reason || '');
}

module.exports = {
  ACTIVE_PAYOUT_STATUSES,
  handleConnectPayoutWebhook,
  providerStatusToPayoutStatus,
  updateConnectPayoutTransfer,
};
