"use strict";

const mongoose = require("mongoose");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const PaymentOperation = require("../models/PaymentOperation");
const FinancialAdjustment = require("../models/FinancialAdjustment");
const { operationFingerprint } = require("./paymentOperationService");
const { pickStripeMode, stripeModeFromLivemode } = require("../utils/stripeMode");

const PROCESSOR_STATES = new Set([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
]);
const TERMINAL_PROCESSOR_STATES = new Set(["won", "lost", "warning_closed"]);
const PROCESSOR_STATE_RANK = Object.freeze({
  unknown: 0,
  warning_needs_response: 1,
  needs_response: 1,
  warning_under_review: 2,
  under_review: 2,
  warning_closed: 3,
  won: 3,
  lost: 3,
});
const SUCCESSFUL_PAYOUT = Object.freeze({
  $or: [{ status: "paid" }, { status: { $exists: false } }, { status: null }, { status: "" }],
});

function chargebackOperationKey(disputeId) {
  return `chargeback:${String(disputeId || "")}`;
}

function normalizeProcessorStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return PROCESSOR_STATES.has(normalized) ? normalized : "unknown";
}

function stripeEventDate(event) {
  const seconds = Number(event?.created);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Math.round(seconds * 1000)) : new Date();
}

function shouldAcceptProcessorState(currentStatus, currentAt, incomingStatus, incomingAt) {
  const current = normalizeProcessorStatus(currentStatus);
  const incoming = normalizeProcessorStatus(incomingStatus);
  if (!currentAt) return true;
  const currentTime = new Date(currentAt).getTime();
  const incomingTime = new Date(incomingAt).getTime();
  if (incomingTime < currentTime) return false;
  if (TERMINAL_PROCESSOR_STATES.has(current)) {
    return current === incoming && incomingTime >= currentTime;
  }
  if (incomingTime > currentTime) return true;
  return (PROCESSOR_STATE_RANK[incoming] || 0) >= (PROCESSOR_STATE_RANK[current] || 0);
}

function normalizeObject(value) {
  if (!value) return null;
  return typeof value === "string" ? { id: value } : value;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function disputeBalanceTransactionValues(dispute) {
  const source = dispute?.balance_transactions;
  if (Array.isArray(source)) return source;
  if (Array.isArray(source?.data)) return source.data;
  return [];
}

async function retrieveChargeAndIntent(dispute, stripeClient, stripeOptions = {}) {
  let charge = normalizeObject(dispute?.charge);
  if (!charge?.id) return { charge: null, paymentIntent: null, reasons: ["charge_unmatched"] };
  if (!charge.payment_intent) {
    charge = await stripeClient.charges.retrieve(charge.id, { expand: ["payment_intent"] }, stripeOptions);
  }
  let paymentIntent = normalizeObject(charge?.payment_intent);
  if (paymentIntent?.id && !paymentIntent.metadata) {
    paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntent.id, stripeOptions);
  }
  if (!paymentIntent?.id) return { charge, paymentIntent: null, reasons: ["payment_intent_unmatched"] };
  return { charge, paymentIntent, reasons: [] };
}

async function resolveCaseAssociation({ dispute, stripeClient, stripeOptions = {}, CaseModel = Case }) {
  let external;
  try {
    external = await retrieveChargeAndIntent(dispute, stripeClient, stripeOptions);
  } catch (_error) {
    return { caseDoc: null, charge: null, paymentIntent: null, reasons: ["external_evidence_unavailable"] };
  }
  if (external.reasons.length) return { ...external, caseDoc: null };
  const { charge, paymentIntent } = external;
  const candidateIds = new Set();
  for (const value of [dispute?.metadata?.caseId, charge?.metadata?.caseId, paymentIntent?.metadata?.caseId]) {
    if (mongoose.isValidObjectId(value)) candidateIds.add(String(value));
  }
  const [metadataCases, intentCases] = await Promise.all([
    candidateIds.size ? CaseModel.find({ _id: { $in: [...candidateIds] } }) : [],
    CaseModel.find({
      $or: [{ paymentIntentId: paymentIntent.id }, { escrowIntentId: paymentIntent.id }],
    }),
  ]);
  const candidates = new Map();
  [...metadataCases, ...intentCases].forEach((caseDoc) => candidates.set(String(caseDoc._id), caseDoc));
  if (!candidates.size) return { caseDoc: null, charge, paymentIntent, reasons: ["case_unmatched"] };
  if (candidates.size > 1) return { caseDoc: null, charge, paymentIntent, reasons: ["case_ambiguous"] };
  const caseDoc = [...candidates.values()][0];
  const recordedIntentIds = [caseDoc.paymentIntentId, caseDoc.escrowIntentId].filter(Boolean).map(String);
  if (recordedIntentIds.length && !recordedIntentIds.includes(String(paymentIntent.id))) {
    return { caseDoc: null, charge, paymentIntent, reasons: ["case_payment_intent_conflict"] };
  }
  return { caseDoc, charge, paymentIntent, reasons: [] };
}

async function retrieveDisputeBalanceTransactions(dispute, stripeClient, stripeOptions = {}) {
  const transactions = [];
  for (const value of disputeBalanceTransactionValues(dispute)) {
    let transaction = normalizeObject(value);
    if (!transaction?.id) continue;
    if (
      safeInteger(transaction.amount) === null ||
      safeInteger(transaction.fee) === null ||
      !transaction.currency
    ) {
      transaction = await stripeClient.balanceTransactions.retrieve(transaction.id, stripeOptions);
    }
    transactions.push(transaction);
  }
  return [...new Map(transactions.map((transaction) => [String(transaction.id), transaction])).values()];
}

function buildAdjustmentCandidates({ dispute, charge, event, balanceTransactions, stripeMode }) {
  const candidates = [];
  for (const transaction of balanceTransactions) {
    const amount = safeInteger(transaction.amount);
    const fee = safeInteger(transaction.fee);
    const currency = String(transaction.currency || dispute.currency || "").toLowerCase();
    const evidence = {
      currency,
      stripeDisputeId: String(dispute.id),
      stripeChargeId: String(charge?.id || ""),
      stripeBalanceTransactionId: String(transaction.id),
      stripeEventId: String(event.id),
      stripeMode,
      stripeEvidenceCreatedAt: transaction.created
        ? new Date(Number(transaction.created) * 1000)
        : stripeEventDate(event),
    };
    const transactionCategory = String(transaction.reporting_category || transaction.type || "").toLowerCase();
    const isFeeTransaction = transactionCategory.includes("fee");
    if (amount) {
      const direction = amount < 0 ? "debit" : "credit";
      candidates.push({
        ...evidence,
        idempotencyKey: `chargeback-adjustment:${dispute.id}:${transaction.id}:${isFeeTransaction ? "fee" : "principal"}`,
        adjustmentType: isFeeTransaction
          ? (direction === "debit" ? "processor_dispute_fee" : "processor_fee_recovery")
          : (direction === "debit" ? "chargeback_principal" : "chargeback_recovery"),
        direction,
        amount: Math.abs(amount),
      });
    }
    if (fee && !isFeeTransaction) {
      const direction = fee > 0 ? "debit" : "credit";
      candidates.push({
        ...evidence,
        idempotencyKey: `chargeback-adjustment:${dispute.id}:${transaction.id}:fee`,
        adjustmentType: direction === "debit" ? "processor_dispute_fee" : "processor_fee_recovery",
        direction,
        amount: Math.abs(fee),
      });
    }
  }
  return candidates;
}

function adjustmentMatches(existing, expected) {
  return [
    "paymentOperationId",
    "caseId",
    "adjustmentType",
    "direction",
    "amount",
    "currency",
    "stripeDisputeId",
    "stripeChargeId",
    "stripeBalanceTransactionId",
    "stripeMode",
  ].every((field) => String(existing?.[field] ?? "") === String(expected?.[field] ?? ""));
}

async function appendAdjustment(candidate, dependencies) {
  const { FinancialAdjustmentModel } = dependencies;
  try {
    const adjustment = await FinancialAdjustmentModel.create(candidate);
    return { adjustment, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await FinancialAdjustmentModel.findOne({ idempotencyKey: candidate.idempotencyKey });
    if (!existing || !adjustmentMatches(existing, candidate)) {
      throw new Error(`Financial adjustment evidence conflict for ${candidate.idempotencyKey}.`);
    }
    return { adjustment: existing, created: false };
  }
}

async function payoutPositionForCase(caseDoc, PayoutModel = Payout, PaymentOperationModel = PaymentOperation) {
  if (!caseDoc) return "unknown";
  if (caseDoc.paymentReleased || caseDoc.payoutTransferId) return "post_payout";
  const [paid, transferEvidence] = await Promise.all([
    PayoutModel.exists({ caseId: caseDoc._id, ...SUCCESSFUL_PAYOUT }),
    PaymentOperationModel.exists({
      caseId: caseDoc._id,
      kind: { $in: ["case_payout", "partial_payout", "dispute_settlement"] },
      $or: [
        { stripeTransferId: { $nin: [null, ""] } },
        { stripeObjectId: /^tr_/ },
      ],
    }),
  ]);
  return paid || transferEvidence ? "post_payout" : "pre_payout";
}

async function hasRefundOverlap(caseDoc, charge, PaymentOperationModel = PaymentOperation) {
  if (Number(charge?.amount_refunded || 0) > 0) return true;
  if (!caseDoc?._id) return false;
  if (["refunded", "partially_refunded"].includes(String(caseDoc.paymentStatus || "").toLowerCase())) {
    return true;
  }
  return Boolean(await PaymentOperationModel.exists({
    caseId: caseDoc._id,
    kind: "refund",
    status: "succeeded",
    refundAmount: { $gt: 0 },
  }));
}

async function updateProcessorProjection(
  operation,
  incomingStatus,
  incomingAt,
  incomingEventId,
  update,
  PaymentOperationModel
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = attempt ? await PaymentOperationModel.findById(operation._id) : operation;
    if (!current) throw new Error("Chargeback operation disappeared during reconciliation.");
    const accepts = shouldAcceptProcessorState(
      current.processorStatus,
      current.processorEventCreatedAt,
      incomingStatus,
      incomingAt
    );
    const filter = { _id: current._id, updatedAt: current.updatedAt };
    const set = { ...update };
    if (accepts) {
      set.processorStatus = incomingStatus;
      set.processorEventCreatedAt = incomingAt;
      set.stripeEventId = String(incomingEventId || "");
      if (current.stripeEventId && String(current.stripeEventId) !== String(incomingEventId || "")) {
        set.administrativeStatus = "pending_review";
        set.acknowledgedAt = null;
        set.acknowledgedBy = null;
        set.status = "needs_reconciliation";
      }
    }
    const updated = await PaymentOperationModel.findOneAndUpdate(
      filter,
      { $set: set },
      { returnDocument: "after" }
    );
    if (updated) return { operation: updated, processorStateAccepted: accepts };
  }
  throw new Error("Chargeback operation changed concurrently; retry the event.");
}

async function recordChargebackEvent({
  event,
  dispute = event?.data?.object,
  stripeClient,
  stripeOptions = {},
  CaseModel = Case,
  PayoutModel = Payout,
  PlatformIncomeModel = PlatformIncome,
  PaymentOperationModel = PaymentOperation,
  FinancialAdjustmentModel = FinancialAdjustment,
}) {
  if (!dispute?.id) throw new Error("Stripe dispute identity is required.");
  const incomingStatus = normalizeProcessorStatus(dispute.status);
  const incomingAt = stripeEventDate(event);
  const stripeMode = pickStripeMode(
    stripeModeFromLivemode(dispute?.livemode),
    stripeModeFromLivemode(event?.livemode),
    "unknown"
  );
  const association = await resolveCaseAssociation({ dispute, stripeClient, stripeOptions, CaseModel });
  const payoutPosition = await payoutPositionForCase(
    association.caseDoc,
    PayoutModel,
    PaymentOperationModel
  );
  const operationKey = chargebackOperationKey(dispute.id);
  const amount = Math.max(0, Math.round(Number(dispute.amount || 0)));
  const currency = String(dispute.currency || association.charge?.currency || "usd").toLowerCase();
  let operation;
  try {
    operation = await PaymentOperationModel.findOneAndUpdate(
      { operationKey },
      {
        $setOnInsert: {
        operationKey,
        caseId: association.caseDoc?._id || undefined,
        kind: "chargeback",
        fingerprint: operationFingerprint({ stripeDisputeId: String(dispute.id) }),
        status: "needs_reconciliation",
        amount,
        currency,
        stripeObjectId: String(dispute.id),
        stripeDisputeId: String(dispute.id),
        stripeEventId: String(event.id || ""),
        stripeChargeId: String(association.charge?.id || ""),
        stripePaymentIntentId: String(association.paymentIntent?.id || ""),
        stripeMode,
        livemode: typeof dispute.livemode === "boolean" ? dispute.livemode : null,
        processorStatus: incomingStatus,
        processorEventCreatedAt: incomingAt,
        administrativeStatus: "pending_review",
        payoutPosition,
        attempts: 1,
        lastAttemptAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    operation = await PaymentOperationModel.findOne({ operationKey });
    if (!operation) throw error;
  }

  const reasons = [...association.reasons];
  if (
    TERMINAL_PROCESSOR_STATES.has(normalizeProcessorStatus(operation.processorStatus)) &&
    TERMINAL_PROCESSOR_STATES.has(incomingStatus) &&
    normalizeProcessorStatus(operation.processorStatus) !== incomingStatus
  ) reasons.push("processor_terminal_conflict");
  if (operation.caseId && association.caseDoc && String(operation.caseId) !== String(association.caseDoc._id)) {
    reasons.push("case_association_conflict");
  }
  if (operation.amount && amount && Number(operation.amount) !== amount) reasons.push("dispute_amount_conflict");
  if (operation.currency && currency && String(operation.currency) !== currency) reasons.push("dispute_currency_conflict");
  const refundOverlap = await hasRefundOverlap(association.caseDoc, association.charge, PaymentOperationModel);
  if (refundOverlap) reasons.push("refund_chargeback_overlap");

  let balanceTransactions = [];
  try {
    balanceTransactions = await retrieveDisputeBalanceTransactions(dispute, stripeClient, stripeOptions);
  } catch (_error) {
    reasons.push("balance_transaction_unavailable");
  }
  if (!balanceTransactions.length) reasons.push("balance_transaction_missing");
  for (const transaction of balanceTransactions) {
    if (
      safeInteger(transaction.amount) === null ||
      safeInteger(transaction.fee) === null ||
      safeInteger(transaction.net) === null ||
      !transaction.currency
    ) reasons.push("balance_transaction_invalid");
    if (
      safeInteger(transaction.amount) !== null &&
      safeInteger(transaction.fee) !== null &&
      safeInteger(transaction.net) !== null &&
      safeInteger(transaction.amount) - safeInteger(transaction.fee) !== safeInteger(transaction.net)
    ) reasons.push("balance_transaction_net_conflict");
    if (String(transaction.currency || "").toLowerCase() !== currency) {
      reasons.push("balance_transaction_currency_conflict");
    }
  }

  const quarantined = reasons.some((reason) =>
    reason.includes("unmatched") ||
    reason.includes("ambiguous") ||
    reason.includes("conflict") ||
    reason === "refund_chargeback_overlap"
  );
  const evidenceStatus = quarantined
    ? "quarantined"
    : reasons.length
      ? "needs_reconciliation"
      : "verified";
  const projectedEvidenceStatus =
    operation.evidenceStatus === "verified" && evidenceStatus === "needs_reconciliation"
      ? "verified"
      : evidenceStatus;
  const update = {
    status:
      operation.status === "succeeded" && projectedEvidenceStatus === "verified"
        ? "succeeded"
        : "needs_reconciliation",
    lastAttemptAt: new Date(),
    lastError: [...new Set(reasons)].join(",").slice(0, 2000),
    evidenceStatus: projectedEvidenceStatus,
  };
  if (!operation.caseId && association.caseDoc && !quarantined) update.caseId = association.caseDoc._id;
  if (!operation.stripeChargeId && association.charge?.id) update.stripeChargeId = String(association.charge.id);
  if (!operation.stripePaymentIntentId && association.paymentIntent?.id) {
    update.stripePaymentIntentId = String(association.paymentIntent.id);
  }
  if (!operation.amount && amount) update.amount = amount;
  if (operation.stripeMode === "unknown" && stripeMode !== "unknown") update.stripeMode = stripeMode;
  if (operation.livemode == null && typeof dispute.livemode === "boolean") update.livemode = dispute.livemode;
  if (
    payoutPosition === "post_payout" ||
    (operation.payoutPosition === "unknown" && payoutPosition !== "unknown")
  ) update.payoutPosition = payoutPosition;
  const projected = await updateProcessorProjection(
    operation,
    incomingStatus,
    incomingAt,
    event.id,
    update,
    PaymentOperationModel
  );
  operation = projected.operation;

  const adjustments = [];
  if (evidenceStatus === "verified" && balanceTransactions.length) {
    const platformIncome = association.caseDoc
      ? await PlatformIncomeModel.findOne({ caseId: association.caseDoc._id }).sort({ createdAt: -1 })
      : null;
    const candidates = buildAdjustmentCandidates({
      dispute,
      charge: association.charge,
      event,
      balanceTransactions,
      stripeMode,
    });
    for (const candidate of candidates) {
      const result = await appendAdjustment({
        ...candidate,
        paymentOperationId: operation._id,
        caseId: association.caseDoc?._id || null,
        platformIncomeId: platformIncome?._id || null,
      }, { FinancialAdjustmentModel });
      adjustments.push(result);
    }
  }
  return {
    operation,
    adjustments,
    reasons: [...new Set(reasons)],
    association,
    processorStateAccepted: projected.processorStateAccepted,
  };
}

async function chargebackExposure(paymentOperationId, { FinancialAdjustmentModel = FinancialAdjustment } = {}) {
  const totals = await FinancialAdjustmentModel.aggregate([
    { $match: { paymentOperationId: new mongoose.Types.ObjectId(String(paymentOperationId)) } },
    {
      $group: {
        _id: null,
        debits: { $sum: { $cond: [{ $eq: ["$direction", "debit"] }, "$amount", 0] } },
        credits: { $sum: { $cond: [{ $eq: ["$direction", "credit"] }, "$amount", 0] } },
        processorFees: {
          $sum: {
            $cond: [
              { $in: ["$adjustmentType", ["processor_dispute_fee", "processor_fee_recovery"]] },
              { $cond: [{ $eq: ["$direction", "debit"] }, "$amount", { $multiply: ["$amount", -1] }] },
              0,
            ],
          },
        },
      },
    },
  ]);
  const debits = totals[0]?.debits || 0;
  const credits = totals[0]?.credits || 0;
  return { debits, credits, processorFees: totals[0]?.processorFees || 0, netExposure: debits - credits };
}

async function acknowledgeChargeback(operationId, adminId, {
  PaymentOperationModel = PaymentOperation,
} = {}) {
  const operation = await PaymentOperationModel.findOne({ _id: operationId, kind: "chargeback" });
  if (!operation) return { found: false };
  if (["acknowledged", "hold_cleared"].includes(operation.administrativeStatus)) {
    return { found: true, changed: false, operation };
  }
  const updated = await PaymentOperationModel.findOneAndUpdate(
    { _id: operation._id, kind: "chargeback", administrativeStatus: "pending_review" },
    {
      $set: {
        administrativeStatus: "acknowledged",
        acknowledgedAt: new Date(),
        acknowledgedBy: adminId,
        ...(operation.evidenceStatus === "verified" ? { status: "succeeded", lastError: "" } : {}),
      },
    },
    { returnDocument: "after" }
  );
  return { found: true, changed: Boolean(updated), operation: updated || operation };
}

async function clearEligiblePayoutHold(operationId, adminId, {
  CaseModel = Case,
  PayoutModel = Payout,
  PaymentOperationModel = PaymentOperation,
} = {}) {
  const operation = await PaymentOperationModel.findOne({ _id: operationId, kind: "chargeback" });
  if (!operation) return { found: false };
  if (operation.administrativeStatus === "hold_cleared") {
    return { found: true, changed: false, operation };
  }
  if (
    operation.payoutPosition !== "pre_payout" ||
    operation.processorStatus !== "won" ||
    operation.evidenceStatus !== "verified" ||
    !operation.caseId
  ) {
    const error = new Error("This chargeback hold is not eligible to clear.");
    error.code = "CHARGEBACK_HOLD_NOT_ELIGIBLE";
    error.statusCode = 409;
    throw error;
  }
  const [caseDoc, paidPayout] = await Promise.all([
    CaseModel.findById(operation.caseId).select("paymentReleased payoutTransferId").lean(),
    PayoutModel.exists({ caseId: operation.caseId, ...SUCCESSFUL_PAYOUT }),
  ]);
  if (!caseDoc || caseDoc.paymentReleased || caseDoc.payoutTransferId || paidPayout) {
    const error = new Error("Payout evidence changed; the hold requires reconciliation.");
    error.code = "CHARGEBACK_HOLD_RECONCILIATION_REQUIRED";
    error.statusCode = 409;
    throw error;
  }
  const updated = await PaymentOperationModel.findOneAndUpdate(
    {
      _id: operation._id,
      kind: "chargeback",
      payoutPosition: "pre_payout",
      processorStatus: "won",
      evidenceStatus: "verified",
      administrativeStatus: { $in: ["pending_review", "acknowledged"] },
    },
    {
      $set: {
        administrativeStatus: "hold_cleared",
        payoutHoldClearedAt: new Date(),
        payoutHoldClearedBy: adminId,
        status: "succeeded",
        lastError: "",
      },
    },
    { returnDocument: "after" }
  );
  return { found: true, changed: Boolean(updated), operation: updated || operation };
}

module.exports = {
  PROCESSOR_STATES,
  TERMINAL_PROCESSOR_STATES,
  acknowledgeChargeback,
  buildAdjustmentCandidates,
  chargebackExposure,
  chargebackOperationKey,
  clearEligiblePayoutHold,
  normalizeProcessorStatus,
  recordChargebackEvent,
  resolveCaseAssociation,
  shouldAcceptProcessorState,
};
