// backend/routes/messages.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const { requireApproved, requireRole, requireCaseAccess } = require("../utils/authz");
const Message = require("../models/Message");
const Case = require("../models/Case");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog"); // match filename
const { notifyUser } = require("../utils/notifyUser");
const { containsProfanity, maskProfanity } = require("../utils/badWords");
const { CASE_STATE, normalizeCaseStatus, canUseWorkspace } = require("../utils/caseState");
const { BLOCKED_MESSAGE, getBlockedUserIds, isBlockedBetween } = require("../utils/blocks");

// ----------------------------------------
// CSRF (enabled in production or when ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);

function sanitizeText(s) {
  if (typeof s !== "string") return "";
  const stripped = s.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!stripped) return "";
  const limited = stripped.slice(0, 2000);
  return containsProfanity(limited) ? maskProfanity(limited) : limited;
}

function buildCaseAccessFilter(user) {
  if (!user) return {};
  if (user.role === "admin") return {};
  return { $or: [{ attorney: user.id }, { paralegal: user.id }] };
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

async function createMessageNotification({ caseDoc, senderDoc, previewText }) {
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

  const senderName = `${senderDoc.firstName || ""} ${senderDoc.lastName || ""}`.trim() || "Someone";
  try {
    await notifyUser(recipientId, "message", {
      caseId: caseDoc._id,
      caseTitle: caseDoc.title || "Case",
      fromName: senderName,
      messageSnippet: buildShortPreview(previewText, 40),
    }, { actorUserId: senderId });
  } catch (err) {
    console.warn("[messages] notifyUser failed", err);
  }
}

function buildUnreadClause(userObjectId) {
  return {
    $and: [
      { readBy: { $not: { $elemMatch: { $eq: userObjectId } } } },
      { readReceipts: { $not: { $elemMatch: { user: userObjectId } } } },
    ],
  };
}

function isCaseReadOnly(req) {
  return !!(req.case?.readOnly && !req.acl?.isAdmin);
}

function assertMessagingOpen(req, res) {
  const caseDoc = req.case;
  if (!caseDoc) {
    return res.status(400).json({ error: "Case not loaded" });
  }
  const escrowStatus = String(caseDoc.escrowStatus || "").toLowerCase();
  const escrowFunded = !!caseDoc.escrowIntentId && escrowStatus === "funded";
  const status = normalizeCaseStatus(caseDoc.status);
  const hasParalegal = caseDoc.paralegal || caseDoc.paralegalId;
  if (!hasParalegal) {
    return res.status(403).json({ error: "Messaging is available after hire" });
  }
  if (!escrowFunded) {
    return res.status(403).json({ error: "Work begins once payment is secured." });
  }
  if (!canUseWorkspace(caseDoc, { viewerId: req.user?.id })) {
    if (["completed", "closed", "cancelled", "disputed"].includes(status)) {
      return res.status(403).json({ error: "Messaging is closed for this case." });
    }
    return res.status(403).json({ error: "Messaging unlocks once the case is funded and in progress." });
  }
  return null;
}

function resolveSenderRole(req) {
  if (req?.acl?.isAdmin) return "admin";
  if (req?.acl?.isParalegal) return "paralegal";
  if (req?.acl?.isAttorney) return "attorney";
  return String(req?.user?.role || "");
}

// All message routes require auth
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));

router.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const caseFilter = await buildMessagingCaseFilter(req.user);
    const caseDocs = await Case.find(caseFilter).select("_id").lean();
    if (!caseDocs.length) {
      return res.json({ count: 0 });
    }
    const caseIds = caseDocs.map((doc) => doc._id);
    const requesterObjectId = new mongoose.Types.ObjectId(req.user.id);
    const unreadClause = buildUnreadClause(requesterObjectId);
    const aggregateResult = await Message.aggregate([
      { $match: { caseId: { $in: caseIds }, deleted: { $ne: true } } },
      { $match: unreadClause },
      { $count: "count" },
    ]);
    const totalUnread = aggregateResult[0]?.count || 0;
    res.json({ count: totalUnread });
  })
);

router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const filter = await buildMessagingCaseFilter(req.user);
    const caseDocs = await Case.find(filter).select("_id title").lean();
    if (!caseDocs.length) {
      return res.json({ items: [] });
    }
    const userDoc = await User.findById(req.user.id).select("messageLastViewedAt");
    const lastMap = userDoc?.messageLastViewedAt || new Map();
    const items = [];
    for (const doc of caseDocs) {
      const key = String(doc._id);
      const lastViewed =
        typeof lastMap.get === "function" ? lastMap.get(key) : lastMap?.[key];
      const query = { caseId: doc._id, deleted: { $ne: true } };
      if (lastViewed) query.createdAt = { $gt: new Date(lastViewed) };
      const unread = await Message.countDocuments(query);
      items.push({
        caseId: key,
        title: doc.title || "Case",
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
    const { q = "" } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const caseFilter = await buildMessagingCaseFilter(req.user);
    if (q.trim()) caseFilter.title = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const [caseItems, totalCases] = await Promise.all([
      Case.find(caseFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).select("_id title createdAt").lean(),
      Case.countDocuments(caseFilter),
    ]);
    const caseIds = caseItems.map((c) => c._id);

    if (caseIds.length === 0) {
      return res.json({ page, limit, total: totalCases, pages: Math.ceil(totalCases / limit), threads: [] });
    }

    // Last message per case (aggregation to avoid N+1)
    const lastMsgs = await Message.aggregate([
      { $match: { caseId: { $in: caseIds }, deleted: { $ne: true } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$caseId",
          last: { $first: { type: "$type", text: "$text", fileName: "$fileName", createdAt: "$createdAt" } },
        },
      },
    ]);

    // Unread counts per case (checks both legacy readBy and new readReceipts.user)
    const requesterObjectId = new mongoose.Types.ObjectId(req.user.id);
    const unreadClause = buildUnreadClause(requesterObjectId);
    const unreadAgg = await Message.aggregate([
      { $match: { caseId: { $in: caseIds }, deleted: { $ne: true } } },
      { $match: unreadClause },
      { $group: { _id: "$caseId", count: { $sum: 1 } } },
    ]);

    const lastByCase = new Map(lastMsgs.map((d) => [String(d._id), d.last]));
    const unreadByCase = new Map(unreadAgg.map((d) => [String(d._id), d.count]));

    const threads = caseItems.map((c) => {
      const last = lastByCase.get(String(c._id));
      let snippet = "";
      if (last) {
        if (last.type === "text") snippet = (last.text || "").slice(0, 140);
        else if (last.type === "file") snippet = last.fileName ? `[file] ${last.fileName}` : "[file]";
        else if (last.type === "audio") snippet = "[audio message]";
        else snippet = `[${last.type}]`;
      }
      return {
        id: String(c._id),
        title: c.title,
        lastMessageSnippet: snippet,
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

router.use("/:caseId", ensureCaseParticipant(), ensureNotBlockedForCase);

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
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    const { caseId } = req.params;
    const items = await Message.find({ caseId, deleted: { $ne: true } })
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

    return res.json({ messages: items });
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
      return res.status(403).json({ error: "Case is read-only" });
    }

    const text = sanitizeText(req.body?.text);
    if (!text) return res.status(400).json({ error: "text required" });

    const senderDocPromise = User.findById(req.user.id).select("firstName lastName role").lean();

    const msg = await Message.create({
      caseId,
      senderId: req.user.id,
      senderRole: resolveSenderRole(req),
      type: "text",
      text,
      content: text,
    });

    await AuditLog.logFromReq(req, "message_sent", {
      targetType: "case",
      targetId: caseId,
      meta: { messageId: msg._id },
    });

    try {
      const senderDoc = await senderDocPromise;
      await createMessageNotification({
        caseDoc,
        senderDoc,
        previewText: text,
      });
    } catch (err) {
      console.warn("[messages] notification creation failed", err);
    }

    return res.status(201).json({ message: msg });
  })
);

/**
 * POST /api/messages/:caseId/file
 * Body: { fileKey, fileName, fileSize?, mimeType }
 * NOTE: kept for future attachment workflows even if unused today.
 */
router.post(
  "/:caseId/file",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Case is read-only" });
    }
    const { fileKey, fileName, mimeType, fileSize } = req.body || {};
    if (!fileKey || !fileName) return res.status(400).json({ error: "fileKey and fileName required" });

    const size = Number.isFinite(+fileSize) ? +fileSize : undefined;
    const msg = await Message.create({
      caseId: req.params.caseId,
      senderId: req.user.id,
      senderRole: resolveSenderRole(req),
      type: "file",
      text: fileName,
      fileKey,
      fileName,
      fileSize: size ?? null,
      mimeType,
      content: {
        size,
      },
    });

    await AuditLog.logFromReq(req, "message.file.create", {
      targetType: "message",
      targetId: msg._id,
      caseId: req.params.caseId,
    });

    res.status(201).json({ message: msg });
  })
);

/**
 * POST /api/messages/:caseId/voice
 * Body: { fileKey, fileName?, mimeType, transcript? }
 */
router.post(
  "/:caseId/voice",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Case is read-only" });
    }
    const { fileKey, fileName, mimeType, transcript = "" } = req.body || {};
    if (!fileKey) return res.status(400).json({ error: "fileKey required" });
    if (!mimeType || !String(mimeType).startsWith("audio/")) {
      return res.status(400).json({ error: "mimeType must be audio/*" });
    }

    const safeTranscript = sanitizeText(transcript);
    const msg = await Message.create({
      caseId: req.params.caseId,
      senderId: req.user.id,
      senderRole: resolveSenderRole(req),
      type: "audio",
      text: safeTranscript,
      fileKey,
      fileName,
      mimeType,
      transcript: safeTranscript,
      content: { transcript: safeTranscript },
    });

    await AuditLog.logFromReq(req, "message.audio.create", {
      targetType: "message",
      targetId: msg._id,
      caseId: req.params.caseId,
    });

    res.status(201).json({ message: msg });
  })
);

router.post(
  "/:caseId/summary",
  requireCaseAccess("caseId"),
  asyncHandler(async (_req, res) => {
    res.json({ summary: "Summary endpoint placeholder." });
  })
);

/**
 * POST /api/messages/:caseId/read
 * Body: { upTo?: ISO date }
 * Marks messages as read by current user (writes both legacy readBy and rich readReceipts).
 */
router.post(
  "/:caseId/read",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const upTo = req.body.upTo ? new Date(req.body.upTo) : new Date();
    const readerId = new mongoose.Types.ObjectId(req.user.id);
    const caseObjectId = new mongoose.Types.ObjectId(caseId);

    // Mark legacy readBy
    const res1 = await Message.updateMany(
      { caseId: caseObjectId, createdAt: { $lte: upTo }, deleted: { $ne: true } },
      { $addToSet: { readBy: readerId } }
    );

    // Add rich readReceipts without duplicates: set by user with $addToSet + fixed timestamp bucket
    const now = new Date();
    const res2 = await Message.updateMany(
      {
        caseId: caseObjectId,
        createdAt: { $lte: upTo },
        deleted: { $ne: true },
        "readReceipts.user": { $ne: readerId },
      },
      { $push: { readReceipts: { user: readerId, at: now } } }
    );

    await AuditLog.logFromReq(req, "message.read.mark", {
      targetType: "case",
      targetId: caseId,
      caseId,
      meta: { upTo },
    });

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
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Case is read-only" });
    }
    const { caseId, messageId } = req.params;
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne({ _id: messageId, caseId });
    if (!msg) return res.status(404).json({ error: "Not found" });

    const isOwner = String(msg.senderId) === String(req.user.id);
    const canEdit = isOwner || req.user.role === "admin";

    const { content, pin, unpin } = req.body || {};

    if (typeof content === "string") {
      if (!canEdit) return res.status(403).json({ error: "Not allowed to edit" });
      const nextText = sanitizeText(content);
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

    await msg.save();
    await AuditLog.logFromReq(req, "message.update", {
      targetType: "message",
      targetId: msg._id,
      caseId,
      meta: { edited: typeof content === "string", pinned: msg.pinned },
    });

    res.json({ ok: true });
  })
);

/**
 * POST /api/messages/:caseId/:messageId/react
 * Body: { emoji }  — add reaction; DELETE same path to remove
 */
router.post(
  "/:caseId/:messageId/react",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Case is read-only" });
    }
    const { caseId, messageId } = req.params;
    const { emoji } = req.body || {};
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });
    if (!emoji || !String(emoji).trim()) return res.status(400).json({ error: "emoji required" });

    const msg = await Message.findOne({ _id: messageId, caseId });
    if (!msg) return res.status(404).json({ error: "Not found" });

    msg.addReaction?.(String(emoji).trim(), req.user.id);
    await msg.save();

    await AuditLog.logFromReq(req, "message.react.add", {
      targetType: "message",
      targetId: msg._id,
      caseId,
      meta: { emoji },
    });

    res.status(201).json({ ok: true });
  })
);

router.delete(
  "/:caseId/:messageId/react",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Case is read-only" });
    }
    const { caseId, messageId } = req.params;
    const { emoji } = req.body || {};
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne({ _id: messageId, caseId });
    if (!msg) return res.status(404).json({ error: "Not found" });

    if (emoji) msg.removeReaction?.(String(emoji).trim(), req.user.id);
    await msg.save();

    await AuditLog.logFromReq(req, "message.react.remove", {
      targetType: "message",
      targetId: msg._id,
      caseId,
      meta: { emoji: emoji || null },
    });

    res.json({ ok: true });
  })
);

/**
 * DELETE /api/messages/:caseId/:messageId
 * Soft delete (keeps history)
 */
router.delete(
  "/:caseId/:messageId",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const closed = assertMessagingOpen(req, res);
    if (closed) return;
    if (isCaseReadOnly(req)) {
      return res.status(403).json({ error: "Case is read-only" });
    }
    const { caseId, messageId } = req.params;
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne({ _id: messageId, caseId });
    if (!msg) return res.status(404).json({ error: "Not found" });

    const isOwner = String(msg.senderId) === String(req.user.id);
    if (!isOwner && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not allowed to delete" });
    }

    msg.deleted = true;
    msg.deletedBy = req.user.id;
    await msg.save();

    await AuditLog.logFromReq(req, "message.delete.soft", {
      targetType: "message",
      targetId: msg._id,
      caseId,
    });

    res.json({ ok: true });
  })
);

module.exports = router;
