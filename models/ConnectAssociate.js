const mongoose = require('mongoose');

const connectAssociateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectApplication', required: true, unique: true },
    assignedRole: { type: String, required: true, trim: true, maxlength: 120 },
    employeeId: { type: String, trim: true, maxlength: 32, default: null },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true },
  },
  { timestamps: true },
);

connectAssociateSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'string' } }, name: 'connect_associate_employee_id' },
);

module.exports = mongoose.model('ConnectAssociate', connectAssociateSchema);
