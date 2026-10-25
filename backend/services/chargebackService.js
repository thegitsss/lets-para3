"use strict";

const mongoose = require("mongoose");
const FinancialAdjustment = require("../models/FinancialAdjustment");

const PROCESSOR_STATES = new Set([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "prevented",
]);
const TERMINAL_PROCESSOR_STATES = new Set(["won", "lost", "warning_closed", "prevented"]);
const PROCESSOR_STATE_RANK = Object.freeze({
  unknown: 0,
  warning_needs_response: 1,
  needs_response: 1,
  warning_under_review: 2,
  under_review: 2,
  warning_closed: 3,
  won: 3,
  lost: 3,
  prevented: 3,
});

function chargebackOperationKey(disputeId) {
  return `chargeback:${String(disputeId || "")}`;
}

function normalizeProcessorStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return PROCESSOR_STATES.has(normalized) ? normalized : "unknown";
}

function stripeEventDate(event) {
  const seconds = event?.created;
  return Number.isSafeInteger(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? new Date(seconds * 1000) : null;
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

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
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
      stripeEvidenceCreatedAt: stripeEventDate({ created: transaction.created }),
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

async function recordChargebackEvent(options) {
  return require("./attorneyChargebackEvents").record(options);
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

async function acknowledgeChargeback(operationId, adminId, options = {}) {
  return require("./attorneyChargebackEvents").changeReview({ ...options, operationId, actorId: adminId, action: "acknowledge" });
}

async function clearEligiblePayoutHold(operationId, adminId, options = {}) {
  return require("./attorneyChargebackEvents").changeReview({ ...options, operationId, actorId: adminId, action: "clear-hold" });
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
  shouldAcceptProcessorState,
};
