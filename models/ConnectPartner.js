const mongoose = require('mongoose');

const connectPartnerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectApplication', required: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true },
    promoCode: { type: String, required: true, uppercase: true, trim: true, unique: true },
    payoutRevision: { type: Number, default: 0 },
    statusNote: { type: String, trim: true, maxlength: 500, default: '' },
    statusUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('ConnectPartner', connectPartnerSchema);
