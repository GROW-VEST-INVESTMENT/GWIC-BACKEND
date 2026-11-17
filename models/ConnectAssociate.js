const mongoose = require('mongoose');

const connectAssociateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectApplication', required: true, unique: true },
    assignedRole: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('ConnectAssociate', connectAssociateSchema);
