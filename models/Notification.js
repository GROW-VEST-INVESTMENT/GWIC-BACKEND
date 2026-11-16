const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    category: { type: String, enum: ['Transactions', 'System', 'Promotions'], default: 'System' },
    type: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    icon: { type: String, default: 'chart' },
    color: { type: String, enum: ['green', 'pink', 'orange', 'blue'], default: 'green' },
    amount: { type: String, default: '' },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
