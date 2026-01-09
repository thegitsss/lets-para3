const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const Block = require("../models/Block");
const User = require("../models/User");
const { BLOCKED_MESSAGE, isBlockPairAllowed, isBlockableRole } = require("../utils/blocks");

const isObjId = (val) => mongoose.Types.ObjectId.isValid(val);
const normalizeReason = (value = "") =>
  typeof value === "string" ? value.trim().slice(0, 2000) : "";

router.use(verifyToken, requireApproved);

// GET /api/blocks - list who the requester has blocked
router.get("/", async (req, res) => {
  try {
    const blocks = await Block.find({ blockerId: req.user.id })
      .sort({ createdAt: -1 })
      .populate("blockedId", "firstName lastName role")
      .lean();

    const items = blocks
      .map((block) => {
        const user = block.blockedId && typeof block.blockedId === "object" ? block.blockedId : null;
        if (!user) return null;
        return {
          blockedId: String(user._id || block.blockedId),
          name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User",
          role: user.role || "",
          reason: block.reason || "",
          createdAt: block.createdAt || null,
        };
      })
      .filter(Boolean);

    return res.json(items);
  } catch (err) {
    console.error("[blocks] list error", err);
    return res.status(500).json({ error: "Unable to load blocks." });
  }
});

// POST /api/blocks { blockedId, reason? }
router.post("/", async (req, res) => {
  try {
    const { blockedId, reason } = req.body || {};
    if (!isObjId(blockedId)) return res.status(400).json({ error: "Invalid blockedId" });
    if (String(blockedId) === String(req.user.id)) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    const requesterRole = String(req.user.role || "").toLowerCase();
    if (!isBlockableRole(requesterRole)) {
      return res.status(403).json({ error: "Blocking is only available to attorneys and paralegals." });
    }

    const target = await User.findById(blockedId).select("role firstName lastName");
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!isBlockPairAllowed(requesterRole, target.role)) {
      return res.status(400).json({ error: "Blocking is only available between attorneys and paralegals." });
    }

    const existing = await Block.findOne({ blockerId: req.user.id, blockedId: target._id }).select("_id");
    if (existing) {
      return res.json({ ok: true, blocked: true, message: BLOCKED_MESSAGE });
    }

    const created = await Block.create({
      blockerId: req.user.id,
      blockedId: target._id,
      reason: normalizeReason(reason),
    });

    return res.status(201).json({
      ok: true,
      blocked: true,
      block: {
        blockedId: String(created.blockedId),
        createdAt: created.createdAt,
        reason: created.reason || "",
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(200).json({ ok: true, blocked: true });
    }
    console.error("[blocks] create error", err);
    return res.status(500).json({ error: "Unable to block user." });
  }
});

// DELETE /api/blocks/:blockedId
router.delete("/:blockedId", async (req, res) => {
  try {
    const { blockedId } = req.params;
    if (!isObjId(blockedId)) return res.status(400).json({ error: "Invalid blockedId" });

    await Block.deleteOne({ blockerId: req.user.id, blockedId });
    return res.json({ ok: true, blocked: false });
  } catch (err) {
    console.error("[blocks] delete error", err);
    return res.status(500).json({ error: "Unable to unblock user." });
  }
});

module.exports = router;
