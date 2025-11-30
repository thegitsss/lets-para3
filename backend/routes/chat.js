const express = require("express");
const router = express.Router();

const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const Message = require("../models/Message");
const Case = require("../models/Case");

/**
 * Helper: ensure user belongs to a case
 */
function normalizeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value._id) return value._id.toString();
  if (typeof value === "object" && value.toString) return value.toString();
  return null;
}

async function ensureCaseAccess(caseId, userId) {
  const c = await Case.findById(caseId)
    .select("attorneyId paralegalId")
    .populate("attorneyId", "firstName lastName email role")
    .populate("paralegalId", "firstName lastName email role")
    .lean();

  if (!c) return false;

  const attorneyId = normalizeId(c.attorneyId);
  const paralegalId = normalizeId(c.paralegalId);
  const user = String(userId);

  return attorneyId === user || paralegalId === user;
}

// All chat routes require authenticated platform roles
router.use(auth, requireRole(["admin", "attorney", "paralegal"]));

/**
 * GET /api/chat/:caseId
 * Get message history for a case
 */
router.get("/:caseId", async (req, res) => {
  try {
    const { caseId } = req.params;

    // 1. Verify case belongs to this user
    const authorized = await ensureCaseAccess(caseId, req.user._id);
    if (!authorized)
      return res.status(403).json({ error: "Unauthorized case access" });

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
router.post("/:caseId", async (req, res) => {
  try {
    const { caseId } = req.params;
    const { text } = req.body;

    if (!text || text.trim() === "") {
      return res.status(400).json({ error: "Text message cannot be empty" });
    }

    // 1. Verify case belongs to this user
    const authorized = await ensureCaseAccess(caseId, req.user._id);
    if (!authorized)
      return res.status(403).json({ error: "Unauthorized case access" });

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
router.put("/:caseId/seen", async (req, res) => {
  try {
    const { caseId } = req.params;

    // 1. Verify case belongs to this user
    const authorized = await ensureCaseAccess(caseId, req.user._id);
    if (!authorized)
      return res.status(403).json({ error: "Unauthorized case access" });

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
