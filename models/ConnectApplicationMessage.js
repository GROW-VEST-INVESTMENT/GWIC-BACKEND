const mongoose = require('mongoose');

const connectApplicationMessageSchema = new mongoose.Schema(
  {
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectApplication', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: { type: String, enum: ['applicant', 'staff'], required: true },
    body: { type: String, trim: true, maxlength: 2000, default: '' },
    attachments: {
      type: [{
        name: { type: String, required: true, maxlength: 120 },
        publicId: { type: String, required: true, maxlength: 240 },
        format: { type: String, required: true, enum: ['jpg', 'png', 'webp'] },
        mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
        bytes: { type: Number, required: true, min: 1, max: 5242880 },
      }],
      default: [],
      validate: {
        validator: (files) => files.length <= 3,
        message: 'A message can include up to three images.',
      },
    },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

connectApplicationMessageSchema.pre('validate', function validateMessageContent() {
  if (!this.body?.trim() && !this.attachments?.length) {
    this.invalidate('body', 'A message must contain text or at least one image.');
  }
});

connectApplicationMessageSchema.index(
  { applicationId: 1, createdAt: 1 },
  { name: 'connect_application_message_history' },
);
connectApplicationMessageSchema.index(
  { applicationId: 1, senderRole: 1, readAt: 1 },
  { name: 'connect_application_message_unread' },
);

module.exports = mongoose.model('ConnectApplicationMessage', connectApplicationMessageSchema);
