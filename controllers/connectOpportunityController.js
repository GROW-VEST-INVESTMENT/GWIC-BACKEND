const mongoose = require('mongoose');
const ConnectAdminAudit = require('../models/ConnectAdminAudit');
const ConnectApplication = require('../models/ConnectApplication');
const ConnectOpportunity = require('../models/ConnectOpportunity');
const ConnectOpportunityInterest = require('../models/ConnectOpportunityInterest');
const ConnectOpportunityReaction = require('../models/ConnectOpportunityReaction');
const Notification = require('../models/Notification');
const {
  applicationDocumentDownloadUrl,
  deleteApplicationDocuments,
  uploadApplicationDocuments,
  validateApplicationDocuments,
} = require('../services/connectApplicationDocuments');
const ConnectAssociate = require('../models/ConnectAssociate');
const ConnectPartner = require('../models/ConnectPartner');

const OPPORTUNITY_TYPES = ['role', 'partner', 'announcement'];
const OPPORTUNITY_STATUSES = ['draft', 'open', 'closed'];
const PROMOTION_CHANNELS = ['social_media', 'community', 'email', 'other'];

function messageError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function opportunityForClient(opportunity, extras = {}) {
  return {
    id: opportunity._id,
    title: opportunity.title,
    summary: opportunity.summary,
    description: opportunity.description,
    type: opportunity.type,
    requirements: opportunity.requirements,
    benefits: opportunity.benefits,
    positionsAvailable: opportunity.positionsAvailable,
    maximumApplications: opportunity.maximumApplications,
    applicationCount: opportunity.applicationCount,
    deadline: opportunity.deadline,
    status: opportunity.status,
    publishedAt: opportunity.publishedAt,
    createdAt: opportunity.createdAt,
    updatedAt: opportunity.updatedAt,
    ...extras,
  };
}

const listOpportunities = asyncHandler(async (req, res) => {
  const now = new Date();
  const view = ['all', 'interested', 'applied'].includes(req.query.view) ? req.query.view : 'all';
  const { page, limit } = (() => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    return { page, limit };
  })();
  const privateOpportunityIds = [];
  if (view === 'interested') {
    const interests = await ConnectOpportunityInterest.find({ userId: req.user._id }).select('opportunityId').lean();
    privateOpportunityIds.push(...interests.map((interest) => interest.opportunityId));
  } else if (view === 'applied') {
    const applications = await ConnectApplication.find({
      userId: req.user._id,
      opportunityId: { $ne: null },
    }).select('opportunityId').lean();
    privateOpportunityIds.push(...applications.map((application) => application.opportunityId));
  }

  const visibleFilter = view === 'all'
    ? {
      status: 'open',
      publishedAt: { $lte: now },
      $or: [{ deadline: null }, { deadline: { $gt: now } }],
    }
    : { _id: { $in: privateOpportunityIds } };
  if (['role', 'partner', 'announcement'].includes(req.query.type)) {
    visibleFilter.type = req.query.type;
  }
  const [opportunities, total] = await Promise.all([
    ConnectOpportunity.find(visibleFilter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ConnectOpportunity.countDocuments(visibleFilter),
  ]);
  const ids = opportunities.map((opportunity) => opportunity._id);
  const [interestCounts, myInterests, myApplications, reactionRows, myReactions] = await Promise.all([
    ConnectOpportunityInterest.aggregate([
      { $match: { opportunityId: { $in: ids } } },
      { $group: { _id: '$opportunityId', count: { $sum: 1 } } },
    ]),
    ConnectOpportunityInterest.find({ opportunityId: { $in: ids }, userId: req.user._id })
      .select('opportunityId')
      .lean(),
    ConnectApplication.find({ opportunityId: { $in: ids }, userId: req.user._id })
      .select('opportunityId status')
      .lean(),
    ConnectOpportunityReaction.aggregate([
      { $match: { opportunityId: { $in: ids } } },
      { $group: { _id: { opportunityId: '$opportunityId', reaction: '$reaction' }, count: { $sum: 1 } } },
    ]),
    ConnectOpportunityReaction.find({ opportunityId: { $in: ids }, userId: req.user._id })
      .select('opportunityId reaction')
      .lean(),
  ]);
  const countsById = new Map(interestCounts.map((item) => [String(item._id), item.count]));
  const interestedIds = new Set(myInterests.map((item) => String(item.opportunityId)));
  const applicationsById = new Map(myApplications.map((item) => [String(item.opportunityId), item.status]));
  const reactionsById = new Map();
  for (const item of reactionRows) {
    const opportunityId = String(item._id.opportunityId);
    if (!reactionsById.has(opportunityId)) reactionsById.set(opportunityId, {});
    reactionsById.get(opportunityId)[item._id.reaction] = item.count;
  }
  const myReactionsById = new Map(myReactions.map((item) => [String(item.opportunityId), item.reaction]));
  return res.json({
    opportunities: opportunities.map((opportunity) => opportunityForClient(opportunity, {
      interestedCount: countsById.get(String(opportunity._id)) || 0,
      isInterested: interestedIds.has(String(opportunity._id)),
      myApplicationStatus: applicationsById.get(String(opportunity._id)) || null,
      reactionCounts: reactionsById.get(String(opportunity._id)) || {},
      myReaction: myReactionsById.get(String(opportunity._id)) || null,
      isOpen: opportunity.status === 'open'
        && (!opportunity.publishedAt || opportunity.publishedAt <= now)
        && (!opportunity.deadline || opportunity.deadline > now)
        && opportunity.applicationCount < opportunity.maximumApplications,
    })),
    page,
    limit,
    total,
  });
});

async function findOpenOpportunity(opportunityId) {
  if (!mongoose.isValidObjectId(opportunityId)) throw messageError(400, 'Choose a valid opportunity.');
  const opportunity = await ConnectOpportunity.findById(opportunityId);
  if (!opportunity) throw messageError(404, 'Opportunity not found.');
  if (opportunity.type === 'announcement') throw messageError(400, 'Announcements do not accept applications.');
  if (opportunity.status !== 'open') throw messageError(409, 'Applications are closed for this opportunity.');
  if (opportunity.applicationCount >= opportunity.maximumApplications) {
    throw messageError(409, 'Application capacity reached. No more applications can be submitted.');
  }
  if (!opportunity.publishedAt || opportunity.publishedAt > new Date()) {
    throw messageError(409, 'This opportunity is not available yet.');
  }
  if (opportunity.deadline && opportunity.deadline <= new Date()) {
    throw messageError(409, 'The application deadline for this opportunity has passed.');
  }
  return opportunity;
}

async function reserveOpportunityCapacity(opportunity, session) {
  const reservedOpportunity = await ConnectOpportunity.findOneAndUpdate(
    {
      _id: opportunity._id,
      status: 'open',
      maximumApplications: opportunity.maximumApplications,
      applicationCount: { $lt: opportunity.maximumApplications },
      publishedAt: { $lte: new Date() },
      $or: [{ deadline: null }, { deadline: { $gt: new Date() } }],
    },
    { $inc: { applicationCount: 1 } },
    { new: true, session },
  );
  if (!reservedOpportunity) {
    const latest = await ConnectOpportunity.findById(opportunity._id).session(session);
    if (latest?.status === 'open'
      && latest.applicationCount < latest.maximumApplications
      && (!latest.deadline || latest.deadline > new Date())) {
      throw messageError(409, 'This opportunity was just updated. Refresh and try again.');
    }
    throw messageError(
      409,
      latest?.applicationCount >= latest?.maximumApplications
        ? 'Application capacity reached. No more applications can be submitted.'
        : 'Applications are closed for this opportunity.',
    );
  }
  if (reservedOpportunity.applicationCount >= reservedOpportunity.maximumApplications) {
    reservedOpportunity.status = 'closed';
    await reservedOpportunity.save({ session });
  }
  return reservedOpportunity;
}

const addOpportunityInterest = asyncHandler(async (req, res) => {
  const opportunity = await findOpenOpportunity(req.params.opportunityId);
  try {
    await ConnectOpportunityInterest.create({
      opportunityId: opportunity._id,
      userId: req.user._id,
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  return res.json({ interested: true });
});

const removeOpportunityInterest = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.opportunityId)) {
    return res.status(400).json({ message: 'Choose a valid opportunity.' });
  }
  await ConnectOpportunityInterest.findOneAndDelete({
    opportunityId: req.params.opportunityId,
    userId: req.user._id,
  });
  return res.json({ interested: false });
});

function parsePromotionChannels(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function applicationToClient(application) {
  return {
    id: application._id,
    type: application.type,
    opportunityId: application.opportunityId,
    opportunityTitle: application.roleInterest,
    status: application.status,
    roleInterest: application.roleInterest,
    assignedRole: application.assignedRole,
    motivation: application.motivation,
    experience: application.experience,
    promotionChannels: application.promotionChannels,
    reviewNote: application.reviewNote,
    interviewAt: application.interviewAt,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    documents: (application.documents || []).map((document) => ({
      id: document._id,
      name: document.name,
      format: document.format,
      bytes: document.bytes,
    })),
  };
}

const createOpportunityApplication = asyncHandler(async (req, res) => {
  const opportunity = await findOpenOpportunity(req.params.opportunityId);
  const type = opportunity.type === 'partner' ? 'partner' : 'applicant';
  const motivation = req.body?.motivation;
  const experience = req.body?.experience || '';
  const promotionChannels = parsePromotionChannels(req.body?.promotionChannels || []);
  const files = req.files || [];
  validateApplicationDocuments(files);
  if (typeof motivation !== 'string' || motivation.trim().length < 30 || motivation.trim().length > 2000
    || typeof experience !== 'string' || experience.length > 3000
    || !Array.isArray(promotionChannels)
    || promotionChannels.some((channel) => !PROMOTION_CHANNELS.includes(channel))) {
    return res.status(400).json({ message: 'Please check the application details and try again.' });
  }
  if (type === 'partner' && promotionChannels.length === 0) {
    return res.status(400).json({ message: 'Select at least one promotion channel.' });
  }
  if (type === 'applicant' && promotionChannels.length > 0) {
    return res.status(400).json({ message: 'Promotion channels are only used for partner applications.' });
  }
  const existingAccess = type === 'applicant'
    ? await ConnectAssociate.exists({ userId: req.user._id, status: 'active' })
    : await ConnectPartner.exists({ userId: req.user._id });
  if (existingAccess) {
    return res.status(409).json({
      message: type === 'applicant'
        ? 'You already have an active Associate role.'
        : 'You already have a Connect Partner profile.',
    });
  }
  if (await ConnectApplication.exists({ userId: req.user._id, opportunityId: opportunity._id, active: true })) {
    return res.status(409).json({ message: 'You already have an application in progress for this opportunity.' });
  }

  const documents = await uploadApplicationDocuments(files, req.user._id);
  let session;
  let application;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await reserveOpportunityCapacity(opportunity, session);
      [application] = await ConnectApplication.create([{
        userId: req.user._id,
        opportunityId: opportunity._id,
        type,
        roleInterest: type === 'applicant' ? opportunity.title : '',
        motivation: motivation.trim(),
        experience: experience.trim(),
        promotionChannels: type === 'partner' ? [...new Set(promotionChannels)] : [],
        documents,
      }], { session });
      await Notification.create([{
        userId: req.user._id,
        title: 'Application submitted',
        message: `Your application for ${opportunity.title} has been submitted and is awaiting review.`,
        category: 'System',
        type: 'success',
        icon: 'briefcase',
        color: 'green',
        connectApplicationId: application._id,
      }], { session });
    });
  } catch (error) {
    try {
      await deleteApplicationDocuments(documents);
    } catch (cleanupError) {
      console.error('Unable to remove unlinked Connect application documents:', cleanupError);
    }
    if (error.code === 11000) {
      return res.status(409).json({ message: 'You already have an application in progress for this opportunity.' });
    }
    throw error;
  } finally {
    if (session) await session.endSession();
  }
  return res.status(201).json({ application: applicationToClient(application) });
});

function parseOpportunity(body, existing) {
  const type = body.type ?? existing?.type;
  const status = body.status ?? existing?.status ?? 'draft';
  const title = body.title ?? existing?.title ?? '';
  const summary = body.summary ?? existing?.summary ?? '';
  const description = body.description ?? existing?.description ?? '';
  const requirements = body.requirements ?? existing?.requirements ?? '';
  const benefits = body.benefits ?? existing?.benefits ?? '';
  let deadlineValue = body.deadline === undefined
    ? existing?.deadline
    : body.deadline ? new Date(body.deadline) : null;
  if (typeof body.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.deadline) && deadlineValue) {
    if (deadlineValue.toISOString().slice(0, 10) !== body.deadline) {
      throw messageError(400, 'Provide a valid application deadline.');
    }
    deadlineValue.setUTCHours(23, 59, 59, 999);
  }
  const positionsAvailable = body.positionsAvailable === undefined
    ? existing?.positionsAvailable ?? 0
    : Number(body.positionsAvailable);
  const maximumApplications = body.maximumApplications === undefined
    ? existing?.maximumApplications ?? 0
    : Number(body.maximumApplications);
  if (!OPPORTUNITY_TYPES.includes(type) || !OPPORTUNITY_STATUSES.includes(status)
    || typeof title !== 'string' || title.trim().length < 5 || title.trim().length > 120
    || typeof summary !== 'string' || summary.trim().length < 10 || summary.trim().length > 240
    || typeof description !== 'string' || description.trim().length < 30 || description.trim().length > 6000
    || typeof requirements !== 'string' || requirements.length > 3000
    || typeof benefits !== 'string' || benefits.length > 3000) {
    throw messageError(400, 'Check the opportunity title, summary, description, type, and status.');
  }
  if (deadlineValue && Number.isNaN(deadlineValue.getTime())) {
    throw messageError(400, 'Provide a valid application deadline.');
  }
  if (type !== 'announcement') {
    if (!Number.isInteger(positionsAvailable) || positionsAvailable < 1 || positionsAvailable > 10000
      || !Number.isInteger(maximumApplications) || maximumApplications < positionsAvailable || maximumApplications > 1000000) {
      throw messageError(400, 'Application capacity must be at least the number of available positions.');
    }
    if (status === 'open' && deadlineValue && deadlineValue <= new Date()) {
      throw messageError(400, 'An opportunity can only be opened before its deadline.');
    }
  }
  return {
    title: title.trim(),
    summary: summary.trim(),
    description: description.trim(),
    type,
    requirements: requirements.trim(),
    benefits: benefits.trim(),
    positionsAvailable: type === 'announcement' ? 0 : positionsAvailable,
    maximumApplications: type === 'announcement' ? 0 : maximumApplications,
    deadline: deadlineValue || null,
    status,
  };
}

const listAdminOpportunities = asyncHandler(async (req, res) => {
  const filter = {};
  if (OPPORTUNITY_STATUSES.includes(req.query.status)) filter.status = req.query.status;
  const opportunities = await ConnectOpportunity.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const ids = opportunities.map((opportunity) => opportunity._id);
  const [interestCounts, applicationCounts, reactionCounts] = await Promise.all([
    ConnectOpportunityInterest.aggregate([
      { $match: { opportunityId: { $in: ids } } },
      { $group: { _id: '$opportunityId', count: { $sum: 1 } } },
    ]),
    ConnectApplication.aggregate([
      { $match: { opportunityId: { $in: ids } } },
      { $group: { _id: '$opportunityId', count: { $sum: 1 } } },
    ]),
    ConnectOpportunityReaction.aggregate([
      { $match: { opportunityId: { $in: ids } } },
      { $group: { _id: '$opportunityId', count: { $sum: 1 } } },
    ]),
  ]);
  const counts = (items) => new Map(items.map((item) => [String(item._id), item.count]));
  const interestsById = counts(interestCounts);
  const applicationsById = counts(applicationCounts);
  const reactionsById = counts(reactionCounts);
  return res.json({
    opportunities: opportunities.map((opportunity) => opportunityForClient(opportunity, {
      interestedCount: interestsById.get(String(opportunity._id)) || 0,
      applicationCount: applicationsById.get(String(opportunity._id)) || 0,
      reactionCount: reactionsById.get(String(opportunity._id)) || 0,
    })),
  });
});

async function saveOpportunity(req, existing) {
  const values = parseOpportunity(req.body || {}, existing);
  const applicationCount = existing?.applicationCount || 0;
  if (values.type !== 'announcement' && values.maximumApplications < applicationCount) {
    throw messageError(409, `The application limit cannot be lower than the ${applicationCount} applications already received.`);
  }
  if (existing && applicationCount > 0 && values.type !== existing.type) {
    throw messageError(409, 'The opportunity type cannot be changed after applications have been received.');
  }
  if (values.status === 'open' && values.type !== 'announcement'
    && values.maximumApplications <= applicationCount) {
    throw messageError(409, 'Increase the application limit before reopening this opportunity.');
  }
  if (values.status === 'open' && !existing?.publishedAt) values.publishedAt = new Date();
  values.updatedBy = req.user._id;
  const session = await mongoose.startSession();
  let opportunity;
  try {
    await session.withTransaction(async () => {
      opportunity = existing
        ? await ConnectOpportunity.findOneAndUpdate(
          { _id: existing._id, applicationCount: { $lte: values.maximumApplications } },
          { $set: values },
          { new: true, runValidators: true, session },
        )
        : await ConnectOpportunity.create([{ ...values, createdBy: req.user._id }], { session })
          .then(([created]) => created);
      if (!opportunity) {
        const latest = existing
          ? await ConnectOpportunity.findById(existing._id).session(session)
          : null;
        throw messageError(
          409,
          `The application limit cannot be lower than the ${latest?.applicationCount || 0} applications already received.`,
        );
      }
      await ConnectAdminAudit.create([{
        actorId: req.user._id,
        action: existing ? 'opportunity_updated' : 'opportunity_created',
        entityType: 'opportunity',
        entityId: opportunity._id,
        details: { title: opportunity.title, type: opportunity.type, status: opportunity.status },
      }], { session });
    });
  } finally {
    await session.endSession();
  }
  return opportunity;
}

const createOpportunity = asyncHandler(async (req, res) => {
  const opportunity = await saveOpportunity(req, null);
  return res.status(201).json({ opportunity: opportunityForClient(opportunity) });
});

const updateOpportunity = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.opportunityId)) {
    return res.status(400).json({ message: 'Choose a valid opportunity.' });
  }
  const opportunity = await ConnectOpportunity.findById(req.params.opportunityId);
  if (!opportunity) return res.status(404).json({ message: 'Opportunity not found.' });
  const updated = await saveOpportunity(req, opportunity);
  return res.json({ opportunity: opportunityForClient(updated) });
});

async function documentResponse(applicationId, documentId) {
  if (!mongoose.isValidObjectId(applicationId)) throw messageError(400, 'Choose a valid application.');
  const application = await ConnectApplication.findById(applicationId).select('userId documents').lean();
  if (!application) throw messageError(404, 'Application not found.');
  const document = (application.documents || []).find((item) => String(item._id) === String(documentId));
  if (!document) throw messageError(404, 'Application document not found.');
  return { application, document };
}

const getMyApplicationDocument = asyncHandler(async (req, res) => {
  const { application, document } = await documentResponse(req.params.applicationId, req.params.documentId);
  if (String(application.userId) !== String(req.user._id)) {
    return res.status(404).json({ message: 'Application document not found.' });
  }
  return res.redirect(applicationDocumentDownloadUrl(document));
});

const getAdminApplicationDocument = asyncHandler(async (req, res) => {
  const { document } = await documentResponse(req.params.applicationId, req.params.documentId);
  return res.redirect(applicationDocumentDownloadUrl(document));
});

module.exports = {
  addOpportunityInterest,
  createOpportunityApplication,
  createOpportunity,
  getAdminApplicationDocument,
  getMyApplicationDocument,
  listAdminOpportunities,
  listOpportunities,
  removeOpportunityInterest,
  reserveOpportunityCapacity,
  updateOpportunity,
};
