const crypto = require('node:crypto');
const ConnectAssociate = require('../models/ConnectAssociate');
const ConnectIdCardRequest = require('../models/ConnectIdCardRequest');

async function ensureConnectIdCardIndexes() {
  const existingIssuedCards = await ConnectIdCardRequest.find({
    status: 'approved',
    $or: [{ verificationId: null }, { verificationId: { $exists: false } }],
  }).select('_id').lean();
  for (const card of existingIssuedCards) {
    await ConnectIdCardRequest.updateOne(
      { _id: card._id, status: 'approved', $or: [{ verificationId: null }, { verificationId: { $exists: false } }] },
      { $set: { verificationId: crypto.randomBytes(24).toString('hex') } },
    );
  }

  await Promise.all([
    ConnectAssociate.collection.createIndex(
      { employeeId: 1 },
      {
        unique: true,
        partialFilterExpression: { employeeId: { $type: 'string' } },
        name: 'connect_associate_employee_id',
      },
    ),
    ConnectIdCardRequest.collection.createIndex(
      { userId: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'pending' },
        name: 'one_pending_connect_id_card_per_user',
      },
    ),
    ConnectIdCardRequest.collection.createIndex(
      { verificationId: 1 },
      {
        unique: true,
        partialFilterExpression: { verificationId: { $type: 'string' } },
        name: 'connect_id_card_verification_id',
      },
    ),
  ]);
}

module.exports = ensureConnectIdCardIndexes;
