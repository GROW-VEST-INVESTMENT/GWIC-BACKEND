const mongoose = require('mongoose');

const connectReferralSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectPartner', required: true, index: true },
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['registered', 'active'], default: 'registered', required: true },
    registeredAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

connectReferralSchema.index({ referredUserId: 1 }, { unique: true });

module.exports = mongoose.model('ConnectReferral', connectReferralSchema);
