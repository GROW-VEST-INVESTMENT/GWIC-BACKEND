const NameChangeRequest = require('../models/NameChangeRequest');

async function ensureNameChangeIndexes() {
  await NameChangeRequest.collection.createIndex(
    { userId: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_name_change_per_user' },
  );
  await NameChangeRequest.collection.createIndex({ createdAt: -1 });
}

module.exports = ensureNameChangeIndexes;
