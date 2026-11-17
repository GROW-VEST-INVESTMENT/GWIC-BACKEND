const crypto = require('node:crypto');
const mongoose = require('mongoose');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectAssociate = require('../models/ConnectAssociate');
const ConnectIdCardRequest = require('../models/ConnectIdCardRequest');
const Notification = require('../models/Notification');
const User = require('../models/User');
const {
  deletePrivateImage,
  streamPrivateImage,
  uploadPrivateImage,
  validatePrivateImage,
} = require('../services/connectPrivateImages');

const REVIEW_STATUSES = ['changes_requested', 'approved', 'rejected'];

function messageError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requestForClient(request, associate, user, photoPath) {
  if (!request) return null;
  return {
    id: String(request._id),
    status: request.status,
    reviewNote: request.reviewNote || '',
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
    issuedAt: request.issuedAt,
    employeeId: associate?.employeeId || null,
    name: user?.name || '',
    email: user?.email || '',
    assignedRole: associate?.assignedRole || '',
    photoUrl: photoPath ? photoPath(request._id) : null,
  };
}

const getMyIdCard = asyncHandler(async (req, res) => {
  const associate = await ConnectAssociate.findOne({ userId: req.user._id, status: 'active' })
    .select('assignedRole employeeId')
    .lean();
  if (!associate) return res.json({ eligible: false, request: null, card: null });
  const [request, user] = await Promise.all([
    ConnectIdCardRequest.findOne({ associateId: associate._id }).sort({ createdAt: -1 }).lean(),
    User.findById(req.user._id).select('name email'),
  ]);
  const record = requestForClient(request, associate, user, (id) => `/api/connect/id-cards/${id}/photo`);
  return res.json({
    eligible: true,
    request: record,
    card: request?.status === 'approved' && associate.employeeId
      ? {
        employeeId: associate.employeeId,
        name: user?.name || '',
        role: associate.assignedRole,
        issuedAt: request.issuedAt,
        photoUrl: record.photoUrl,
      }
      : null,
  });
});

const getMyIdCardPhoto = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: 'Choose a valid ID card request.' });
  }
  const activeAssociate = await ConnectAssociate.exists({ userId: req.user._id, status: 'active' });
  if (!activeAssociate) return res.status(403).json({ message: 'Only active associates can view their ID card photo.' });
  const request = await ConnectIdCardRequest.findOne({
    _id: req.params.requestId,
    userId: req.user._id,
  }).select('photoPublicId photoFormat');
  if (!request) return res.status(404).json({ message: 'ID card photo not found.' });
  return streamPrivateImage(res, request.photoPublicId, request.photoFormat);
});

const submitIdCardRequest = asyncHandler(async (req, res) => {
  const associate = await ConnectAssociate.findOne({ userId: req.user._id, status: 'active' })
    .select('_id applicationId')
    .lean();
  if (!associate) return res.status(403).json({ message: 'Only active, approved Connect associates can request an ID card.' });
  const file = req.files?.[0];
  if (!file) return res.status(400).json({ message: 'Upload a clear PNG, JPEG, or WebP headshot under 2 MB.' });
  validatePrivateImage(file, 2 * 1024 * 1024);
  const existing = await ConnectIdCardRequest.findOne({
    associateId: associate._id,
    status: { $in: ['pending', 'approved'] },
  }).select('_id status');
  if (existing?.status === 'pending') {
    return res.status(409).json({ message: 'Your ID card request is already waiting for admin review.' });
  }
  if (existing?.status === 'approved') {
    return res.status(409).json({ message: 'An active ID card has already been issued. Contact Connect support if it needs correction.' });
  }

  const uploaded = await uploadPrivateImage(file, req.user._id, 'connect-id-cards');
  let session;
  let created;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      [created] = await ConnectIdCardRequest.create([{
        userId: req.user._id,
        associateId: associate._id,
        applicationId: associate.applicationId,
        photoPublicId: uploaded.publicId,
        photoFormat: uploaded.format,
        photoBytes: uploaded.bytes,
      }], { session });
      await ConnectAdminAudit.create([{
        actorId: req.user._id,
        action: 'connect_id_card_submitted',
        entityType: 'connect_id_card',
        entityId: created._id,
        details: { status: created.status },
      }], { session });
      await Notification.create([{
        userId: req.user._id,
        title: 'ID card request submitted',
        message: 'Your Kalma Connect associate ID card request is waiting for admin review.',
        category: 'System',
        type: 'info',
        icon: 'briefcase',
        color: 'green',
      }], { session });
    });
  } catch (error) {
    try {
      await deletePrivateImage(uploaded.publicId);
    } catch (cleanupError) {
      console.error('Unable to remove an unused Connect ID card photo:', cleanupError.message);
    }
    if (error.code === 11000) {
      return res.status(409).json({ message: 'An ID card request is already waiting for review. Refresh the page to see its status.' });
    }
    throw error;
  } finally {
    if (session) await session.endSession();
  }
  return res.status(201).json({
    message: 'Your ID card request was submitted for review.',
    request: requestForClient(created, associate, req.user, (id) => `/api/connect/id-cards/${id}/photo`),
  });
});

const listAdminIdCards = asyncHandler(async (req, res) => {
  const allowedStatuses = ['pending', 'changes_requested', 'approved', 'rejected', 'revoked'];
  const filter = allowedStatuses.includes(req.query.status) ? { status: req.query.status } : {};
  const requests = await ConnectIdCardRequest.find(filter)
    .populate('userId', 'name email')
    .populate('associateId', 'assignedRole employeeId status')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return res.json({
    idCards: requests.map((request) => ({
      ...requestForClient(request, request.associateId, request.userId, (id) => `/api/admin/connect/id-cards/${id}/photo`),
      userId: request.userId,
      associateId: request.associateId?._id,
      applicationId: request.applicationId,
    })),
  });
});

const getAdminIdCardPhoto = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: 'Choose a valid ID card request.' });
  }
  const request = await ConnectIdCardRequest.findById(req.params.requestId).select('photoPublicId photoFormat');
  if (!request) return res.status(404).json({ message: 'ID card photo not found.' });
  return streamPrivateImage(res, request.photoPublicId, request.photoFormat);
});

const reviewIdCardRequest = asyncHandler(async (req, res) => {
  const { status, reviewNote = '' } = req.body || {};
  if (
    !REVIEW_STATUSES.includes(status)
    || typeof reviewNote !== 'string'
    || reviewNote.trim().length > 500
    || (status === 'changes_requested' && !reviewNote.trim())
  ) {
    return res.status(400).json({ message: 'Choose a valid ID card decision and include a note when requesting changes.' });
  }
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: 'Choose a valid ID card request.' });
  }
  const current = await ConnectIdCardRequest.findById(req.params.requestId).select('userId associateId status');
  if (!current) return res.status(404).json({ message: 'ID card request not found.' });
  if (current.status !== 'pending') {
    return res.status(409).json({ message: 'This ID card request is no longer waiting for review.' });
  }

  const session = await mongoose.startSession();
  let reviewed;
  let associate;
  try {
    await session.withTransaction(async () => {
      if (status === 'approved') {
        associate = await ConnectAssociate.findOne({
          _id: current.associateId,
          userId: current.userId,
          status: 'active',
        }).session(session);
        if (!associate) throw messageError(409, 'The associate is no longer active; this card cannot be issued.');
        if (!associate.employeeId) {
          associate.employeeId = `KALMA-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
          await associate.save({ session });
        }
      }
      reviewed = await ConnectIdCardRequest.findOneAndUpdate(
        { _id: current._id, status: 'pending' },
        {
          $set: {
            status,
            reviewNote: reviewNote.trim(),
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            ...(status === 'approved' ? { issuedAt: new Date() } : {}),
          },
        },
        { new: true, runValidators: true, session },
      );
      if (!reviewed) throw messageError(409, 'This ID card request has already been reviewed.');
      await ConnectAdminAudit.create([{
        actorId: req.user._id,
        action: 'connect_id_card_reviewed',
        entityType: 'connect_id_card',
        entityId: reviewed._id,
        details: { status, reviewNote: reviewNote.trim(), employeeId: associate?.employeeId || null },
      }], { session });
      const decisionText = (status === 'approved'
        ? `Your Kalma Connect associate ID card has been approved. Your staff ID is ${associate.employeeId}.`
        : status === 'changes_requested'
          ? `Please update your ID card request: ${reviewNote.trim()}`
          : `Your Kalma Connect associate ID card request was not approved.${reviewNote.trim() ? ` ${reviewNote.trim()}` : ''}`).slice(0, 500);
      await Notification.create([{
        userId: current.userId,
        title: status === 'approved' ? 'Your associate ID card is ready' : 'Your ID card request was reviewed',
        message: decisionText,
        category: 'System',
        type: status === 'approved' ? 'success' : status === 'rejected' ? 'warning' : 'info',
        icon: 'briefcase',
        color: status === 'rejected' ? 'orange' : 'green',
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  return res.json({
    request: requestForClient(
      reviewed,
      associate,
      await User.findById(current.userId).select('name email'),
      (id) => `/api/admin/connect/id-cards/${id}/photo`,
    ),
  });
});

module.exports = {
  getAdminIdCardPhoto,
  getMyIdCardPhoto,
  getMyIdCard,
  listAdminIdCards,
  reviewIdCardRequest,
  submitIdCardRequest,
};
