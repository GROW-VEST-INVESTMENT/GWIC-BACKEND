const mongoose = require('mongoose');

const connectApplicationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectOpportunity', default: null },
    type: { type: String, enum: ['applicant', 'partner'], required: true },
    status: {
      type: String,
      enum: ['pending', 'in_review', 'interview_scheduled', 'approved', 'rejected'],
      default: 'pending',
      required: true,
    },
    active: { type: Boolean, default: true },
    roleInterest: { type: String, trim: true, maxlength: 120, default: '' },
    assignedRole: { type: String, trim: true, maxlength: 120, default: '' },
    motivation: { type: String, required: true, trim: true, minlength: 30, maxlength: 2000 },
    experience: { type: String, trim: true, maxlength: 3000, default: '' },
    promotionChannels: {
      type: [{ type: String, enum: ['social_media', 'community', 'email', 'other'] }],
      default: [],
    },
    documents: {
      type: [{
        name: { type: String, required: true, maxlength: 180 },
        publicId: { type: String, required: true, maxlength: 240 },
        format: { type: String, required: true, enum: ['pdf', 'docx', 'jpg', 'png'] },
        mimeType: { type: String, required: true, maxlength: 100 },
        bytes: { type: Number, required: true, min: 1, max: 10485760 },
      }],
      default: [],
    },
    reviewNote: { type: String, trim: true, maxlength: 1000, default: '' },
    interviewAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

connectApplicationSchema.index(
  { userId: 1, type: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true, opportunityId: null }, name: 'active_legacy_connect_application' },
);
connectApplicationSchema.index(
  { userId: 1, opportunityId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true, opportunityId: { $type: 'objectId' } }, name: 'active_opportunity_connect_application' },
);
connectApplicationSchema.index({ opportunityId: 1, createdAt: -1 });
connectApplicationSchema.index({ type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ConnectApplication', connectApplicationSchema);
