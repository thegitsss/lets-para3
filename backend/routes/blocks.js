const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:blocks");
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved } = require("../utils/authz");
const Case = require("../models/Case");
const Block = require("../models/Block");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const { withActiveAccountWrite, accountChanged } = require("../utils/activeAccountWrite");
const { caseParticipantIdentity, conflictMessage } = require("../utils/caseParticipantIdentity");
const {
  ACTIVE_BLOCK_FILTER,
  BLOCKED_MESSAGE,
  BLOCK_NOT_ELIGIBLE_MESSAGE,
  createOrActivateBlock,
  deactivateBlock,
  getCaseInteractionBlockStatus,
  getCaseCounterparty,
  isBlockableRole,
  isBlockPairAllowed,
  normalizeId,
} = require("../utils/blocks");
const { protectMutations } = require("../utils/csrf");
const { publishInteractionAccessRefresh } = require("../utils/interactionAccessEvents");
const blockedSettings = require("../utils/blockedSettingsGuard");
const accountWriteGuard = require("../utils/accountWriteGuard");

const isObjId = (val) => mongoose.Types.ObjectId.isValid(val);
const normalizeReason = (value = "") =>
  typeof value === "string" ? value.trim().slice(0, 2000) : "";
const contextFields = "attorney attorneyId paralegal paralegalId withdrawnParalegalId status pausedReason disputes disputeSettlement payoutFinalizedAt payoutFinalizedType partialPayoutAmount paymentReleased applicants".split(" ");
const contextChanged = () => new accountWriteGuard.AccountWriteError(409, "BLOCK_CONTEXT_CHANGED", "This Matter or applicant changed. Refresh the Matter before blocking future interaction.");

router.use(verifyToken, requireApproved);
router.use(protectMutations);

// GET /api/blocks - list who the requester has blocked
router.get("/", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const guarded = blockedSettings.owner(req, req.query);
    if (Object.keys(req.query).some(key => /^cursor(?:\.|\[)/.test(key) || key === "cursor" && !guarded)) throw accountWriteGuard.invalid();
    if (guarded) {
      if (Object.hasOwn(req.query, "cursor") && (typeof req.query.cursor !== "string" || !req.query.cursor)) throw accountWriteGuard.invalid();
      return res.json(await blockedSettings.page(req.user.id, req.query.cursor));
    }
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
    if (accountWriteGuard.respond(err, res)) return;
    runtimeLogger.error("[blocks] list error", err);
    return res.status(500).json({ error: "Unable to load blocks." });
  }
});

// Owner-bound direct-block readback; a reciprocal block is never projected here.
router.get("/:blockedId", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    if (!blockedSettings.owner(req, req.query) || !blockedSettings.validId(req.params.blockedId)) throw accountWriteGuard.invalid();
    return res.json(await blockedSettings.status(req.user.id, req.params.blockedId));
  } catch (err) {
    if (accountWriteGuard.respond(err, res)) return;
    runtimeLogger.error("[blocks] status error", err);
    return res.status(500).json({ error: "Unable to check this block." });
  }
});

// POST /api/blocks { caseId, paralegalId?, reason? }
router.post("/", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const guarded = blockedSettings.owner(req);
    const expectedBlockedId = req.body?.expectedBlockedId;
    if (Object.keys(req.body || {}).some(key => /^expectedBlockedId(?:\.|\[)/.test(key)) || expectedBlockedId !== undefined && (!guarded || !blockedSettings.validId(expectedBlockedId))) throw accountWriteGuard.invalid();
    const { caseId, paralegalId, reason } = req.body || {};
    const requesterRole = String(req.user.role || "").toLowerCase();
    if (!isBlockableRole(requesterRole)) {
      return res.status(403).json({ error: "Blocking is only available to attorneys and paralegals." });
    }
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "A valid caseId is required to block future interaction." });
    }

    const source = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseId) }, { projection: Object.fromEntries(contextFields.map(key => [key, 1])) });
    const caseDoc = source ? Case.hydrate(source) : null;
    if (!caseDoc) return res.status(404).json({ error: "Matter not found." });
    if (["attorney", "paralegal"].some(role => caseDoc.$errors?.[role] || caseDoc.$errors?.[`${role}Id`] || caseParticipantIdentity(caseDoc, normalizeId(caseDoc[role] || caseDoc[`${role}Id`])).identityConflict)) throw new accountWriteGuard.AccountWriteError(409, "CASE_IDENTITY_CONFLICT", conflictMessage);

    const screeningApplicant = requesterRole === "attorney" && isObjId(paralegalId);
    const counterparty = screeningApplicant ? null : getCaseCounterparty(caseDoc, req.user);
    if (!screeningApplicant && !counterparty?.counterpartyId) {
      return res.status(403).json({ error: BLOCK_NOT_ELIGIBLE_MESSAGE });
    }
    const requesterId = normalizeId(req.user.id || req.user._id);
    const participants = new Set([
      normalizeId(caseDoc.attorney || caseDoc.attorneyId),
      normalizeId(caseDoc.paralegal || caseDoc.paralegalId),
      normalizeId(caseDoc.withdrawnParalegalId),
    ].filter(Boolean));
    if (!participants.has(requesterId)) {
      return res.status(403).json({ error: "You do not have access to block users for this Matter." });
    }

    let targetId = counterparty?.counterpartyId || "";
    let targetRole = counterparty?.counterpartyRole || "";
    let sourceType = "";
    let sourceDisputeId = "";
    let alreadyBlocked = null;

    if (requesterRole === "attorney" && isObjId(paralegalId)) {
      const caseParalegalId = normalizeId(caseDoc.paralegal || caseDoc.paralegalId);
      const isAssignedParalegal = caseParalegalId && String(caseParalegalId) === String(paralegalId);
      const applicants = Array.isArray(caseDoc.applicants) ? caseDoc.applicants : [];
      const activeApplicantStatuses = new Set(["pending", "submitted", "viewed", "shortlisted"]);
      const isApplicant = applicants.some((entry) =>
        normalizeId(entry?.paralegalId) === String(paralegalId) &&
        activeApplicantStatuses.has(String(entry?.status || "pending").toLowerCase())
      );
      if (!isApplicant || isAssignedParalegal) {
        return res.status(403).json({ error: "Only active applicants can be blocked from the Applicants view." });
      }
      targetId = String(paralegalId);
      targetRole = "paralegal";
      sourceType = "application_screening";
    } else {
      const status = await getCaseInteractionBlockStatus(caseDoc, req.user);
      if (status.blocked) alreadyBlocked = status;
      if (!status.blocked && !status.canBlock) {
        return res.status(403).json({ error: status.reason || BLOCK_NOT_ELIGIBLE_MESSAGE });
      }
      targetId = status.counterpartyId || targetId;
      targetRole = status.counterpartyRole || targetRole;
      sourceType = status.sourceType || "";
      sourceDisputeId = status.sourceDisputeId || "";
    }

    if (expectedBlockedId !== undefined && expectedBlockedId.toLowerCase() !== String(targetId).toLowerCase()) throw contextChanged();

    const target = await User.findById(targetId).select("role firstName lastName");
    if (!target) return res.status(404).json({ error: "User not found." });

    // Private safety action: do not notify the blocked user by email, notification, or chat.
    const result = await withActiveAccountWrite([requesterId], async session => {
      const currentOwner = await User.findById(requesterId).select("role").session(session);
      if (currentOwner?.role !== requesterRole) throw accountChanged();
      if (req.authSessionId) {
        const active = await AuthSession.updateOne({ userId: requesterId, sessionId: req.authSessionId, revokedAt: null, expiresAt: { $gt: new Date() } }, { $set: { lastSeenAt: new Date() } }, { session });
        if (!active.matchedCount) throw accountChanged();
      }
      const currentTarget = await User.findById(target._id).select("role").session(session);
      if (!currentTarget || currentTarget.role !== target.role || !isBlockPairAllowed(requesterRole, currentTarget.role)) throw contextChanged();
      // Source fields arbitrate hiring/outcome changes without overwriting an
      // independent private note or introducing a new blocking eligibility rule.
      const unchanged = await Case.collection.updateOne({ _id: source._id, $and: contextFields.map(key => Object.hasOwn(source, key) ? { [key]: { $eq: source[key], $exists: true } } : { [key]: { $exists: false } }) }, { $inc: { __v: 1 } }, { session });
      if (!unchanged.matchedCount) throw contextChanged();
      if (alreadyBlocked) {
        const retained = await Block.findOne({ ...ACTIVE_BLOCK_FILTER, $or: [{ blockerId: requesterId, blockedId: target._id }, { blockerId: target._id, blockedId: requesterId }] }).session(session).lean();
        if (!retained) throw contextChanged();
        return { status: await getCaseInteractionBlockStatus(caseDoc, req.user, retained) };
      }
      return createOrActivateBlock({
        blockerId: requesterId, blockedId: target._id, blockerRole: requesterRole,
        blockedRole: target.role || targetRole, sourceCaseId: caseDoc._id,
        sourceDisputeId, sourceType: sourceType || "legacy", reason: normalizeReason(reason),
      }, { session });
    }, { ownerId: requesterId, authVersion: req.authVersion ?? req.auth?.payload?.av ?? 0 });
    if (result.status) return res.json({ ok: true, blocked: true, message: BLOCKED_MESSAGE, block: result.status });
    result.block.$session?.(null);

    // Blocking remains private: this creates no notification record or email.
    // Both parties' open sessions still need an opaque authorization refresh
    // so stale discovery/workspace screens cannot retain invalid access.
    await publishInteractionAccessRefresh({
      requesterId: req.user.id,
      targetId: target._id,
      sourceCaseId: caseDoc._id,
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
    if (accountWriteGuard.respond(err, res)) return;
    if (["ACCOUNT_CHANGED", "ACCOUNT_WRITE_CHANGED", "ACCOUNT_WRITE_UNCONFIRMED"].includes(err?.publicCode)) return res.status(err.status).json({ error: err.message, code: err.publicCode });
    if (err?.code === 11000) {
      return res.status(200).json({ ok: true, blocked: true });
    }
    runtimeLogger.error("[blocks] create error", err);
    return res.status(500).json({ error: "Unable to block user." });
  }
});

// DELETE /api/blocks/:blockedId
router.delete("/:blockedId", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const guarded = blockedSettings.owner(req);
    if (!guarded && Object.hasOwn(req.body || {}, "expectedBlockRevision")) throw accountWriteGuard.invalid();
    const { blockedId } = req.params;
    if (!isObjId(blockedId)) return res.status(400).json({ error: "Invalid blockedId" });

    if (guarded) {
      const block = await blockedSettings.remove(req, blockedId);
      await publishInteractionAccessRefresh({ requesterId: req.user.id, targetId: blockedId, sourceCaseId: block.sourceCaseId || null });
      return res.json({ ok: true, blocked: false, blockedId: String(blockedId) });
    }

    const activeBlock = await Block.findOne({
      blockerId: req.user.id,
      blockedId,
      ...ACTIVE_BLOCK_FILTER,
    }).select("sourceCaseId").lean();

    // Private safety action: do not notify the other user when a block is removed.
    await deactivateBlock({ blockerId: req.user.id, blockedId });
    await publishInteractionAccessRefresh({
      requesterId: req.user.id,
      targetId: blockedId,
      sourceCaseId: activeBlock?.sourceCaseId || null,
    });
    return res.json({ ok: true, blocked: false });
  } catch (err) {
    if (accountWriteGuard.respond(err, res)) return;
    runtimeLogger.error("[blocks] delete error", err);
    return res.status(500).json({ error: "Unable to unblock user." });
  }
});

module.exports = router;
