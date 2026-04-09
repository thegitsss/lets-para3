const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const Case = require("../models/Case");
const Block = require("../models/Block");
const User = require("../models/User");
const {
  ACTIVE_BLOCK_FILTER,
  BLOCKED_MESSAGE,
  BLOCK_NOT_ELIGIBLE_MESSAGE,
  createOrActivateBlock,
  deactivateBlock,
  getCaseInteractionBlockStatus,
  getCaseCounterparty,
  isBlockableRole,
  normalizeId,
} = require("../utils/blocks");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const noop = (_req, _res, next) => next();
const csrf = require("csurf");
const csrfMiddleware = csrf({
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  },
});
const protectMutations = (req, res, next) => {
  const requireCsrf = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
  if (!requireCsrf) return noop(req, res, next);
  const method = String(req.method || "").toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  return csrfMiddleware(req, res, next);
};

const isObjId = (val) => mongoose.Types.ObjectId.isValid(val);
const normalizeReason = (value = "") =>
  typeof value === "string" ? value.trim().slice(0, 2000) : "";

router.use(verifyToken, requireApproved);
router.use(protectMutations);

// GET /api/blocks - list who the requester has blocked
router.get("/", async (req, res) => {
  try {
    const blocks = await Block.find({
      blockerId: req.user.id,
      ...ACTIVE_BLOCK_FILTER,
    })
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
          sourceType: block.sourceType || "",
          sourceCaseId: block.sourceCaseId ? String(block.sourceCaseId) : "",
          sourceDisputeId: block.sourceDisputeId || "",
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

// POST /api/blocks { caseId, paralegalId?, reason? }
router.post("/", async (req, res) => {
  try {
    const { caseId, paralegalId, reason } = req.body || {};
    const requesterRole = String(req.user.role || "").toLowerCase();
    if (!isBlockableRole(requesterRole)) {
      return res.status(403).json({ error: "Blocking is only available to attorneys and paralegals." });
    }
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "A valid caseId is required to block future interaction." });
    }

    const caseDoc = await Case.findById(caseId)
      .select(
        "attorney attorneyId paralegal paralegalId withdrawnParalegalId status pausedReason disputes disputeSettlement payoutFinalizedAt payoutFinalizedType partialPayoutAmount paymentReleased applicants"
      )
      .populate("withdrawnParalegalId", "firstName lastName role")
      .populate("paralegal", "firstName lastName role")
      .populate("attorney", "firstName lastName role");
    if (!caseDoc) return res.status(404).json({ error: "Case not found." });

    const counterparty = getCaseCounterparty(caseDoc, req.user);
    if (!counterparty?.counterpartyId) {
      return res.status(403).json({ error: BLOCK_NOT_ELIGIBLE_MESSAGE });
    }
    const requesterId = normalizeId(req.user.id || req.user._id);
    const participants = new Set([
      normalizeId(caseDoc.attorney || caseDoc.attorneyId),
      normalizeId(caseDoc.paralegal || caseDoc.paralegalId),
      normalizeId(caseDoc.withdrawnParalegalId),
    ].filter(Boolean));
    if (!participants.has(requesterId)) {
      return res.status(403).json({ error: "You do not have access to block users for this case." });
    }

    let targetId = counterparty.counterpartyId;
    let targetRole = counterparty.counterpartyRole;
    let sourceType = "";
    let sourceDisputeId = "";

    if (requesterRole === "attorney" && isObjId(paralegalId)) {
      const caseParalegalId = normalizeId(caseDoc.paralegal || caseDoc.paralegalId);
      const isAssignedParalegal = caseParalegalId && String(caseParalegalId) === String(paralegalId);
      const applicants = Array.isArray(caseDoc.applicants) ? caseDoc.applicants : [];
      const isApplicant = applicants.some((entry) => normalizeId(entry?.paralegalId) === String(paralegalId));
      if (!isApplicant || isAssignedParalegal) {
        return res.status(403).json({ error: "Only active applicants can be blocked from the Applicants view." });
      }
      targetId = String(paralegalId);
      targetRole = "paralegal";
      sourceType = "application_screening";
    } else {
      const status = await getCaseInteractionBlockStatus(caseDoc, req.user);
      if (status.blocked) {
        return res.json({ ok: true, blocked: true, message: BLOCKED_MESSAGE, block: status });
      }
      if (!status.canBlock) {
        return res.status(403).json({ error: status.reason || BLOCK_NOT_ELIGIBLE_MESSAGE });
      }
      targetId = status.counterpartyId || targetId;
      targetRole = status.counterpartyRole || targetRole;
      sourceType = status.sourceType || "";
      sourceDisputeId = status.sourceDisputeId || "";
    }

    const target = await User.findById(targetId).select("role firstName lastName");
    if (!target) return res.status(404).json({ error: "User not found." });

    // Private safety action: do not notify the blocked user by email, notification, or chat.
    const result = await createOrActivateBlock({
      blockerId: req.user.id,
      blockedId: target._id,
      blockerRole: requesterRole,
      blockedRole: target.role || targetRole,
      sourceCaseId: caseDoc._id,
      sourceDisputeId,
      sourceType: sourceType || "legacy",
      reason: normalizeReason(reason),
    });

    return res.status(result.created ? 201 : 200).json({
      ok: true,
      blocked: true,
      block: {
        blockedId: String(result.block.blockedId),
        createdAt: result.block.createdAt,
        sourceType: result.block.sourceType || "",
        sourceCaseId: result.block.sourceCaseId ? String(result.block.sourceCaseId) : "",
        sourceDisputeId: result.block.sourceDisputeId || "",
        reason: result.block.reason || "",
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

    // Private safety action: do not notify the other user when a block is removed.
    await deactivateBlock({ blockerId: req.user.id, blockedId });
    return res.json({ ok: true, blocked: false });
  } catch (err) {
    console.error("[blocks] delete error", err);
    return res.status(500).json({ error: "Unable to unblock user." });
  }
});

module.exports = router;
