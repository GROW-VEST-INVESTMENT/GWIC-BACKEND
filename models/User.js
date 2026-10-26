const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const GOALS = [
  'Emergency savings',
  'Rent or housing',
  'Education',
  'Business capital',
  'A major purchase',
  'I’m still exploring',
];

const PRODUCTS = ['core-lock', 'equity-core', 'undecided'];

const accountPreferencesSchema = new mongoose.Schema(
  {
    hideWalletBalance: { type: Boolean, default: false },
    theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    language: { type: String, enum: ['en'], default: 'en' },
  },
  { _id: false },
);

const notificationPreferencesSchema = new mongoose.Schema(
  {
    emailAccountUpdates: { type: Boolean, default: true },
    emailSecurityAlerts: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: false },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 32, default: '' },
    goal: { type: String, required: true, enum: GOALS },
    product: { type: String, required: true, enum: PRODUCTS },
    isKycVerified: { type: Boolean, default: false, required: true },
    accountPreferences: { type: accountPreferencesSchema, default: () => ({}) },
    notificationPreferences: { type: notificationPreferencesSchema, default: () => ({}) },
    bankAccountsVersion: { type: Number, default: 0, select: false },
    profilePhotoPublicId: { type: String, default: null, select: false },
    profilePhotoVersion: { type: Number, default: null, select: false },
    passwordHash: { type: String, required: true, select: false },
    sessionVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

userSchema.pre('save', async function hashPassword() {
  if (this.isModified('passwordHash')) {
    this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  }
});

const User = mongoose.model('User', userSchema);

module.exports = User;
module.exports.GOALS = GOALS;
module.exports.PRODUCTS = PRODUCTS;
