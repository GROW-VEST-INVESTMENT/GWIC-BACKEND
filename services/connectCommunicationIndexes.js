const ConnectApplicationMessage = require('../models/ConnectApplicationMessage');
const ConnectOpportunityReaction = require('../models/ConnectOpportunityReaction');

async function ensureConnectCommunicationIndexes() {
  await Promise.all([
    ConnectOpportunityReaction.collection.createIndex(
      { opportunityId: 1, userId: 1 },
      { unique: true, name: 'connect_opportunity_unique_user_reaction' },
    ),
    ConnectOpportunityReaction.collection.createIndex(
      { opportunityId: 1, reaction: 1 },
      { name: 'connect_opportunity_reaction_counts' },
    ),
    ConnectApplicationMessage.collection.createIndex(
      { applicationId: 1, createdAt: 1 },
      { name: 'connect_application_message_history' },
    ),
    ConnectApplicationMessage.collection.createIndex(
      { applicationId: 1, senderRole: 1, readAt: 1 },
      { name: 'connect_application_message_unread' },
    ),
  ]);
}

module.exports = ensureConnectCommunicationIndexes;
