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

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 32, default: '' },
    goal: { type: String, required: true, enum: GOALS },
    product: { type: String, required: true, enum: PRODUCTS },
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
