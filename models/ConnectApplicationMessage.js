const mongoose = require('mongoose');

const connectApplicationMessageSchema = new mongoose.Schema(
  {
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectApplication', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: { type: String, enum: ['applicant', 'staff'], required: true },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

connectApplicationMessageSchema.index(
  { applicationId: 1, createdAt: 1 },
  { name: 'connect_application_message_history' },
);
connectApplicationMessageSchema.index(
  { applicationId: 1, senderRole: 1, readAt: 1 },
  { name: 'connect_application_message_unread' },
);

module.exports = mongoose.model('ConnectApplicationMessage', connectApplicationMessageSchema);
