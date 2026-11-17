const ConnectApplication = require('../models/ConnectApplication');

const LEGACY_KEYS = { userId: 1, type: 1, active: 1 };
const ACTIVE_LEGACY_OPTIONS = {
  unique: true,
  partialFilterExpression: { active: true, opportunityId: null },
  name: 'active_legacy_connect_application',
};
const ACTIVE_OPPORTUNITY_OPTIONS = {
  unique: true,
  partialFilterExpression: { active: true, opportunityId: { $type: 'objectId' } },
  name: 'active_opportunity_connect_application',
};

async function ensureConnectApplicationIndexes() {
  let indexes = [];
  try {
    indexes = await ConnectApplication.collection.indexes();
  } catch (error) {
    if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error;
  }

  const legacyIndex = indexes.find((index) => (
    index.unique
    && JSON.stringify(index.key) === JSON.stringify(LEGACY_KEYS)
    && index.partialFilterExpression?.active === true
    && !Object.prototype.hasOwnProperty.call(index.partialFilterExpression, 'opportunityId')
  ));
  if (legacyIndex) {
    try {
      await ConnectApplication.collection.dropIndex(legacyIndex.name);
      console.log('Migrated the legacy Connect application index to support opportunity applications.');
    } catch (error) {
      if (error.code !== 27 && error.codeName !== 'IndexNotFound') throw error;
    }
  }

  await Promise.all([
    ConnectApplication.collection.createIndex(
      { userId: 1, type: 1, active: 1 },
      ACTIVE_LEGACY_OPTIONS,
    ),
    ConnectApplication.collection.createIndex(
      { userId: 1, opportunityId: 1, active: 1 },
      ACTIVE_OPPORTUNITY_OPTIONS,
    ),
  ]);
}

module.exports = ensureConnectApplicationIndexes;
