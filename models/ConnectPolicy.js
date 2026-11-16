const mongoose = require('mongoose');

const connectPolicySchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    registrationRewardNaira: { type: Number, default: 0, min: 0 },
    registrationRewardEnabled: { type: Boolean, default: false },
    minimumPayoutNaira: { type: Number, default: 1000, min: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('ConnectPolicy', connectPolicySchema);
