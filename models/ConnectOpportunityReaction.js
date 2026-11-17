const mongoose = require('mongoose');

const connectOpportunityReactionSchema = new mongoose.Schema(
  {
    opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectOpportunity', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reaction: { type: String, enum: ['interested', 'love', 'exciting', 'applause'], required: true },
  },
  { timestamps: true },
);

connectOpportunityReactionSchema.index(
  { opportunityId: 1, userId: 1 },
  { unique: true, name: 'connect_opportunity_unique_user_reaction' },
);
connectOpportunityReactionSchema.index(
  { opportunityId: 1, reaction: 1 },
  { name: 'connect_opportunity_reaction_counts' },
);

module.exports = mongoose.model('ConnectOpportunityReaction', connectOpportunityReactionSchema);
