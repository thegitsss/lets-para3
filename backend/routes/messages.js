// backend/routes/messages.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireCaseAccess } = require("../utils/authz");
const Message = require("../models/Message");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog"); // match filename
const { containsProfanity, maskProfanity } = require("../utils/badWords");

// ----------------------------------------
// Optional CSRF (toggle via ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
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
  const trimmed = s.trim().replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 20000);
  return containsProfanity(trimmed) ? maskProfanity(trimmed) : trimmed;
}

// All message routes require auth
router.use(verifyToken);

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

    const caseFilter =
      req.user.role === "admin"
        ? {}
        : { $or: [{ attorney: req.user.id }, { paralegal: req.user.id }] };
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
      { $match: { case: { $in: caseIds }, deleted: { $ne: true } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$case",
          last: { $first: { type: "$type", content: "$content", createdAt: "$createdAt" } },
        },
      },
    ]);

    // Unread counts per case (checks both legacy readBy and new readReceipts.user)
    const unreadAgg = await Message.aggregate([
      { $match: { case: { $in: caseIds }, deleted: { $ne: true } } },
      {
        $match: {
          $and: [
            { $or: [{ readBy: { $ne: req.user.id } }, { readBy: { $exists: false } }] },
            {
              $or: [
                { "readReceipts.user": { $ne: new mongoose.Types.ObjectId(req.user.id) } },
                { readReceipts: { $exists: false } },
              ],
            },
          ],
        },
      },
      { $group: { _id: "$case", count: { $sum: 1 } } },
    ]);

    const lastByCase = new Map(lastMsgs.map((d) => [String(d._id), d.last]));
    const unreadByCase = new Map(unreadAgg.map((d) => [String(d._id), d.count]));

    const threads = caseItems.map((c) => {
      const last = lastByCase.get(String(c._id));
      const snippet =
        last?.type === "text" ? (last.content || "").slice(0, 140) : last ? `[${last.type}]` : "";
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
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });

    const before = req.query.before ? new Date(req.query.before) : null;
    const after = req.query.after ? new Date(req.query.after) : null;
    let limit = Number(req.query.limit) || 50;
    limit = Math.max(1, Math.min(100, limit));

    const q = { case: caseId, deleted: { $ne: true } };
    if (req.query.threadRoot && isObjId(req.query.threadRoot)) {
      q.$or = [
        { _id: new mongoose.Types.ObjectId(req.query.threadRoot) },
        { threadRoot: new mongoose.Types.ObjectId(req.query.threadRoot) },
      ];
    }

    if (after) q.createdAt = { ...(q.createdAt || {}), $gt: after };
    if (before) q.createdAt = { ...(q.createdAt || {}), $lte: before };
    if (!after && !before) q.createdAt = { $lte: new Date() };

    const items = await Message.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ messages: items.reverse() });
  })
);

/**
 * POST /api/messages/:caseId
 * Body: { type?: 'text', content, replyTo?, threadRoot? }
 */
router.post(
  "/:caseId",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });

    const type = String(req.body.type || "text").toLowerCase();
    if (type !== "text") return res.status(400).json({ error: "Only text supported here" });

    const content = sanitizeText(req.body.content);
    if (!content) return res.status(400).json({ error: "content required" });

    const payload = {
      case: caseId,
      sender: req.user.id,
      senderRole: req.user.role,
      type: "text",
      content,
    };

    // threading
    if (req.body.replyTo && isObjId(req.body.replyTo)) payload.replyTo = req.body.replyTo;
    if (req.body.threadRoot && isObjId(req.body.threadRoot)) payload.threadRoot = req.body.threadRoot;

    const msg = await Message.create(payload);

    await AuditLog.logFromReq(req, "message.create", {
      targetType: "message",
      targetId: msg._id,
      caseId,
      meta: { type: "text" },
    });

    res.status(201).json({ message: msg });
  })
);

/**
 * POST /api/messages/:caseId/file
 * Body: { fileKey, fileName, fileSize?, mimeType }
 */
router.post(
  "/:caseId/file",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { fileKey, fileName, mimeType, fileSize } = req.body || {};
    if (!fileKey || !fileName) return res.status(400).json({ error: "fileKey and fileName required" });

    const msg = await Message.create({
      case: req.params.caseId,
      sender: req.user.id,
      senderRole: req.user.role,
      type: "file",
      fileKey,
      fileName,
      fileSize: Number.isFinite(+fileSize) ? +fileSize : undefined,
      mimeType,
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
    const { fileKey, fileName, mimeType, transcript = "" } = req.body || {};
    if (!fileKey) return res.status(400).json({ error: "fileKey required" });
    if (!mimeType || !String(mimeType).startsWith("audio/")) {
      return res.status(400).json({ error: "mimeType must be audio/*" });
    }

    const msg = await Message.create({
      case: req.params.caseId,
      sender: req.user.id,
      senderRole: req.user.role,
      type: "audio",
      fileKey,
      fileName,
      mimeType,
      transcript: sanitizeText(transcript),
    });

    await AuditLog.logFromReq(req, "message.audio.create", {
      targetType: "message",
      targetId: msg._id,
      caseId: req.params.caseId,
    });

    res.status(201).json({ message: msg });
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

    // Mark legacy readBy
    const res1 = await Message.updateMany(
      { case: caseId, createdAt: { $lte: upTo }, deleted: { $ne: true } },
      { $addToSet: { readBy: req.user.id } }
    );

    // Add rich readReceipts without duplicates: set by user with $addToSet + fixed timestamp bucket
    const now = new Date();
    const res2 = await Message.updateMany(
      {
        case: caseId,
        createdAt: { $lte: upTo },
        deleted: { $ne: true },
        "readReceipts.user": { $ne: new mongoose.Types.ObjectId(req.user.id) },
      },
      { $push: { readReceipts: { user: req.user.id, at: now } } }
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
    const { caseId, messageId } = req.params;
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne({ _id: messageId, case: caseId });
    if (!msg) return res.status(404).json({ error: "Not found" });

    const isOwner = String(msg.sender) === String(req.user.id);
    const canEdit = isOwner || req.user.role === "admin";

    const { content, pin, unpin } = req.body || {};

    if (typeof content === "string") {
      if (!canEdit) return res.status(403).json({ error: "Not allowed to edit" });
      msg.content = sanitizeText(content);
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
    const { caseId, messageId } = req.params;
    const { emoji } = req.body || {};
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });
    if (!emoji || !String(emoji).trim()) return res.status(400).json({ error: "emoji required" });

    const msg = await Message.findOne({ _id: messageId, case: caseId });
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
    const { caseId, messageId } = req.params;
    const { emoji } = req.body || {};
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne({ _id: messageId, case: caseId });
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
    const { caseId, messageId } = req.params;
    if (!isObjId(messageId)) return res.status(400).json({ error: "Invalid messageId" });

    const msg = await Message.findOne({ _id: messageId, case: caseId });
    if (!msg) return res.status(404).json({ error: "Not found" });

    const isOwner = String(msg.sender) === String(req.user.id);
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
