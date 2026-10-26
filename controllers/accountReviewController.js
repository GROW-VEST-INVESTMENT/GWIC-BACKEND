const mongoose = require('mongoose');
const User = require('../models/User');
const VerificationRequest = require('../models/VerificationRequest');
const SupportRequest = require('../models/SupportRequest');

const REVIEW_STATUSES = ['pending', 'verified', 'rejected'];
const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved'];

async function listVerifications(req, res, next) {
  const status = req.query.status || 'pending';
  if (!REVIEW_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Choose pending, verified, or rejected status.' });
  }
  try {
    const requests = await VerificationRequest.find({ status })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate('userId', 'name email phone')
      .lean();
    return res.json({
      requests: requests.map((request) => ({
        id: request._id.toString(),
        user: request.userId ? {
          id: request.userId._id.toString(),
          name: request.userId.name,
          email: request.userId.email,
          phone: request.userId.phone,
        } : null,
        legalName: request.legalName,
        dateOfBirth: request.dateOfBirth,
        status: request.status,
        createdAt: request.createdAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function reviewVerification(req, res, next) {
  const { decision, note = '' } = req.body || {};
  if (!['verified', 'rejected'].includes(decision) || typeof note !== 'string' || note.length > 500) {
    return res.status(400).json({ message: 'Choose verified or rejected and provide an optional note up to 500 characters.' });
  }

  const session = await mongoose.startSession();
  try {
    let reviewed;
    await session.withTransaction(async () => {
      const request = await VerificationRequest.findOne({
        _id: req.params.requestId,
        status: 'pending',
      }).session(session);
      if (!request) {
        const error = new Error('Pending verification request not found.');
        error.status = 404;
        throw error;
      }
      const user = await User.findById(request.userId).session(session);
      if (!user) {
        const error = new Error('Account for this verification request was not found.');
        error.status = 404;
        throw error;
      }

      request.status = decision;
      request.reviewedAt = new Date();
      request.reviewerNote = note.trim();
      user.isKycVerified = decision === 'verified';
      await request.save({ session });
      await user.save({ session });
      reviewed = { id: request.id, status: request.status, reviewedAt: request.reviewedAt };
    });
    return res.json({ message: 'Verification review saved.', request: reviewed });
  } catch (error) {
    return next(error);
  } finally {
    await session.endSession();
  }
}

async function listSupportRequests(req, res, next) {
  const status = req.query.status || 'open';
  if (!SUPPORT_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Choose open, in_progress, or resolved status.' });
  }
  try {
    const requests = await SupportRequest.find({ status })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate('userId', 'name email phone')
      .lean();
    return res.json({
      requests: requests.map((request) => ({
        id: request._id.toString(),
        reference: request.reference,
        user: request.userId ? {
          id: request.userId._id.toString(),
          name: request.userId.name,
          email: request.userId.email,
          phone: request.userId.phone,
        } : null,
        category: request.category,
        subject: request.subject,
        message: request.message,
        status: request.status,
        createdAt: request.createdAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateSupportRequest(req, res, next) {
  const { status, note = '' } = req.body || {};
  if (!SUPPORT_STATUSES.includes(status) || typeof note !== 'string' || note.length > 1000) {
    return res.status(400).json({ message: 'Choose a valid status and provide an optional note up to 1,000 characters.' });
  }
  try {
    const request = await SupportRequest.findOneAndUpdate(
      { _id: req.params.requestId },
      {
        $set: {
          status,
          staffNote: note.trim(),
          resolvedAt: status === 'resolved' ? new Date() : null,
        },
      },
      { new: true, runValidators: true },
    ).select('-staffNote');
    if (!request) return res.status(404).json({ message: 'Support request not found.' });
    return res.json({
      message: 'Support request status updated.',
      request: {
        reference: request.reference,
        status: request.status,
        updatedAt: request.updatedAt,
        resolvedAt: request.resolvedAt,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listVerifications,
  reviewVerification,
  listSupportRequests,
  updateSupportRequest,
};
