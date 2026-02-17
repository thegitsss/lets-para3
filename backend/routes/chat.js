const express = require("express");
const router = express.Router();

const auth = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const Message = require("../models/Message");
const Case = require("../models/Case");
const { normalizeCaseStatus, canUseWorkspace } = require("../utils/caseState");
const { BLOCKED_MESSAGE, isBlockedBetween } = require("../utils/blocks");

// CSRF (enabled in production or when ENABLE_CSRF=true)
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

function normalizeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value._id) return value._id.toString();
  if (typeof value === "object" && value.toString) return value.toString();
  return null;
}

async function loadCaseForMessaging(caseId) {
  const c = await Case.findById(caseId)
    .select("attorneyId paralegalId escrowIntentId escrowStatus status")
    .populate("attorneyId", "firstName lastName email role")
    .populate("paralegalId", "firstName lastName email role")
    .lean();

  return c || null;
}

function canAccessCase(caseDoc, userId) {
  if (!caseDoc) return false;
  const attorneyId = normalizeId(caseDoc.attorneyId);
  const paralegalId = normalizeId(caseDoc.paralegalId);
  const user = String(userId);
  return attorneyId === user || paralegalId === user;
}

function assertMessagingOpen(caseDoc) {
  if (!caseDoc) return "Case not found";
  const hasParalegal = !!caseDoc.paralegalId;
  if (!hasParalegal) return "Messaging is available after hire";
  const escrowFunded = !!caseDoc.escrowIntentId && String(caseDoc.escrowStatus || "").toLowerCase() === "funded";
  if (!escrowFunded) return "Work begins once payment is secured.";
  if (!canUseWorkspace(caseDoc)) {
    const status = normalizeCaseStatus(caseDoc.status);
    if (["completed", "closed", "disputed"].includes(status)) {
      return "Messaging is closed for this case.";
    }
    return "Messaging unlocks once the case is funded and in progress.";
  }
  return "";
}

async function assertNotBlocked(caseDoc, user) {
  const role = String(user?.role || "").toLowerCase();
  if (!["attorney", "paralegal"].includes(role)) return "";
  const otherId =
    role === "attorney" ? normalizeId(caseDoc.paralegalId) : normalizeId(caseDoc.attorneyId);
  if (!otherId) return "";
  const blocked = await isBlockedBetween(user._id, otherId);
  return blocked ? BLOCKED_MESSAGE : "";
}

// All chat routes require authenticated platform roles
router.use(auth, requireApproved, requireRole("admin", "attorney", "paralegal"));

/**
 * GET /api/chat/:caseId
 * Get message history for a case
 */
router.get("/:caseId", async (req, res) => {
  try {
    const { caseId } = req.params;

    // 1. Verify case belongs to this user
    const caseDoc = await loadCaseForMessaging(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const authorized = canAccessCase(caseDoc, req.user._id);
    if (!authorized) return res.status(403).json({ error: "Unauthorized case access" });
    const blockedMsg = await assertNotBlocked(caseDoc, req.user);
    if (blockedMsg) return res.status(403).json({ error: blockedMsg });
    const gateMessage = assertMessagingOpen(caseDoc);
    if (gateMessage) return res.status(403).json({ error: gateMessage });

    // 2. Fetch messages
    const messages = await Message.find({ caseId })
      .sort({ createdAt: 1 })
      .populate("senderId", "firstName lastName email role");

    res.json(messages);
  } catch (err) {
    console.error("Chat history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/chat/:caseId
 * Send a new message
 */
router.post("/:caseId", csrfProtection, async (req, res) => {
  try {
    const { caseId } = req.params;
    const { text } = req.body;

    if (!text || text.trim() === "") {
      return res.status(400).json({ error: "Text message cannot be empty" });
    }

    // 1. Verify case belongs to this user
    const caseDoc = await loadCaseForMessaging(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const authorized = canAccessCase(caseDoc, req.user._id);
    if (!authorized) return res.status(403).json({ error: "Unauthorized case access" });
    const blockedMsg = await assertNotBlocked(caseDoc, req.user);
    if (blockedMsg) return res.status(403).json({ error: blockedMsg });
    const gateMessage = assertMessagingOpen(caseDoc);
    if (gateMessage) return res.status(403).json({ error: gateMessage });

    // 2. Create the message
    const safeText = text.trim();
    const message = await Message.create({
      caseId,
      senderId: req.user._id,
      senderRole: req.user.role,
      type: "text",
      text: safeText,
      content: safeText,
    });

    res.json(message);
  } catch (err) {
    console.error("Chat send error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PUT /api/chat/:caseId/seen
 * Mark messages as seen (future real-time badge integration placeholder).
 */
router.put("/:caseId/seen", csrfProtection, async (req, res) => {
  try {
    const { caseId } = req.params;

    // 1. Verify case belongs to this user
    const caseDoc = await loadCaseForMessaging(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const authorized = canAccessCase(caseDoc, req.user._id);
    if (!authorized) return res.status(403).json({ error: "Unauthorized case access" });
    const blockedMsg = await assertNotBlocked(caseDoc, req.user);
    if (blockedMsg) return res.status(403).json({ error: blockedMsg });
    const gateMessage = assertMessagingOpen(caseDoc);
    if (gateMessage) return res.status(403).json({ error: gateMessage });

    // 2. Mark messages as seen
    await Message.updateMany(
      { caseId, seen: false, senderId: { $ne: req.user._id } },
      { seen: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Chat seen error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
