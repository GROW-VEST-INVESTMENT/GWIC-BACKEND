const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const LinkedBankAccount = require('../models/LinkedBankAccount');
const VerificationRequest = require('../models/VerificationRequest');
const SupportRequest = require('../models/SupportRequest');
const { paystackRequest } = require('../services/paystack');
const {
  deleteProfilePhoto,
  getProfilePhotoUrl,
  isConfigured,
  uploadProfilePhoto,
} = require('../services/profilePhotoStorage');
const { normalizeAccountName } = require('./walletController');

const NOTIFICATION_FIELDS = ['emailAccountUpdates', 'emailSecurityAlerts', 'pushNotifications'];
const PREFERENCE_FIELDS = ['hideWalletBalance', 'theme', 'language'];
const VALID_THEMES = ['system', 'light', 'dark'];
const SUPPORT_CATEGORIES = ['account', 'verification', 'payments', 'technical', 'other'];

function sendError(res, status, message) {
  return res.status(status).json({ message });
}

function accountFingerprint(userId, bankCode, accountNumber) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`${userId}:${bankCode}:${accountNumber}`)
    .digest('hex');
}

function serializeBank(account) {
  return {
    id: account._id.toString(),
    bankCode: account.bankCode,
    bankName: account.bankName,
    accountName: account.accountName,
    accountLast4: account.accountLast4,
    isDefault: account.isDefault,
    createdAt: account.createdAt,
  };
}

function serializeSupportRequest(request) {
  return {
    reference: request.reference,
    category: request.category,
    subject: request.subject,
    message: request.message,
    status: request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    resolvedAt: request.resolvedAt,
  };
}

function detectImageFormat(buffer) {
  if (buffer?.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer?.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function serializeProfile(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    isKycVerified: user.isKycVerified,
    createdAt: user.createdAt,
    photoUrl: getProfilePhotoUrl(user.profilePhotoPublicId, user.profilePhotoVersion),
    photoUploadAvailable: isConfigured(),
  };
}

async function getProfile(req, res, next) {
  try {
    const user = await User.findById(req.user.id)
      .select('name email phone isKycVerified createdAt +profilePhotoPublicId +profilePhotoVersion');
    if (!user) return sendError(res, 404, 'Account not found.');
    return res.json({ profile: serializeProfile(user) });
  } catch (error) {
    return next(error);
  }
}

async function updateProfile(req, res, next) {
  const body = req.body || {};
  if (Object.hasOwn(body, 'name')) {
    return sendError(res, 400, 'Your account name cannot be changed here. Contact support to request a correction.');
  }
  if (Object.keys(body).some((key) => key !== 'phone')) {
    return sendError(res, 400, 'Only your phone number can be updated here. Contact support to request a name correction.');
  }
  if (!Object.keys(body).length) return sendError(res, 400, 'Provide a phone number to update.');

  const updates = {};
  if (Object.hasOwn(body, 'phone')) {
    if (
      typeof body.phone !== 'string'
      || body.phone.trim().length > 32
      || (body.phone.trim() && !/^\+?[0-9\s()-]{7,32}$/.test(body.phone.trim()))
    ) {
      return sendError(res, 400, 'Enter a valid phone number.');
    }
    updates.phone = body.phone.trim();
  }

  try {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, runValidators: true },
    ).select('name email phone isKycVerified createdAt +profilePhotoPublicId +profilePhotoVersion');
    if (!user) return sendError(res, 404, 'Account not found.');
    return res.json({
      message: 'Your profile has been updated.',
      profile: serializeProfile(user),
    });
  } catch (error) {
    return next(error);
  }
}

async function uploadAccountPhoto(req, res, next) {
  if (!req.file) return sendError(res, 400, 'Choose a PNG, JPEG, or WebP photo under 2 MB.');
  const actualFormat = detectImageFormat(req.file.buffer);
  const expectedFormat = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[req.file.mimetype];
  if (!actualFormat || actualFormat !== expectedFormat) {
    return sendError(res, 415, 'This file is not a supported image. Choose a PNG, JPEG, or WebP photo.');
  }
  if (!isConfigured()) return sendError(res, 503, 'Profile photo uploads are not available yet. Please try again later.');

  let uploaded;
  try {
    const user = await User.findById(req.user.id).select('+profilePhotoPublicId +profilePhotoVersion');
    if (!user) return sendError(res, 404, 'Account not found.');
    uploaded = await uploadProfilePhoto(req.file.buffer, `${req.user.id}-${crypto.randomUUID()}`);
    if (!uploaded?.public_id || !Number.isSafeInteger(uploaded.version)) {
      const error = new Error('Cloudinary did not confirm the profile photo upload.');
      error.status = 502;
      throw error;
    }
    const previousPublicId = user.profilePhotoPublicId;
    user.profilePhotoPublicId = uploaded.public_id;
    user.profilePhotoVersion = uploaded.version;
    await user.save();

    if (previousPublicId) {
      try {
        await deleteProfilePhoto(previousPublicId);
      } catch (cleanupError) {
        console.error('Unable to remove the replaced profile photo from Cloudinary:', cleanupError.message);
      }
    }
    return res.json({
      message: 'Your profile photo has been updated.',
      photoUrl: getProfilePhotoUrl(user.profilePhotoPublicId, user.profilePhotoVersion),
    });
  } catch (error) {
    if (uploaded?.public_id) {
      try {
        await deleteProfilePhoto(uploaded.public_id);
      } catch (cleanupError) {
        console.error('Unable to clean up an unused profile photo from Cloudinary:', cleanupError.message);
      }
    }
    return next(error);
  }
}

async function removeAccountPhoto(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('+profilePhotoPublicId +profilePhotoVersion');
    if (!user) return sendError(res, 404, 'Account not found.');
    if (!user.profilePhotoPublicId) return res.json({ message: 'There is no profile photo to remove.' });
    if (!isConfigured()) return sendError(res, 503, 'Profile photo storage is temporarily unavailable. Please try again later.');

    const previousPublicId = user.profilePhotoPublicId;
    user.profilePhotoPublicId = null;
    user.profilePhotoVersion = null;
    await user.save();
    try {
      await deleteProfilePhoto(previousPublicId);
    } catch (cleanupError) {
      console.error('Unable to remove profile photo from Cloudinary:', cleanupError.message);
      return res.json({
        message: 'Your photo was removed from your account. Deletion of the stored image is still pending.',
      });
    }
    return res.json({ message: 'Your profile photo has been removed.' });
  } catch (error) {
    return next(error);
  }
}

async function getPreferences(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('accountPreferences');
    if (!user) return sendError(res, 404, 'Account not found.');
    return res.json({ preferences: user.accountPreferences.toObject() });
  } catch (error) {
    return next(error);
  }
}

async function updatePreferences(req, res, next) {
  const body = req.body || {};
  if (!Object.keys(body).length || Object.keys(body).some((key) => !PREFERENCE_FIELDS.includes(key))) {
    return sendError(res, 400, 'Provide one or more supported account preferences.');
  }
  if (Object.hasOwn(body, 'hideWalletBalance') && typeof body.hideWalletBalance !== 'boolean') {
    return sendError(res, 400, 'hideWalletBalance must be true or false.');
  }
  if (Object.hasOwn(body, 'theme') && !VALID_THEMES.includes(body.theme)) {
    return sendError(res, 400, 'Choose system, light, or dark appearance.');
  }
  if (Object.hasOwn(body, 'language') && body.language !== 'en') {
    return sendError(res, 400, 'English is the only supported language at this time.');
  }

  const updates = Object.fromEntries(
    Object.entries(body).map(([key, value]) => [`accountPreferences.${key}`, value]),
  );
  try {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, runValidators: true },
    ).select('accountPreferences');
    if (!user) return sendError(res, 404, 'Account not found.');
    return res.json({ message: 'Your preferences have been saved.', preferences: user.accountPreferences.toObject() });
  } catch (error) {
    return next(error);
  }
}

async function getNotificationPreferences(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('notificationPreferences');
    if (!user) return sendError(res, 404, 'Account not found.');
    return res.json({
      preferences: user.notificationPreferences.toObject(),
      delivery: { email: false, push: false },
      message: 'Your choices are saved. Notification delivery will be available when GWIC connects its messaging providers.',
    });
  } catch (error) {
    return next(error);
  }
}

async function updateNotificationPreferences(req, res, next) {
  const body = req.body || {};
  if (!Object.keys(body).length || Object.keys(body).some((key) => !NOTIFICATION_FIELDS.includes(key))) {
    return sendError(res, 400, 'Provide one or more supported notification preferences.');
  }
  if (Object.values(body).some((value) => typeof value !== 'boolean')) {
    return sendError(res, 400, 'Notification preferences must be true or false.');
  }

  const updates = Object.fromEntries(
    Object.entries(body).map(([key, value]) => [`notificationPreferences.${key}`, value]),
  );
  try {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, runValidators: true },
    ).select('notificationPreferences');
    if (!user) return sendError(res, 404, 'Account not found.');
    return res.json({
      message: 'Your notification preferences have been saved.',
      preferences: user.notificationPreferences.toObject(),
      delivery: { email: false, push: false },
    });
  } catch (error) {
    return next(error);
  }
}

async function changePassword(req, res, next) {
  const { currentPassword, newPassword } = req.body || {};
  if (
    typeof currentPassword !== 'string'
    || !currentPassword
    || Buffer.byteLength(currentPassword, 'utf8') > 72
    || typeof newPassword !== 'string'
    || newPassword.length < 8
    || Buffer.byteLength(newPassword, 'utf8') > 72
  ) {
    return sendError(res, 400, 'Enter your current password and a new password of at least 8 characters.');
  }
  if (currentPassword === newPassword) {
    return sendError(res, 400, 'Choose a new password that is different from your current password.');
  }

  try {
    const user = await User.findById(req.user.id).select('+passwordHash sessionVersion');
    if (!user) return sendError(res, 404, 'Account not found.');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return sendError(res, 403, 'Your current password could not be confirmed.');
    }
    user.passwordHash = newPassword;
    user.sessionVersion += 1;
    await user.save();
    res.clearCookie('gwic_session', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
    });
    return res.json({ message: 'Your password has been changed. Please sign in again.' });
  } catch (error) {
    return next(error);
  }
}

async function getVerificationStatus(req, res, next) {
  try {
    const [user, request] = await Promise.all([
      User.findById(req.user.id).select('isKycVerified'),
      VerificationRequest.findOne({ userId: req.user.id }).sort({ createdAt: -1 }).lean(),
    ]);
    if (!user) return sendError(res, 404, 'Account not found.');
    return res.json({
      status: user.isKycVerified ? 'verified' : request?.status || 'not_started',
      request: request ? {
        id: request._id.toString(),
        legalName: request.legalName,
        status: request.status,
        createdAt: request.createdAt,
        reviewedAt: request.reviewedAt,
      } : null,
      canSubmit: !user.isKycVerified && request?.status !== 'pending',
      method: 'manual_review',
      notice: 'Do not submit BVN, passwords, or identity-document numbers here. Staff review this request separately; submitting it does not verify your account.',
    });
  } catch (error) {
    return next(error);
  }
}

async function createVerificationRequest(req, res, next) {
  const body = req.body || {};
  const { legalName, dateOfBirth, consent } = body;
  if (Object.keys(body).some((key) => !['legalName', 'dateOfBirth', 'consent'].includes(key))) {
    return sendError(res, 400, 'Only legal name, date of birth, and consent are accepted. Do not submit BVN or identity-document numbers.');
  }
  if (
    typeof legalName !== 'string'
    || legalName.trim().length < 2
    || legalName.trim().length > 100
    || typeof dateOfBirth !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)
    || consent !== true
  ) {
    return sendError(res, 400, 'Enter your legal name and date of birth, then confirm your consent.');
  }
  const birthDate = new Date(`${dateOfBirth}T00:00:00.000Z`);
  if (
    Number.isNaN(birthDate.getTime())
    || birthDate.toISOString().slice(0, 10) !== dateOfBirth
    || birthDate >= new Date()
  ) {
    return sendError(res, 400, 'Enter a valid date of birth.');
  }

  try {
    const user = await User.findById(req.user.id).select('name isKycVerified');
    if (!user) return sendError(res, 404, 'Account not found.');
    if (user.isKycVerified) return sendError(res, 409, 'Your account is already verified.');
    const existing = await VerificationRequest.findOne({ userId: req.user.id, status: 'pending' }).lean();
    if (existing) return sendError(res, 409, 'Your verification request is already awaiting review.');
    const request = await VerificationRequest.create({
      userId: req.user.id,
      legalName: legalName.trim().replace(/\s+/g, ' '),
      dateOfBirth: birthDate,
      consentedAt: new Date(),
    });
    return res.status(201).json({
      message: 'Your verification request was recorded and is awaiting manual review.',
      status: request.status,
      requestId: request.id,
    });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'Your verification request is already awaiting review.');
    return next(error);
  }
}

async function getLinkedBanks(req, res, next) {
  try {
    const banks = await LinkedBankAccount.find({ userId: req.user.id })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();
    return res.json({ banks: banks.map(serializeBank) });
  } catch (error) {
    return next(error);
  }
}

async function createLinkedBank(req, res, next) {
  const { accountNumber, bankCode, password } = req.body || {};
  if (
    typeof accountNumber !== 'string'
    || !/^\d{10}$/.test(accountNumber)
    || typeof bankCode !== 'string'
    || !/^[A-Za-z0-9_-]{2,20}$/.test(bankCode)
    || typeof password !== 'string'
    || !password
    || Buffer.byteLength(password, 'utf8') > 72
  ) {
    return sendError(res, 400, 'Enter a valid 10-digit account number, bank, and password to confirm linking.');
  }

  try {
    const user = await User.findById(req.user.id).select('name +passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return sendError(res, 403, 'Your password could not be confirmed.');
    }
    const fingerprint = accountFingerprint(req.user.id, bankCode, accountNumber);
    const existing = await LinkedBankAccount.findOne({ userId: req.user.id, accountFingerprint: fingerprint }).lean();
    if (existing) return sendError(res, 409, 'This bank account is already linked.');
    if (await LinkedBankAccount.countDocuments({ userId: req.user.id }) >= 3) {
      return sendError(res, 409, 'You can link up to 3 bank accounts. Remove a linked account before adding another.');
    }

    const resolved = await paystackRequest(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    const accountName = resolved.account_name;
    if (
      typeof accountName !== 'string'
      || normalizeAccountName(accountName) !== normalizeAccountName(user.name)
    ) {
      return sendError(res, 422, 'The bank account holder name must match your GWIC profile name.');
    }
    const availableBanks = await paystackRequest('/bank?country=nigeria&use_cursor=false&perPage=100');
    const bank = availableBanks.find((item) => item.code === bankCode);
    if (!bank?.name) return sendError(res, 400, 'Choose a supported Nigerian bank.');

    const recipient = await paystackRequest('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({
        type: 'nuban',
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      }),
    });
    if (!recipient.recipient_code) throw new Error('Paystack did not return a bank recipient confirmation.');

    let linkedBank;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const accountCount = await LinkedBankAccount.countDocuments({ userId: req.user.id }).session(session);
        if (accountCount >= 3) {
          const error = new Error('You can link up to 3 bank accounts. Remove a linked account before adding another.');
          error.code = 'BANK_ACCOUNT_LIMIT';
          throw error;
        }
        const hasDefault = await LinkedBankAccount.exists({ userId: req.user.id, isDefault: true }).session(session);
        const lock = await User.updateOne(
          { _id: req.user.id },
          { $inc: { bankAccountsVersion: 1 } },
          { session },
        );
        if (!lock.matchedCount) {
          const error = new Error('Account not found.');
          error.status = 404;
          throw error;
        }
        [linkedBank] = await LinkedBankAccount.create([{
          userId: req.user.id,
          bankCode,
          bankName: bank.name,
          accountName,
          accountLast4: accountNumber.slice(-4),
          accountFingerprint: fingerprint,
          recipientCode: recipient.recipient_code,
          isDefault: !hasDefault,
        }], { session });
      });
    } catch (error) {
      try {
        await paystackRequest(`/transferrecipient/${encodeURIComponent(recipient.recipient_code)}`, { method: 'DELETE' });
      } catch (cleanupError) {
        console.error('Unable to remove unused Paystack recipient after bank-link failure:', cleanupError.message);
      }
      if (error.code === 'BANK_ACCOUNT_LIMIT') return sendError(res, 409, error.message);
      throw error;
    } finally {
      await session.endSession();
    }
    return res.status(201).json({ message: 'Your bank account has been verified and linked.', bank: serializeBank(linkedBank) });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'This bank account is already linked.');
    return next(error);
  }
}

async function setDefaultBank(req, res, next) {
  try {
    const bank = await LinkedBankAccount.findOne({ _id: req.params.bankId, userId: req.user.id });
    if (!bank) return sendError(res, 404, 'Linked bank account not found.');
    await LinkedBankAccount.updateMany({ userId: req.user.id }, { $set: { isDefault: false } });
    bank.isDefault = true;
    await bank.save();
    return res.json({ message: 'Your default bank account has been updated.', bank: serializeBank(bank) });
  } catch (error) {
    return next(error);
  }
}

async function deleteLinkedBank(req, res, next) {
  try {
    const bank = await LinkedBankAccount.findOne({ _id: req.params.bankId, userId: req.user.id })
      .select('+recipientCode');
    if (!bank) return sendError(res, 404, 'Linked bank account not found.');
    await paystackRequest(`/transferrecipient/${encodeURIComponent(bank.recipientCode)}`, { method: 'DELETE' });
    await bank.deleteOne();
    if (bank.isDefault) {
      const nextDefault = await LinkedBankAccount.findOne({ userId: req.user.id }).sort({ createdAt: -1 });
      if (nextDefault) {
        nextDefault.isDefault = true;
        await nextDefault.save();
      }
    }
    return res.json({ message: 'Your linked bank account has been removed.' });
  } catch (error) {
    return next(error);
  }
}

async function listSupportRequests(req, res, next) {
  try {
    const requests = await SupportRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return res.json({ requests: requests.map(serializeSupportRequest) });
  } catch (error) {
    return next(error);
  }
}

async function createSupportRequest(req, res, next) {
  const { category, subject, message } = req.body || {};
  if (
    !SUPPORT_CATEGORIES.includes(category)
    || typeof subject !== 'string'
    || subject.trim().length < 3
    || subject.trim().length > 120
    || typeof message !== 'string'
    || message.trim().length < 10
    || message.trim().length > 2000
  ) {
    return sendError(res, 400, 'Choose a topic and enter a subject and message (10–2,000 characters).');
  }
  try {
    const request = await SupportRequest.create({
      reference: `GWIC-SUP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      userId: req.user.id,
      category,
      subject: subject.trim(),
      message: message.trim(),
    });
    return res.status(201).json({
      message: 'Your support request was received.',
      request: serializeSupportRequest(request),
    });
  } catch (error) {
    return next(error);
  }
}

function getAbout(_req, res) {
  return res.json({
    name: 'Grow With Core',
    shortName: 'GWIC',
    description: 'Better habits. Stronger finances. A brighter future.',
    products: ['Core Lock', 'Equity Core'],
    support: { availableInApp: true },
  });
}

module.exports = {
  getProfile,
  updateProfile,
  uploadAccountPhoto,
  removeAccountPhoto,
  getPreferences,
  updatePreferences,
  getNotificationPreferences,
  updateNotificationPreferences,
  changePassword,
  getVerificationStatus,
  createVerificationRequest,
  getLinkedBanks,
  createLinkedBank,
  setDefaultBank,
  deleteLinkedBank,
  listSupportRequests,
  createSupportRequest,
  getAbout,
};
