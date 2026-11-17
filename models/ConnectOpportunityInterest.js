const mongoose = require('mongoose');

const connectOpportunityInterestSchema = new mongoose.Schema(
  {
    opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectOpportunity', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

connectOpportunityInterestSchema.index({ opportunityId: 1, userId: 1 }, { unique: true });
connectOpportunityInterestSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('ConnectOpportunityInterest', connectOpportunityInterestSchema);
