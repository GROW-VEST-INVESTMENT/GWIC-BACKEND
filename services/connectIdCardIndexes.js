const ConnectAssociate = require('../models/ConnectAssociate');
const ConnectIdCardRequest = require('../models/ConnectIdCardRequest');

async function ensureConnectIdCardIndexes() {
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
  ]);
}

module.exports = ensureConnectIdCardIndexes;
