const mongoose = require('mongoose');

const connectOpportunitySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 5, maxlength: 120 },
    summary: { type: String, required: true, trim: true, minlength: 10, maxlength: 240 },
    description: { type: String, required: true, trim: true, minlength: 30, maxlength: 6000 },
    type: { type: String, enum: ['role', 'partner', 'announcement'], required: true },
    requirements: { type: String, trim: true, maxlength: 3000, default: '' },
    benefits: { type: String, trim: true, maxlength: 3000, default: '' },
    positionsAvailable: { type: Number, min: 0, max: 10000, default: 0 },
    maximumApplications: { type: Number, min: 0, max: 1000000, default: 0 },
    applicationCount: { type: Number, min: 0, default: 0 },
    deadline: { type: Date, default: null },
    status: { type: String, enum: ['draft', 'open', 'closed'], default: 'draft', required: true },
    publishedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

connectOpportunitySchema.index({ status:  1, publishedAt: -1 });
connectOpportunitySchema.index({ type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ConnectOpportunity', connectOpportunitySchema);
