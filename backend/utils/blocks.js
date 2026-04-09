const Block = require("../models/Block");

const BLOCKED_MESSAGE =
  "Future interaction between these users is unavailable on Let's ParaConnect.";
const BLOCK_NOT_ELIGIBLE_MESSAGE =
  "Blocking is only available after a dispute or withdrawal has been fully finalized.";

const ACTIVE_BLOCK_FILTER = { active: { $ne: false } };
const WITHDRAWAL_ZERO_TYPES = new Set(["zero_auto", "expired_zero"]);
const WITHDRAWAL_PARTIAL_TYPES = new Set(["partial_attorney"]);
const DISPUTE_SETTLEMENT_ACTIONS = new Set(["refund", "release_full", "release_partial"]);

const normalizeId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value._id) return String(value._id);
    if (value.id) return String(value.id);
  }
  return String(value);
};

const normalizeRole = (value) => String(value || "").trim().toLowerCase();

function isBlockableRole(role) {
  const normalized = normalizeRole(role);
  return normalized === "attorney" || normalized === "paralegal";
}

function isBlockPairAllowed(roleA, roleB) {
  const a = normalizeRole(roleA);
  const b = normalizeRole(roleB);
  return isBlockableRole(a) && isBlockableRole(b) && a !== b;
}

function getActiveBlockQuery(userId, otherId) {
  return {
    ...ACTIVE_BLOCK_FILTER,
    $or: [
      { blockerId: userId, blockedId: otherId },
      { blockerId: otherId, blockedId: userId },
    ],
  };
}

function getDirectBlockQuery(blockerId, blockedId) {
  return {
    blockerId,
    blockedId,
  };
}

function getCaseAttorneyId(caseDoc) {
  return normalizeId(caseDoc?.attorneyId || caseDoc?.attorney);
}

function getCaseParalegalId(caseDoc) {
  return normalizeId(caseDoc?.paralegalId || caseDoc?.paralegal);
}

function getCaseWithdrawnParalegalId(caseDoc) {
  return normalizeId(caseDoc?.withdrawnParalegalId);
}

function getCaseCounterparty(caseDoc, requester = {}) {
  const requesterId = normalizeId(requester?.id || requester?._id);
  const requesterRole = normalizeRole(requester?.role);
  if (!requesterId || !isBlockableRole(requesterRole)) return null;

  if (requesterRole === "attorney") {
    const withdrawnParalegalId = getCaseWithdrawnParalegalId(caseDoc);
    const activeParalegalId = getCaseParalegalId(caseDoc);
    const counterpartyId = withdrawnParalegalId || activeParalegalId;
    if (!counterpartyId || counterpartyId === requesterId) return null;
    return {
      counterpartyId,
      counterpartyRole: "paralegal",
    };
  }

  if (requesterRole === "paralegal") {
    const attorneyId = getCaseAttorneyId(caseDoc);
    const activeParalegalId = getCaseParalegalId(caseDoc);
    const withdrawnParalegalId = getCaseWithdrawnParalegalId(caseDoc);
    const isActiveParalegal = activeParalegalId && activeParalegalId === requesterId;
    const isWithdrawnParalegal = withdrawnParalegalId && withdrawnParalegalId === requesterId;
    if ((!isActiveParalegal && !isWithdrawnParalegal) || !attorneyId || attorneyId === requesterId) {
      return null;
    }
    return {
      counterpartyId: attorneyId,
      counterpartyRole: "attorney",
    };
  }

  return null;
}

function hasOpenDispute(caseDoc) {
  return (caseDoc?.disputes || []).some(
    (entry) => normalizeRole(entry?.status) === "open"
  );
}

function getResolvedDisputeMeta(caseDoc) {
  const settlement = caseDoc?.disputeSettlement || {};
  const settlementAction = String(settlement.action || "");
  if (settlement.resolvedAt && DISPUTE_SETTLEMENT_ACTIONS.has(settlementAction)) {
    return {
      sourceType: "resolved_dispute",
      sourceDisputeId: settlement.disputeId || "",
      label: "Resolved dispute",
    };
  }

  const resolvedDispute = (caseDoc?.disputes || []).find(
    (entry) => normalizeRole(entry?.status) === "resolved"
  );
  if (
    resolvedDispute &&
    caseDoc?.payoutFinalizedAt &&
    normalizeRole(caseDoc?.payoutFinalizedType) === "admin"
  ) {
    return {
      sourceType: "resolved_dispute",
      sourceDisputeId: resolvedDispute.disputeId || normalizeId(resolvedDispute?._id),
      label: "Resolved dispute",
    };
  }

  return null;
}

function getWithdrawalBlockMeta(caseDoc) {
  if (normalizeRole(caseDoc?.pausedReason) !== "paralegal_withdrew" || !caseDoc?.payoutFinalizedAt) {
    return null;
  }
  const payoutType = normalizeRole(caseDoc?.payoutFinalizedType);
  const grossPayout = Math.max(0, Math.round(Number(caseDoc?.partialPayoutAmount || 0)));

  if (WITHDRAWAL_ZERO_TYPES.has(payoutType) && grossPayout === 0) {
    return {
      sourceType: "withdrawal_zero_payout",
      sourceDisputeId: "",
      label: "Finalized withdrawal",
    };
  }

  if (WITHDRAWAL_PARTIAL_TYPES.has(payoutType) && grossPayout > 0) {
    return {
      sourceType: "withdrawal_partial_payout",
      sourceDisputeId: "",
      label: "Finalized withdrawal payout",
    };
  }

  return null;
}

function getClosedCaseBlockMeta(caseDoc) {
  const status = normalizeRole(caseDoc?.status);
  if (status === "completed" || status === "closed" || caseDoc?.paymentReleased === true) {
    return {
      sourceType: "closed_case",
      sourceDisputeId: "",
      label: "Completed case",
    };
  }
  return null;
}

function getCaseBlockEligibility(caseDoc, requester = {}) {
  const requesterId = normalizeId(requester?.id || requester?._id);
  const requesterRole = normalizeRole(requester?.role);
  const counterparty = getCaseCounterparty(caseDoc, requester);
  const caseStatus = normalizeRole(caseDoc?.status);

  if (!requesterId || !counterparty) {
    return {
      eligible: false,
      reason: BLOCK_NOT_ELIGIBLE_MESSAGE,
      counterpartyId: "",
      counterpartyRole: "",
      sourceType: "",
      sourceDisputeId: "",
      label: "",
    };
  }

  if (!isBlockPairAllowed(requesterRole, counterparty.counterpartyRole)) {
    return {
      eligible: false,
      reason: "Blocking is only available between attorneys and paralegals.",
      counterpartyId: counterparty.counterpartyId,
      counterpartyRole: counterparty.counterpartyRole,
      sourceType: "",
      sourceDisputeId: "",
      label: "",
    };
  }

  if (
    requesterRole === "attorney" &&
    (caseStatus === "open" || caseStatus === "in progress")
  ) {
    return {
      eligible: false,
      reason: "Blocking is only available from a finalized case outcome, not from an active workspace.",
      counterpartyId: "",
      counterpartyRole: "",
      sourceType: "",
      sourceDisputeId: "",
      label: "",
    };
  }

  if (hasOpenDispute(caseDoc)) {
    return {
      eligible: false,
      reason: "Blocking is unavailable while a dispute is still open.",
      counterpartyId: counterparty.counterpartyId,
      counterpartyRole: counterparty.counterpartyRole,
      sourceType: "",
      sourceDisputeId: "",
      label: "",
    };
  }

  if (
    normalizeRole(caseDoc?.pausedReason) === "paralegal_withdrew" &&
    !caseDoc?.payoutFinalizedAt
  ) {
    return {
      eligible: false,
      reason: "Blocking is unavailable until the withdrawal payout decision is finalized.",
      counterpartyId: counterparty.counterpartyId,
      counterpartyRole: counterparty.counterpartyRole,
      sourceType: "",
      sourceDisputeId: "",
      label: "",
    };
  }

  const disputeMeta = getResolvedDisputeMeta(caseDoc);
  if (disputeMeta) {
    return {
      eligible: true,
      reason: "",
      counterpartyId: counterparty.counterpartyId,
      counterpartyRole: counterparty.counterpartyRole,
      ...disputeMeta,
    };
  }

  const withdrawalMeta = getWithdrawalBlockMeta(caseDoc);
  if (withdrawalMeta) {
    return {
      eligible: true,
      reason: "",
      counterpartyId: counterparty.counterpartyId,
      counterpartyRole: counterparty.counterpartyRole,
      ...withdrawalMeta,
    };
  }

  const closedCaseMeta = getClosedCaseBlockMeta(caseDoc);
  if (closedCaseMeta) {
    return {
      eligible: true,
      reason: "",
      counterpartyId: counterparty.counterpartyId,
      counterpartyRole: counterparty.counterpartyRole,
      ...closedCaseMeta,
    };
  }

  return {
    eligible: false,
    reason: BLOCK_NOT_ELIGIBLE_MESSAGE,
    counterpartyId: counterparty.counterpartyId,
    counterpartyRole: counterparty.counterpartyRole,
    sourceType: "",
    sourceDisputeId: "",
    label: "",
  };
}

async function findActiveBlockBetween(userId, otherId) {
  const a = normalizeId(userId);
  const b = normalizeId(otherId);
  if (!a || !b || a === b) return null;
  return Block.findOne(getActiveBlockQuery(a, b)).lean();
}

async function isBlockedBetween(userId, otherId) {
  const existing = await findActiveBlockBetween(userId, otherId);
  return !!existing;
}

async function getBlockedUserIds(userId) {
  const id = normalizeId(userId);
  if (!id) return [];
  const blocks = await Block.find({
    ...ACTIVE_BLOCK_FILTER,
    $or: [{ blockerId: id }, { blockedId: id }],
  })
    .select("blockerId blockedId")
    .lean();
  const ids = new Set();
  blocks.forEach((block) => {
    const blocker = normalizeId(block.blockerId);
    const blocked = normalizeId(block.blockedId);
    if (blocker === id && blocked) ids.add(blocked);
    if (blocked === id && blocker) ids.add(blocker);
  });
  return [...ids];
}

async function getBlocksForUser(userId) {
  const id = normalizeId(userId);
  if (!id) return [];
  return Block.find({
    ...ACTIVE_BLOCK_FILTER,
    $or: [{ blockerId: id }, { blockedId: id }],
  }).lean();
}

function buildBlockLookup(userId, blocks = []) {
  const id = normalizeId(userId);
  const lookup = new Map();
  blocks.forEach((block) => {
    const blockerId = normalizeId(block.blockerId);
    const blockedId = normalizeId(block.blockedId);
    if (!blockerId || !blockedId) return;
    if (blockerId === id) {
      lookup.set(blockedId, { ...block, blockedByRequester: true });
    } else if (blockedId === id) {
      lookup.set(blockerId, { ...block, blockedByRequester: false });
    }
  });
  return lookup;
}

async function getCaseInteractionBlockStatus(caseDoc, requester, existingBlock = null) {
  const requesterId = normalizeId(requester?.id || requester?._id);
  const eligibility = getCaseBlockEligibility(caseDoc, requester);
  if (!requesterId || !eligibility.counterpartyId) {
    return {
      blocked: false,
      canBlock: false,
      blockedByRequester: false,
      counterpartyId: "",
      counterpartyRole: "",
      sourceType: "",
      reason: eligibility.reason || BLOCK_NOT_ELIGIBLE_MESSAGE,
      label: "",
      caseId: normalizeId(caseDoc?._id),
    };
  }

  const blockRecord =
    existingBlock || (await findActiveBlockBetween(requesterId, eligibility.counterpartyId));
  const blocked = !!blockRecord;
  const blockedByRequester =
    blocked && normalizeId(blockRecord.blockerId) === requesterId;

  return {
    blocked,
    canBlock: !blocked && eligibility.eligible,
    blockedByRequester,
    counterpartyId: eligibility.counterpartyId,
    counterpartyRole: eligibility.counterpartyRole,
    sourceType: eligibility.sourceType || blockRecord?.sourceType || "",
    sourceDisputeId: eligibility.sourceDisputeId || blockRecord?.sourceDisputeId || "",
    reason:
      blocked
        ? blockedByRequester
          ? "Future interaction is already blocked."
          : "The other user has already blocked future interaction."
        : eligibility.reason || "",
    label: eligibility.label || "",
    createdAt: blockRecord?.createdAt || null,
    caseId: normalizeId(caseDoc?._id),
  };
}

async function createOrActivateBlock({
  blockerId,
  blockedId,
  blockerRole,
  blockedRole,
  sourceCaseId = null,
  sourceDisputeId = "",
  sourceType = "legacy",
  reason = "",
}) {
  const directQuery = getDirectBlockQuery(blockerId, blockedId);
  const payload = {
    blockerRole: normalizeRole(blockerRole),
    blockedRole: normalizeRole(blockedRole),
    sourceCaseId: sourceCaseId || null,
    sourceDisputeId: String(sourceDisputeId || "").trim(),
    sourceType: String(sourceType || "legacy").trim() || "legacy",
    reason: typeof reason === "string" ? reason.trim().slice(0, 2000) : "",
    active: true,
    deactivatedAt: null,
  };

  const existing = await Block.findOne(directQuery);
  if (existing) {
    existing.set(payload);
    await existing.save();
    return { created: false, block: existing };
  }

  const created = await Block.create({
    blockerId,
    blockedId,
    ...payload,
  });
  return { created: true, block: created };
}

async function deactivateBlock({ blockerId, blockedId }) {
  const existing = await Block.findOne({
    ...getDirectBlockQuery(blockerId, blockedId),
    ...ACTIVE_BLOCK_FILTER,
  });
  if (!existing) return false;
  existing.active = false;
  existing.deactivatedAt = new Date();
  await existing.save();
  return true;
}

module.exports = {
  ACTIVE_BLOCK_FILTER,
  BLOCKED_MESSAGE,
  BLOCK_NOT_ELIGIBLE_MESSAGE,
  buildBlockLookup,
  createOrActivateBlock,
  deactivateBlock,
  findActiveBlockBetween,
  getBlockedUserIds,
  getBlocksForUser,
  getCaseBlockEligibility,
  getCaseCounterparty,
  getCaseInteractionBlockStatus,
  isBlockedBetween,
  isBlockableRole,
  isBlockPairAllowed,
  normalizeId,
  normalizeRole,
};
