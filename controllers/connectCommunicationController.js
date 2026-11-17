const mongoose = require('mongoose');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectApplication = require('../models/ConnectApplication');
const ConnectApplicationMessage = require('../models/ConnectApplicationMessage');
const ConnectOpportunity = require('../models/ConnectOpportunity');
const ConnectOpportunityReaction = require('../models/ConnectOpportunityReaction');
const Notification = require('../models/Notification');

const REACTIONS = ['interested', 'love', 'exciting', 'applause'];
const MAX_MESSAGE_LENGTH = 2000;

function messageError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function isStaff(req) {
  return ['staff', 'admin', 'super_admin'].includes(req.user?.role);
}

async function findApplication(req, applicationId) {
  if (!mongoose.isValidObjectId(applicationId)) throw messageError(400, 'Choose a valid application.');
  const filter = { _id: applicationId };
  if (!isStaff(req)) filter.userId = req.user._id;
  const application = await ConnectApplication.findOne(filter)
    .select('_id userId status roleInterest type opportunityId')
    .populate('opportunityId', 'title');
  if (!application) throw messageError(404, 'Application not found.');
  return application;
}

function messageForClient(message) {
  return {
    id: message._id,
    applicationId: message.applicationId,
    senderId: message.senderId,
    senderRole: message.senderRole,
    body: message.body,
    readAt: message.readAt,
    createdAt: message.createdAt,
  };
}

const setOpportunityReaction = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.opportunityId)) {
    return res.status(400).json({ message: 'Choose a valid opportunity.' });
  }
  const { reaction } = req.body || {};
  if (!REACTIONS.includes(reaction)) {
    return res.status(400).json({ message: 'Choose a valid reaction.' });
  }
  const opportunity = await ConnectOpportunity.findOne({
    _id: req.params.opportunityId,
    status: { $in: ['open', 'closed'] },
    publishedAt: { $lte: new Date() },
  }).select('_id');
  if (!opportunity) return res.status(404).json({ message: 'Opportunity not found.' });
  let saved;
  try {
    saved = await ConnectOpportunityReaction.findOneAndUpdate(
      { opportunityId: opportunity._id, userId: req.user._id },
      { $set: { reaction } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    saved = await ConnectOpportunityReaction.findOneAndUpdate(
      { opportunityId: opportunity._id, userId: req.user._id },
      { $set: { reaction } },
      { new: true, runValidators: true },
    );
  }
  return res.json({ reaction: saved.reaction });
});

const removeOpportunityReaction = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.opportunityId)) {
    return res.status(400).json({ message: 'Choose a valid opportunity.' });
  }
  await ConnectOpportunityReaction.findOneAndDelete({
    opportunityId: req.params.opportunityId,
    userId: req.user._id,
  });
  return res.json({ reaction: null });
});

async function listInbox(req, res, staffView) {
  const filter = staffView ? {} : { userId: req.user._id };
  const applications = await ConnectApplication.find(filter)
    .populate('userId', 'name email')
    .populate('opportunityId', 'title type')
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();
  const ids = applications.map((application) => application._id);
  const summaries = ids.length
    ? await ConnectApplicationMessage.aggregate([
      { $match: { applicationId: { $in: ids } } },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: '$applicationId',
          latest: { $last: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$senderRole', staffView ? 'applicant' : 'staff'] }, { $eq: ['$readAt', null] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ])
    : [];
  const summariesById = new Map(summaries.map((summary) => [String(summary._id), summary]));
  const conversations = applications.map((application) => {
    const summary = summariesById.get(String(application._id));
    const latest = summary?.latest;
    return {
      applicationId: application._id,
      applicationStatus: application.status,
      applicationType: application.type,
      opportunityTitle: application.opportunityId?.title || application.roleInterest || 'Connect Partner',
      applicant: staffView ? application.userId : undefined,
      latestMessage: latest ? messageForClient(latest) : null,
      unreadCount: summary?.unreadCount || 0,
      updatedAt: latest?.createdAt || application.updatedAt,
    };
  });
  return res.json({ conversations });
}

const listApplicantInbox = asyncHandler(async (req, res) => listInbox(req, res, false));
const listStaffInbox = asyncHandler(async (req, res) => listInbox(req, res, true));

async function listMessages(req, res, staffView) {
  const application = await findApplication(req, req.params.applicationId);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const cursor = req.query.before ? String(req.query.before).split('|') : null;
  const beforeDate = cursor ? new Date(cursor[0]) : null;
  const beforeId = cursor?.[1];
  if (cursor && (cursor.length !== 2 || Number.isNaN(beforeDate.getTime()) || !mongoose.isValidObjectId(beforeId))) {
    throw messageError(400, 'Choose a valid message history position.');
  }
  const otherRole = staffView ? 'applicant' : 'staff';
  await ConnectApplicationMessage.updateMany(
    { applicationId: application._id, senderRole: otherRole, readAt: null },
    { $set: { readAt: new Date() } },
  );
  const messageFilter = { applicationId: application._id };
  if (cursor) {
    messageFilter.$or = [
      { createdAt: { $lt: beforeDate } },
      { createdAt: beforeDate, _id: { $lt: new mongoose.Types.ObjectId(beforeId) } },
    ];
  }
  const newestFirst = await ConnectApplicationMessage.find(messageFilter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = newestFirst.length > limit;
  if (hasMore) newestFirst.pop();
  const messages = newestFirst.reverse();
  return res.json({
    application: {
      id: application._id,
      status: application.status,
      type: application.type,
      opportunityTitle: application.opportunityId?.title || application.roleInterest || 'Connect Partner',
    },
    messages: messages.map(messageForClient),
    hasMore,
    nextBefore: hasMore && messages.length
      ? `${messages[0].createdAt.toISOString()}|${messages[0]._id.toString()}`
      : null,
  });
}

const listApplicantMessages = asyncHandler(async (req, res) => listMessages(req, res, false));
const listStaffMessages = asyncHandler(async (req, res) => listMessages(req, res, true));

async function sendMessage(req, res, staffView) {
  const application = await findApplication(req, req.params.applicationId);
  const body = req.body?.body;
  if (typeof body !== 'string' || !body.trim() || body.trim().length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ message: `Write a message of 1 to ${MAX_MESSAGE_LENGTH} characters.` });
  }

  const senderRole = staffView ? 'staff' : 'applicant';
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      [created] = await ConnectApplicationMessage.create([{
        applicationId: application._id,
        senderId: req.user._id,
        senderRole,
        body: body.trim(),
      }], { session });
      await ConnectApplication.updateOne(
        { _id: application._id },
        { $set: { updatedAt: new Date() } },
        { session },
      );
      if (staffView) {
        await Notification.create([{
          userId: application.userId,
          title: 'A message from the Kalma Connect team',
          message: body.trim().slice(0, 500),
          category: 'System',
          type: 'info',
          icon: 'briefcase',
          color: 'green',
          connectApplicationId: application._id,
        }], { session });
        await ConnectAdminAudit.create([{
          actorId: req.user._id,
          action: 'application_message_sent',
          entityType: 'application',
          entityId: application._id,
          details: { messageId: String(created._id) },
        }], { session });
      }
    });
  } finally {
    await session.endSession();
  }
  return res.status(201).json({ message: messageForClient(created) });
}

const sendApplicantMessage = asyncHandler(async (req, res) => sendMessage(req, res, false));
const sendStaffMessage = asyncHandler(async (req, res) => sendMessage(req, res, true));

module.exports = {
  listApplicantInbox,
  listApplicantMessages,
  listStaffInbox,
  listStaffMessages,
  removeOpportunityReaction,
  sendApplicantMessage,
  sendStaffMessage,
  setOpportunityReaction,
};
