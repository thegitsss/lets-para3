const matterFileWrites = require("../services/matterFileWrites"), matterRetirement = require("../services/matterStorageRetirement");
const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:messages");
// backend/routes/messages.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const { requireApproved, requireRole, requireCaseAccess } = require("../utils/authz");
const Message = require("../models/Message");
const attorneyConversation = require("../services/attorneyConversation");
const CaseFile = require("../models/CaseFile");
const Case = require("../models/Case");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog"); // match filename
const { notifyUser } = require("../utils/notifyUser");
const { containsProfanity, maskProfanity } = require("../utils/badWords");
const { CASE_STATE } = require("../utils/caseState");
const { evaluateMessagingPermission: evaluatePlatformMessagingPermission } = require("../services/attorneyWorkflowPolicy");
const { evaluateMessagingPermission: evaluateParalegalMessagingPermission } = require("../services/paralegalWorkflowPolicy");
const { BLOCKED_MESSAGE, getBlockedUserIds, isBlockedBetween } = require("../utils/blocks");
const { publishCaseEvent } = require("../utils/caseEvents");
const { publishNotificationEvent } = require("../utils/notificationEvents");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const {
  buildCaseFileKeyQuery,
  decryptCaseFilePayload,
  decryptMessagePayload,
  decryptString,
} = require("../utils/dataEncryption");
const { isWorkspacePresenceActive } = require("../utils/workspacePresence");
const { csrfProtection } = require("../utils/csrf");
const { resolveMessageNotificationPolicy } = require("../utils/messageNotificationPolicy");
const { applyAssignmentVisibility, buildAssignmentVisibilityLookup } = require("../utils/matterAssignmentVisibility");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const validReaction = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 30
  && !/[.$\x00-\x1f\x7f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value.trim());

function sanitizeText(s) {
  if (typeof s !== "string") return "";
  const stripped = s.replace(/<[^>]*>/g, "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001F\u007F]/g, "").trim();
  if (!stripped) return "";
  const limited = stripped.slice(0, 2000);
  return containsProfanity(limited) ? maskProfanity(limited) : limited;
}

function sanitizeClientMessageId(value) {
  const id = String(value || "").trim();
  if (!id) return "";
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/.test(id) ? id : null;
}

function buildCaseAccessFilter(user) {
  if (!user) return {};
  if (user.role === "admin") return {};
  return {
    $or: [
      { attorney: user.id },
      { attorneyId: user.id },
      { paralegal: user.id },
      { paralegalId: user.id },
    ],
  };
}

const FUNDED_WORKSPACE_FILTER = {
  escrowStatus: "funded",
  escrowIntentId: { $exists: true, $ne: null },
  status: {
    $in: [
      CASE_STATE.FUNDED_IN_PROGRESS,
      "in progress",
      "in_progress",
      "active",
      "awaiting_documents",
      "reviewing",
    ],
  },
  $or: [
    { paralegal: { $exists: true, $ne: null } },
    { paralegalId: { $exists: true, $ne: null } },
  ],
};

function buildBlockedCaseClause(user, blockedIds) {
  if (!blockedIds.length) return null;
  const role = String(user?.role || "").toLowerCase();
  if (role === "attorney") {
    return { $and: [{ paralegal: { $nin: blockedIds } }, { paralegalId: { $nin: blockedIds } }] };
  }
  if (role === "paralegal") {
    return { $and: [{ attorney: { $nin: blockedIds } }, { attorneyId: { $nin: blockedIds } }] };
  }
  return null;
}

async function buildMessagingCaseFilter(user) {
  const clauses = [FUNDED_WORKSPACE_FILTER];
  const base = buildCaseAccessFilter(user);
  if (base && Object.keys(base).length) clauses.unshift(base);
  const role = String(user?.role || "").toLowerCase();
  const blockedIds = ["attorney", "paralegal"].includes(role)
    ? await getBlockedUserIds(user.id)
    : [];
  const blockClause = buildBlockedCaseClause(user, blockedIds);
  if (blockClause) clauses.push(blockClause);
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "string" && mongoose.isValidObjectId(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  if (typeof value === "object" && value._id) {
    return value._id instanceof mongoose.Types.ObjectId ? value._id : new mongoose.Types.ObjectId(value._id);
  }
  return null;
}

function buildShortPreview(text = "", maxLen = 50) {
  const source = (text || "").replace(/\s+/g, " ").trim();
  if (!source) return "New message";
  if (source.length <= maxLen) return source;
  return `${source.slice(0, maxLen - 1).trim()}…`;
}


function buildMessagesBeforeBoundary(createdAt, messageId) {
  return {
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: messageId } },
    ],
  };
}

const MESSAGE_NOTIFICATION_COOLDOWN_MS = resolveMessageNotificationPolicy().suppressMs;

async function shouldNotifyForMessage({ caseId, messageDoc, senderRole }) {
  const caseObjectId = toObjectId(caseId);
  const currentMessageId = toObjectId(messageDoc?._id);
  const currentCreatedAt = messageDoc?.createdAt ? new Date(messageDoc.createdAt) : null;
  const normalizedSenderRole = normalizeSenderRole(senderRole);
  if (!caseObjectId || !currentMessageId || !currentCreatedAt || Number.isNaN(currentCreatedAt.getTime())) {
    return true;
  }
  if (!normalizedSenderRole || MESSAGE_NOTIFICATION_COOLDOWN_MS <= 0) {
    return true;
  }
  const currentBoundary = buildMessagesBeforeBoundary(currentCreatedAt, currentMessageId);

  const latestMessageFromSenderRole = await Message.findOne({
    caseId: caseObjectId,
    deleted: { $ne: true },
    senderRole: normalizedSenderRole,
    _id: { $ne: currentMessageId },
    $and: [currentBoundary],
  })
    .sort({ createdAt: -1, _id: -1 })
    .select("_id createdAt")
    .lean();

  if (!latestMessageFromSenderRole) {
    return true;
  }

  const latestMessageCreatedAt = latestMessageFromSenderRole?.createdAt
    ? new Date(latestMessageFromSenderRole.createdAt)
    : null;
  if (!latestMessageCreatedAt || Number.isNaN(latestMessageCreatedAt.getTime())) {
    return true;
  }

  const gapMs = currentCreatedAt.getTime() - latestMessageCreatedAt.getTime();
  return gapMs >= MESSAGE_NOTIFICATION_COOLDOWN_MS;
}

async function createMessageNotification({ caseDoc, senderDoc, previewText, messageDoc }) {
  if (!caseDoc || !senderDoc) return;
  const role = String(senderDoc.role || "").toLowerCase();
  let recipientId = null;
  if (role === "attorney") {
    recipientId = toObjectId(caseDoc.paralegal) || toObjectId(caseDoc.paralegalId);
  } else if (role === "paralegal") {
    recipientId = toObjectId(caseDoc.attorney) || toObjectId(caseDoc.attorneyId);
  } else {
    return;
  }
  if (!recipientId) return;
  const senderId = toObjectId(senderDoc._id || senderDoc.id);
  if (senderId && String(recipientId) === String(senderId)) return;
  if (await isWorkspacePresenceActive(recipientId, caseDoc._id, "messages")) {
    publishNotificationEvent(recipientId, "notifications", {
      at: new Date().toISOString(),
      type: "message_refresh",
    });
    return;
  }
  const shouldNotify = await shouldNotifyForMessage({
    caseId: caseDoc._id,
    messageDoc,
    senderRole: role,
  });
  if (!shouldNotify) {
    publishNotificationEvent(recipientId, "notifications", { at: new Date().toISOString(), type: "message_refresh" });
    return;
  }

  const senderName = `${senderDoc.firstName || ""} ${senderDoc.lastName || ""}`.trim() || "Someone";
  try {
    await notifyUser(recipientId, "message", {
      caseId: caseDoc._id,
      caseTitle: caseDoc.title || "Untitled Matter",
      fromName: senderName,
      messageSnippet: buildShortPreview(previewText, 40),
      messageId: messageDoc?._id || null,
    }, { actorUserId: senderId });
  } catch (err) {
    runtimeLogger.warn("[messages] notifyUser failed", err);
  }
}

function buildUnreadClause(userObjectId) {
  return {
    $and: [
      { senderId: { $ne: userObjectId } },
      { readBy: { $not: { $elemMatch: { $eq: userObjectId } } } },
      { readReceipts: { $not: { $elemMatch: { user: userObjectId } } } },
    ],
  };
}

function lastViewedForCase(lastMap, caseId) {
  const key = String(caseId || "");
  const value = typeof lastMap?.get === "function" ? lastMap.get(key) : lastMap?.[key];
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function assignmentViewer(user, acl = {}) {
  return {
    role: user?.role,
    userId: user?.id || user?._id,
    isParalegal: acl?.isParalegal === true,
  };
}

function scopedMessageFilter(req, filter) {
  return applyAssignmentVisibility(filter, req.case, assignmentViewer(req.user, req.acl));
}

function buildCaseUnreadQuery(caseDoc, userObjectId, lastMap, user) {
  const caseId = caseDoc?._id || caseDoc;
  const lastViewed = lastViewedForCase(lastMap, caseId);
  const query = {
    caseId,
    deleted: { $ne: true },
    ...(lastViewed ? { createdAt: { $gt: lastViewed } } : {}),
    ...buildUnreadClause(userObjectId),
  };
  return applyAssignmentVisibility(query, caseDoc, assignmentViewer(user));
}

function isCaseReadOnly(req) {
  return !!(req.case?.readOnly && !req.acl?.isAdmin);
}

function assertMessagingOpen(req, res) {
  const caseDoc = req.case;
  if (!caseDoc) {
    return res.status(400).json({ error: "Matter not loaded" });
  }
  const viewerRole = String(req.user?.role || "").toLowerCase();
  const policy = viewerRole === "paralegal"
    ? evaluateParalegalMessagingPermission({
        caseDoc,
        user: req.user,
        viewerId: req.user?.id,
        partiesBlocked: false,
      })
    : evaluatePlatformMessagingPermission({
        caseDoc,
        viewerId: req.user?.id,
        viewerRole,
        partiesBlocked: false,
      });
  if (policy.blockers.includes("hire_required")) {
    return res.status(403).json({ error: "Messaging is available after hire" });
  }
  if (policy.blockers.includes("funding_required")) {
    return res.status(403).json({ error: "Work begins once Matter funding is confirmed." });
  }
  if (policy.blockers.includes("messaging_closed") || policy.blockers.includes("case_read_only")) {
    return res.status(403).json({ error: "Messaging is closed for this Matter." });
  }
  if (policy.blockers.includes("workspace_not_active")) {
    return res.status(403).json({ error: "Messaging unlocks once the Matter is funded and in progress." });
  }
  return null;
}


function normalizeSenderRole(role) {
  const normalized = String(role || "").toLowerCase();
  if (["attorney", "paralegal", "admin"].includes(normalized)) return normalized;
  return "";
}

async function loadSenderDoc(req) {
  const senderDoc = await User.findById(req.user.id).select("firstName lastName role").lean();
  if (!senderDoc) return null;
  const normalized = normalizeSenderRole(senderDoc.role);
  if (!normalized) return null;
  return { ...senderDoc, role: normalized };
}

// All message routes require auth
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("attorney", "paralegal"));
router.use(require("../utils/requestOwner"));

router.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const caseFilter = await buildMessagingCaseFilter(req.user);
    const caseDocs = await Case.find(caseFilter)
      .select("_id paralegal paralegalId withdrawnParalegalId hiredAt")
      .lean();
    if (!caseDocs.length) {
      return res.json({ count: 0 });
    }
    const requesterObjectId = new mongoose.Types.ObjectId(req.user.id);
    const viewer = await User.findById(req.user.id).select("messageLastViewedAt");
    const lastMap = viewer?.messageLastViewedAt || new Map();
    let totalUnread = 0;
    for (const doc of caseDocs) {
      const query = buildCaseUnreadQuery(doc, requesterObjectId, lastMap, req.user);
      // eslint-disable-next-line no-await-in-loop
      totalUnread += await Message.countDocuments(query);
    }
    res.json({ count: totalUnread });
  })
);

router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const filter = await buildMessagingCaseFilter(req.user);
    const caseDocs = await Case.find(filter)
      .select("_id title paralegal paralegalId withdrawnParalegalId hiredAt")
      .lean();
    if (!caseDocs.length) {
      return res.json({ items: [] });
    }
    const userDoc = await User.findById(req.user.id).select("messageLastViewedAt");
    const lastMap = userDoc?.messageLastViewedAt || new Map();
    const items = [];
    const requesterObjectId = new mongoose.Types.ObjectId(req.user.id);
    for (const doc of caseDocs) {
      const key = String(doc._id);
      const query = buildCaseUnreadQuery(doc, requesterObjectId, lastMap, req.user);
      const unread = await Message.countDocuments(query);
      items.push({
        caseId: key,
        title: doc.title || "Untitled Matter",
        unread,
      });
    }
    res.json({ items });
  })
);

/**
 * GET /api/messages/threads?q=&page=&limit=
 * Returns threads derived from cases the user is on (or all, if admin).
 * Each thread = case. Includes last message meta and unread counts.
 */
router.get(
  "/threads",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const caseFilter = await buildMessagingCaseFilter(req.user);
    if (q.trim()) caseFilter.title = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    // Aggregation does not cast schema paths automatically. Keep exactly the
    // existing participant/funding/block filter and cast it as a normal read.
    const castFilter = Case.find(caseFilter).cast(Case);
    const visibility = buildAssignmentVisibilityLookup(assignmentViewer(req.user));
    const [threadPage, userDoc] = await Promise.all([
      Case.aggregate([
        { $match: castFilter },
        { $facet: {
          total: [{ $count: "count" }],
          items: [
            { $project: { title: 1, createdAt: 1, attorney: 1, attorneyId: 1, paralegal: 1, paralegalId: 1, withdrawnParalegalId: 1, hiredAt: 1 } },
            { $lookup: {
              from: Message.collection.name,
              let: { caseId: "$_id", ...visibility.let },
              pipeline: [
                { $match: { deleted: { $ne: true }, $expr: { $and: [
                  { $eq: ["$caseId", "$$caseId"] }, visibility.expression,
                ] } } },
                { $sort: { createdAt: -1, _id: -1 } },
                { $limit: 1 },
                { $project: { type: 1, text: 1, fileName: 1, createdAt: 1, senderId: 1 } },
              ],
              as: "latestMessage",
            } },
            { $set: { last: { $arrayElemAt: ["$latestMessage", 0] }, hasMessages: { $gt: [{ $size: "$latestMessage" }, 0] } } },
            { $set: { conversationUpdatedAt: { $ifNull: ["$last.createdAt", "$createdAt"] } } },
            // Empty, newly funded Matters must not push real conversations off
            // the recent-message page. Retain them after visible conversations.
            { $sort: { hasMessages: -1, conversationUpdatedAt: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
            { $unset: ["latestMessage", "conversationUpdatedAt", "hasMessages"] },
          ],
        } },
      ]),
      User.findById(req.user.id).select("messageLastViewedAt").lean(),
    ]);
    const caseItems = threadPage[0]?.items || [];
    const totalCases = threadPage[0]?.total[0]?.count || 0;
    const caseIds = caseItems.map((c) => c._id);

    if (caseIds.length === 0) {
      return res.json({ page, limit, total: totalCases, pages: Math.ceil(totalCases / limit), threads: [] });
    }

    // Unread counts per case (checks both legacy readBy and new readReceipts.user)
    const requesterObjectId = new mongoose.Types.ObjectId(req.user.id);
    const lastMap = userDoc?.messageLastViewedAt || new Map();
    const unreadBranches = caseItems.map((caseDoc) => {
      const lastViewed = lastViewedForCase(lastMap, caseDoc._id);
      return applyAssignmentVisibility(
        {
          caseId: caseDoc._id,
          ...(lastViewed ? { createdAt: { $gt: lastViewed } } : {}),
        },
        caseDoc,
        assignmentViewer(req.user)
      );
    });
    const unreadClause = buildUnreadClause(requesterObjectId);
    const unreadAgg = await Message.aggregate([
      {
        $match: {
          deleted: { $ne: true },
          $and: [
            { $or: unreadBranches },
            ...unreadClause.$and,
          ],
        },
      },
      { $group: { _id: "$caseId", count: { $sum: 1 } } },
    ]);

    const unreadByCase = new Map(unreadAgg.map((d) => [String(d._id), d.count]));

    const participantId = item => req.user.role === "attorney" ? String(item.paralegal || item.paralegalId || "") : String(item.attorney || item.attorneyId || "");
    const senderIds=[...new Set(caseItems.flatMap(item=>[String(item.last?.senderId||""),participantId(item)]).filter(value=>mongoose.isValidObjectId(value)))];
    const senders=senderIds.length?await User.find({_id:{$in:senderIds}}).select("firstName lastName profileImage avatarURL profilePhotoStatus updatedAt").lean():[];
    const senderNames=new Map(senders.map(user=>[String(user._id),[user.firstName,user.lastName].filter(Boolean).join(" ")]));
    const photos = require('../services/profilePhotoDelivery');
    const senderPhotos = new Map(senders.map(user=>[String(user._id), user.profilePhotoStatus === 'approved' && photos.hasPhotoReference(user) ? photos.buildAuthenticatedProfilePhotoUrl(user) : '']));
    const threads = caseItems.map((c) => {
      const last = c.last;
      let snippet = "";
      if (last) {
        const lastText = last.text ? decryptString(last.text) : "";
        const lastFileName = last.fileName ? decryptString(last.fileName) : "";
        if (last.type === "text") snippet = (lastText || "").slice(0, 140);
        else if (last.type === "file") snippet = lastFileName ? `[file] ${lastFileName}` : "[file]";
        else if (last.type === "audio") snippet = "[audio message]";
        else snippet = `[${last.type}]`;
      }
      return {
        id: String(c._id),
        title: c.title,
        participant: participantId(c) ? { id: participantId(c), name: senderNames.get(participantId(c)) || "", photo: senderPhotos.get(participantId(c)) || "", role: req.user.role === "attorney" ? "paralegal" : "attorney" } : null,
        lastMessageSnippet: snippet,
        lastSenderName: last ? (String(last.senderId)===String(req.user.id)?"You":senderNames.get(String(last.senderId))||"Participant") : "",
        updatedAt: last?.createdAt || c.createdAt,
        unread: unreadByCase.get(String(c._id)) || 0,
      };
    });

    res.json({ page, limit, total: totalCases, pages: Math.ceil(totalCases / limit), threads });
  })
);

// Case-scoped routes (require participant access)
async function ensureNotBlockedForCase(req, res, next) {
  try {
    const role = String(req.user?.role || "").toLowerCase();
    if (!["attorney", "paralegal"].includes(role)) return next();
    const caseDoc = req.case;
    if (!caseDoc) return next();
    const otherId =
      role === "attorney"
        ? caseDoc.paralegal || caseDoc.paralegalId
        : caseDoc.attorney || caseDoc.attorneyId;
    if (!otherId) return next();
    if (await isBlockedBetween(req.user.id, otherId)) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

function ensureActiveMessagingParticipant(req, res, next) {
  if (!req.acl?.isAttorney && !req.acl?.isParalegal) {
    return res.status(403).json({ error: "Messaging is available only to active Matter participants." });
  }
  return next();
}

router.use(
  "/:caseId",
  ensureCaseParticipant(),
  ensureActiveMessagingParticipant,
  ensureNotBlockedForCase
);

router.use("/:caseId", asyncHandler(async (req, res, next) => {
  if (req.method !== "GET" && attorneyConversation.enabled(req)) {
    try { await attorneyConversation.prepareMutation(req); }
    catch (error) { return attorneyConversation.sendError(res, error); }
  }
  return next();
}));

/**
 * GET /api/messages/:caseId?before=&after=&limit=&threadRoot=
 * List messages for a case you can access.
 * - before: ISO date; default now
 * - after: ISO date to page forward
 * - limit: 1..100 default 50
 * - threadRoot: message id to fetch only that thread (root + replies)
 */
router.get(
  "/:caseId",
  asyncHandler(async (req, res) => {
    if (req.method === "GET" && attorneyConversation.enabled(req)) {
      res.set("Cache-Control", "private, no-store");
      try { return res.json(await attorneyConversation.read(req)); } catch (error) { return attorneyConversation.sendError(res, error); }
    }
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    const { caseId } = req.params;
    const messageFilter = applyAssignmentVisibility(
      { caseId, deleted: { $ne: true } },
      req.case,
      assignmentViewer(req.user, req.acl)
    );
    const items = await Message.find(messageFilter)
      .sort({ createdAt: 1 })
      .populate("senderId", "firstName lastName email role")
      .lean();

    const viewer = await User.findById(req.user.id).select("messageLastViewedAt");
    if (viewer) {
      if (!viewer.messageLastViewedAt || typeof viewer.messageLastViewedAt.set !== "function") {
        viewer.messageLastViewedAt = new Map();
      }
      viewer.messageLastViewedAt.set(String(caseId), new Date());
      await viewer.save();
    }

    const messages = items.map((item) => decryptMessagePayload(item));
    return res.json({ messages });
  })
);

/**
 * POST /api/messages/:caseId
 * Body: { type?: 'text', content, replyTo?, threadRoot? }
 */
router.post(
  "/:caseId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    const { caseId } = req.params;
    const caseDoc = req.case;
    if (caseDoc?.readOnly && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Matter is read-only" });
    }

    const text = sanitizeText(req.body?.text);
    const exactRequest = attorneyConversation.enabled(req) || req.get('X-LPC-Owner-Id') !== undefined;
    if (exactRequest && (typeof req.body?.text !== "string" || req.body.text.length > 2000)) return res.status(400).json({ code: "WORKSPACE_INVALID", error: "Enter a message of up to 2,000 characters." });
    if (!text) return res.status(400).json({ error: "text required" });

    const clientMessageId = sanitizeClientMessageId(req.body?.clientMessageId);
    if (clientMessageId === null) {
      return res.status(400).json({ error: "Invalid message request id" });
    }

    const senderDoc = await loadSenderDoc(req);
    if (!senderDoc) return res.status(403).json({ error: "Invalid sender role" });
    // A sending caller may confirm its own persisted request. Ordinary message
    // feeds continue to remove these private retry identifiers.
    const receipt = saved => {
      const message = decryptMessagePayload(saved);
      if (String(saved.senderId) === String(req.user.id) && saved.clientMessageId) message.clientMessageId = saved.clientMessageId;
      return { message };
    };

    if (clientMessageId) {
      const existing = await Message.findOne({ caseId, senderId: req.user.id, clientMessageId }).select('+clientMessageId');
      if (existing) {
        if (exactRequest && (existing.type !== 'text' || decryptMessagePayload(existing).text !== text)) return res.status(409).json({ code: "WORKSPACE_MESSAGE_CHANGED", error: "This message request already has different text." });
        await attorneyConversation.prepareMutation(req);
        return res.status(200).json({ ...receipt(existing), idempotent: true });
      }
    }

    let msg;
    try {
      await attorneyConversation.prepareMutation(req);
      msg = await Message.create({
        caseId,
        senderId: req.user.id,
        senderRole: senderDoc.role,
        type: "text",
        text,
        content: text,
        ...(clientMessageId ? { clientMessageId } : {}),
      });
    } catch (error) {
      if (clientMessageId && error?.code === 11000) {
        const existing = await Message.findOne({ caseId, senderId: req.user.id, clientMessageId }).select('+clientMessageId');
        if (existing) {
          if (exactRequest && (existing.type !== 'text' || decryptMessagePayload(existing).text !== text)) return res.status(409).json({ code: "WORKSPACE_MESSAGE_CHANGED", error: "This message request already has different text." });
          await attorneyConversation.prepareMutation(req);
          return res.status(200).json({ ...receipt(existing), idempotent: true });
        }
      }
      throw error;
    }

    await AuditLog.logFromReq(req, "message_sent", {
      targetType: "case",
      targetId: caseId,
      meta: { messageId: msg._id },
    });

    // Delivery to an open Matter workspace must not wait on notification or
    // email work. The record is authoritative at this point, so participants
    // can reconcile it immediately through the existing authenticated stream.
    publishCaseEvent(caseId, "messages", { at: new Date().toISOString() });
    publishCaseProjectionRefresh(caseDoc, "message_refresh", { caseEvent: "" });

    try {
      await createMessageNotification({
        caseDoc,
        senderDoc,
        previewText: text,
        messageDoc: msg,
      });
    } catch (err) {
      runtimeLogger.warn("[messages] notification creation failed", err);
    }

    return res.status(201).json(receipt(msg));
  })
);

/**
 * POST /api/messages/:caseId/file
 * Body: { fileKey, fileName, fileSize?, mimeType }
 * NOTE: kept for future attachment workflows even if unused today.
 */
router.post(
  "/:caseId/file",
  requireCaseAccess("caseId", { project: "withdrawnParalegalId hiredAt escrowStatus escrowIntentId paymentReleased tasksLocked" }),
  csrfProtection,
  asyncHandler(matterFileWrites.handle(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Matter is read-only" });
    }
    const writeReview = await matterFileWrites.read(req);
    const { fileKey, fileName, mimeType, fileSize, fileId, fileVersion } = req.body || {};
    const exactFile = fileId !== undefined;
    const clientMessageId = sanitizeClientMessageId(req.body?.clientMessageId);
    if (clientMessageId === null || exactFile && (!isObjId(fileId) || !Number.isSafeInteger(fileVersion) || fileVersion < 1 || !clientMessageId || (!attorneyConversation.enabled(req) && req.user.role !== "paralegal"))) return res.status(400).json({code:'WORKSPACE_INVALID',error:'A reviewed document and request ID are required.'});
    await attorneyConversation.prepareMutation(req);
    const receipt = saved => { const message=decryptMessagePayload(saved); if(saved.clientMessageId)message.clientMessageId=saved.clientMessageId; return {message}; };
    async function earlierRequest() {
      if (!clientMessageId) return null;
      const saved=await Message.findOne({caseId:req.params.caseId,senderId:req.user.id,clientMessageId}).select('+clientMessageId');
      if (!saved) return null;
      const plain=decryptMessagePayload(saved);
      if (saved.type!=='file' || (exactFile ? plain.content?.caseFileId!==fileId || plain.content?.fileVersion!==fileVersion : plain.fileKey!==fileKey)) throw Object.assign(new Error('This request belongs to a different attachment.'),{status:409,publicCode:'WORKSPACE_MESSAGE_CHANGED'});
      return saved;
    }
    const earlier=await earlierRequest(); if(earlier)return res.status(200).json({...receipt(earlier),idempotent:true});
    if (!exactFile && (!fileKey || !fileName)) return res.status(400).json({ error: "fileKey and fileName required" });
    const fileRecord = await CaseFile.findOne(applyAssignmentVisibility(
      exactFile ? {_id:fileId,caseId:req.params.caseId} : buildCaseFileKeyQuery({
        caseId: req.params.caseId,
        storageKey: String(fileKey),
      }),
      req.case,
      assignmentViewer(req.user, req.acl)
    ));
    if (!fileRecord) {
      return res.status(400).json({ error: "Attach the file to this Matter before sending it." });
    }
    const plainFile = decryptCaseFilePayload(fileRecord);
    if (!exactFile && String(plainFile.storageKey || "") !== String(fileKey)) {
      return res.status(400).json({ error: "The file does not belong to this Matter." });
    }
    if (exactFile && Number(fileRecord.version || 1)!==fileVersion) return res.status(409).json({code:'FILE_WRITE_CHANGED',error:'The selected document was replaced. Review it before sharing.'});
    if (!["clean", "not_required"].includes(String(fileRecord.securityStatus || "pending"))) {
      return res.status(fileRecord.securityStatus==='blocked'?422:423).json({
        error: "This file cannot be sent until security scanning completes.",
        code: "FILE_SCAN_PENDING",
      });
    }

    const senderDoc = await loadSenderDoc(req);
    if (!senderDoc) return res.status(403).json({ error: "Invalid sender role" });

    const size = Number.isFinite(plainFile.size) ? plainFile.size : Number.isFinite(+fileSize) ? +fileSize : undefined;
    let msg;
    try { msg = await matterFileWrites.run(req, writeReview, async session => {
      await matterRetirement.assertAttachable(req.params.caseId, plainFile.storageKey, session);
      const current = await CaseFile.findOne(applyAssignmentVisibility({ _id: fileRecord._id, caseId: req.params.caseId }, writeReview, assignmentViewer(req.user, req.acl))).session(session);
      if (!current || decryptCaseFilePayload(current).storageKey !== plainFile.storageKey || !["clean", "not_required"].includes(current.securityStatus) || Number(current.version || 1) !== Number(fileRecord.version || 1)) throw Object.assign(new Error("The attachment changed. Refresh Files before sending it."), { status: 409, publicCode: "FILE_WRITE_CHANGED" });
      const [record] = await Message.create([{
      caseId: req.params.caseId,
      senderId: req.user.id,
      senderRole: senderDoc.role,
      type: "file",
      text: plainFile.originalName,
      fileKey: plainFile.storageKey,
      fileName: plainFile.originalName,
      fileSize: size ?? null,
      mimeType: plainFile.mimeType || mimeType,
      content: {
        size,
        caseFileId:String(fileRecord._id),fileVersion:Number(fileRecord.version || 1),
      },
      ...(clientMessageId ? {clientMessageId} : {}),
      }], { session }); return record;
    }); } catch (error) {
      // A concurrent retry may lose the Matter guard or the unique request-ID race.
      // Reconcile the committed record before reporting an uncertain outcome.
      const saved=await earlierRequest(); if(saved){await attorneyConversation.prepareMutation(req);return res.status(200).json({...receipt(saved),idempotent:true});}
      throw error;
    }

    await AuditLog.logFromReq(req, "message.file.create", {
      targetType: "message",
      targetId: msg._id,
      caseId: req.params.caseId,
    });

    publishCaseEvent(req.params.caseId, "messages", { at: new Date().toISOString() });
    publishCaseProjectionRefresh(req.case, "message_refresh", { caseEvent: "" });
    try {
      await createMessageNotification({
        caseDoc: req.case,
        senderDoc,
        previewText: `Shared ${plainFile.originalName || fileName}`,
        messageDoc: msg,
      });
    } catch (err) {
      runtimeLogger.warn("[messages] file notification creation failed", err);
    }
    await matterFileWrites.read(req);
    res.status(201).json(receipt(msg));
  }))
);

/**
 * POST /api/messages/:caseId/read
 * Body: { upTo?: ISO date }
 * Marks messages as read by current user (writes both legacy readBy and rich readReceipts).
 */
router.post(
  "/:caseId/read",
  requireCaseAccess("caseId", { project: "withdrawnParalegalId hiredAt escrowStatus escrowIntentId paymentReleased tasksLocked" }),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const upTo = req.body.upTo ? new Date(req.body.upTo) : new Date();
    if (attorneyConversation.enabled(req) && (!req.body.upTo || !Number.isFinite(upTo.getTime()) || upTo.getTime() > Date.now() + 5000)) return res.status(400).json({ code: "WORKSPACE_INVALID", error: "Invalid message read date." });
    await attorneyConversation.prepareMutation(req);
    const readerId = new mongoose.Types.ObjectId(req.user.id);
    const caseObjectId = new mongoose.Types.ObjectId(caseId);

    // Mark legacy readBy
    const visibleReadFilter = applyAssignmentVisibility(
      { caseId: caseObjectId, createdAt: { $lte: upTo }, deleted: { $ne: true } },
      req.case,
      assignmentViewer(req.user, req.acl)
    );
    const res1 = await Message.updateMany(
      visibleReadFilter,
      { $addToSet: { readBy: readerId } }
    );

    // Add rich readReceipts without duplicates: set by user with $addToSet + fixed timestamp bucket
    const now = new Date();
    const receiptFilter = applyAssignmentVisibility(
      {
        caseId: caseObjectId,
        createdAt: { $lte: upTo },
        deleted: { $ne: true },
        "readReceipts.user": { $ne: readerId },
      },
      req.case,
      assignmentViewer(req.user, req.acl)
    );
    const res2 = await Message.updateMany(
      receiptFilter,
      { $push: { readReceipts: { user: readerId, at: now } } }
    );

    await AuditLog.logFromReq(req, "message.read.mark", {
      targetType: "case",
      targetId: caseId,
      caseId,
      meta: { upTo },
    });

    const viewer = await User.findById(req.user.id).select("messageLastViewedAt");
    if (viewer) {
      if (!viewer.messageLastViewedAt || typeof viewer.messageLastViewedAt.set !== "function") {
        viewer.messageLastViewedAt = new Map();
      }
      viewer.messageLastViewedAt.set(String(caseId), new Date(upTo));
      await viewer.save();
    }

    if ((res1.modifiedCount || 0) > 0 || (res2.modifiedCount || 0) > 0) {
      publishCaseEvent(caseId, "messages", { at: new Date().toISOString() });
      publishNotificationEvent(req.user.id, "notifications", {
        at: new Date().toISOString(),
        type: "message_read_refresh",
      });
    }

    res.json({ updatedLegacy: res1.modifiedCount || 0, updatedReceipts: res2.modifiedCount || 0 });
  })
);

/**
 * PATCH /api/messages/:caseId/:messageId
 * Body: { content?, pin?, unpin? }
 * Edit your own text message or pin/unpin (admin can edit/pin anything).
 */
router.patch(
  "/:caseId/:messageId",
  requireCaseAccess("caseId", { project: "withdrawnParalegalId hiredAt escrowStatus escrowIntentId paymentReleased tasksLocked" }),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Matter is read-only" });
    }
    const { caseId, messageId } = req.params;
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne(scopedMessageFilter(req, { _id: messageId, caseId }));
    if (!msg) return res.status(404).json({ error: "Not found" });

    const isOwner = String(msg.senderId) === String(req.user.id);
    const canEdit = isOwner || req.user.role === "admin";

    const { content, pin, unpin } = req.body || {};

    if (typeof content === "string") {
      if (!canEdit) return res.status(403).json({ error: "Not allowed to edit" });
      const nextText = sanitizeText(content);
      if (attorneyConversation.enabled(req) && (!nextText || content.length > 2000 || msg.type !== "text")) return res.status(400).json({ code: "WORKSPACE_INVALID", error: "Enter a text message of up to 2,000 characters." });
      msg.text = nextText;
      msg.content = nextText;
      msg.markEdited?.(req.user.id);
    }

    if (pin === true) {
      if (!canEdit) return res.status(403).json({ error: "Not allowed to pin" });
      msg.pinned = true;
      msg.pinnedBy = req.user.id;
    } else if (unpin === true) {
      if (!canEdit) return res.status(403).json({ error: "Not allowed to unpin" });
      msg.pinned = false;
      msg.pinnedBy = null;
    }

    try { await attorneyConversation.prepareMutation(req, msg); await msg.save(); }
    catch (error) { if (attorneyConversation.enabled(req)) return attorneyConversation.sendError(res, error); throw error; }
    await AuditLog.logFromReq(req, "message.update", {
      targetType: "message",
      targetId: msg._id,
      caseId,
      meta: { edited: typeof content === "string", pinned: msg.pinned },
    });

    publishCaseEvent(caseId, "messages", { at: new Date().toISOString() });
    publishCaseProjectionRefresh(req.case, "message_refresh", { caseEvent: "" });
    res.json({ ok: true });
  })
);

/**
 * POST /api/messages/:caseId/:messageId/react
 * Body: { emoji }  — add reaction; DELETE same path to remove
 */
router.post(
  "/:caseId/:messageId/react",
  requireCaseAccess("caseId", { project: "withdrawnParalegalId hiredAt escrowStatus escrowIntentId paymentReleased tasksLocked" }),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Matter is read-only" });
    }
    const { caseId, messageId } = req.params;
    const { emoji } = req.body || {};
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });
    if (!validReaction(emoji)) return res.status(400).json({ error: "Choose a valid reaction." });

    const msg = await Message.findOne(scopedMessageFilter(req, { _id: messageId, caseId }));
    if (!msg) return res.status(404).json({ error: "Not found" });

    msg.addReaction?.(String(emoji).trim(), req.user.id);
    try { await attorneyConversation.prepareMutation(req, msg); await msg.save(); }
    catch (error) { if (attorneyConversation.enabled(req)) return attorneyConversation.sendError(res, error); throw error; }

    await AuditLog.logFromReq(req, "message.react.add", {
      targetType: "message",
      targetId: msg._id,
      caseId,
      meta: { emoji },
    });

    publishCaseEvent(caseId, "messages", { at: new Date().toISOString() });
    publishCaseProjectionRefresh(req.case, "message_refresh", { caseEvent: "" });
    res.status(201).json({ ok: true });
  })
);

router.delete(
  "/:caseId/:messageId/react",
  requireCaseAccess("caseId", { project: "withdrawnParalegalId hiredAt escrowStatus escrowIntentId paymentReleased tasksLocked" }),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Matter is read-only" });
    }
    const { caseId, messageId } = req.params;
    const { emoji } = req.body || {};
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    if (!validReaction(emoji)) return res.status(400).json({ error: "Choose a valid reaction." });

    const msg = await Message.findOne(scopedMessageFilter(req, { _id: messageId, caseId }));
    if (!msg) return res.status(404).json({ error: "Not found" });

    if (emoji) msg.removeReaction?.(String(emoji).trim(), req.user.id);
    try { await attorneyConversation.prepareMutation(req, msg); await msg.save(); }
    catch (error) { if (attorneyConversation.enabled(req)) return attorneyConversation.sendError(res, error); throw error; }

    await AuditLog.logFromReq(req, "message.react.remove", {
      targetType: "message",
      targetId: msg._id,
      caseId,
      meta: { emoji: emoji || null },
    });

    publishCaseEvent(caseId, "messages", { at: new Date().toISOString() });
    publishCaseProjectionRefresh(req.case, "message_refresh", { caseEvent: "" });
    res.json({ ok: true });
  })
);

/**
 * DELETE /api/messages/:caseId/:messageId
 * Soft delete (keeps history)
 */
router.delete(
  "/:caseId/:messageId",
  requireCaseAccess("caseId", { project: "withdrawnParalegalId hiredAt escrowStatus escrowIntentId paymentReleased tasksLocked" }),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Matter is read-only" });
    }
    const { caseId, messageId } = req.params;
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne(scopedMessageFilter(req, { _id: messageId, caseId }));
    if (!msg) return res.status(404).json({ error: "Not found" });

    const isOwner = String(msg.senderId) === String(req.user.id);
    if (!isOwner && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not allowed to delete" });
    }

    msg.deleted = true;
    msg.deletedBy = req.user.id;
    try { await attorneyConversation.prepareMutation(req, msg); await msg.save(); }
    catch (error) { if (attorneyConversation.enabled(req)) return attorneyConversation.sendError(res, error); throw error; }

    await AuditLog.logFromReq(req, "message.delete.soft", {
      targetType: "message",
      targetId: msg._id,
      caseId,
    });

    publishCaseEvent(caseId, "messages", { at: new Date().toISOString() });
    publishCaseProjectionRefresh(req.case, "message_refresh", { caseEvent: "" });
    res.json({ ok: true });
  })
);

router.use((error, req, res, next) => {
  if (attorneyConversation.enabled(req)) return attorneyConversation.sendError(res, error);
  return next(error);
});
module.exports = router;
