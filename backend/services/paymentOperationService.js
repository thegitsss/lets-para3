const PaymentOperation = require("../models/PaymentOperation");
const { operationFingerprint } = require("../utils/paymentOperationFingerprint");

const STALE_PENDING_MS = 10 * 60 * 1000;
const TRANSFER_OPERATION_KINDS = Object.freeze(["case_payout", "partial_payout", "dispute_settlement"]);
const unresolvedTransfer = { kind: { $in: TRANSFER_OPERATION_KINDS }, evidenceStatus: "needs_reconciliation", stripeTransferId: { $in: ["", null] } };
const quarantinedTransfer = { kind: { $in: TRANSFER_OPERATION_KINDS }, evidenceStatus: "quarantined" };
const verifiedRefundForTransfer = { $or: [{ stripeRefundId: { $in: ["", null] } }, { refundStatus: "succeeded", refundEvidenceStatus: "verified", refundVerifiedAt: { $type: "date" } }] };

async function claimPaymentOperation({ operationKey, caseId, kind, fingerprint, amount = 0, currency = "usd" }) {
  const normalizedFingerprint = operationFingerprint(fingerprint);
  const now = new Date();
  try {
    const operation = await PaymentOperation.create({
      operationKey,
      caseId,
      kind,
      fingerprint: normalizedFingerprint,
      amount,
      currency,
      status: "pending",
      lastAttemptAt: now,
    });
    return { acquired: true, operation };
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  const existing = await PaymentOperation.findOne({ operationKey });
  if (!existing) throw new Error("Payment operation could not be claimed.");
  if (existing.fingerprint !== normalizedFingerprint) {
    return { acquired: false, conflict: true, operation: existing };
  }
  if (TRANSFER_OPERATION_KINDS.includes(existing.kind) && existing.evidenceStatus === "quarantined") {
    return { acquired: false, inProgress: true, needsReconciliation: true, operation: existing };
  }
  if (await require("./refundRequestService").hasUnresolvedRefundRequest(existing)) {
    return { acquired: false, inProgress: true, needsReconciliation: true, operation: existing };
  }
  if (existing.status === "succeeded") {
    return { acquired: false, completed: true, operation: existing };
  }
  if (TRANSFER_OPERATION_KINDS.includes(existing.kind) && existing.evidenceStatus === "needs_reconciliation" && !existing.stripeTransferId) {
    return { acquired: false, inProgress: true, needsReconciliation: true, operation: existing };
  }
  const stale = !existing.lastAttemptAt || now.getTime() - existing.lastAttemptAt.getTime() >= STALE_PENDING_MS;
  if (existing.status === "pending" && !stale) {
    return { acquired: false, inProgress: true, operation: existing };
  }

  const reclaimed = await PaymentOperation.findOneAndUpdate(
    {
      _id: existing._id,
      fingerprint: normalizedFingerprint,
      attempts: existing.attempts,
      evidenceStatus: existing.evidenceStatus ?? null,
      stripeTransferId: existing.stripeTransferId || { $in: ["", null] },
      $nor: [unresolvedTransfer, quarantinedTransfer],
      $or: [
        { status: { $in: ["failed", "needs_reconciliation"] } },
        { status: "pending", lastAttemptAt: { $lte: new Date(now.getTime() - STALE_PENDING_MS) } },
      ],
    },
    {
      $set: { status: "pending", lastAttemptAt: now, lastError: "" },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" }
  );
  return reclaimed
    ? { acquired: true, operation: reclaimed, retry: true }
    : { acquired: false, inProgress: true, operation: existing };
}

async function succeedPaymentOperation(operation, stripeObjectId, { session } = {}) {
  if (!operation?._id) return null;
  const saved = await PaymentOperation.findOneAndUpdate(
    { _id: operation._id, ...(operation.attempts ? { attempts: operation.attempts } : {}), $nor: [unresolvedTransfer, quarantinedTransfer], $and: [verifiedRefundForTransfer] },
    {
      $set: {
        status: "succeeded",
        stripeObjectId: String(stripeObjectId || ""),
        lastError: "",
        completedAt: new Date(),
      },
    },
    { returnDocument: "after", ...(session ? { session } : { writeConcern: { w: "majority" } }) }
  );
  if (!saved) throw new Error("The payment operation changed or requires payment review before it can be completed.");
  return saved;
}

async function failPaymentOperation(
  operation,
  err,
  { needsReconciliation = false, stripeObjectId = "", session } = {}
) {
  if (!operation?._id) return null;
  const update = {
    status: needsReconciliation ? "needs_reconciliation" : "failed",
    lastError: String(err?.message || err || "Unknown payment operation error").slice(0, 2000),
  };
  if (stripeObjectId) update.stripeObjectId = String(stripeObjectId);
  const attempt = { _id: operation._id, ...(operation.attempts ? { attempts: operation.attempts } : {}), status: { $ne: "succeeded" } };
  const options = { returnDocument: "after", ...(session ? { session } : { writeConcern: { w: "majority" } }) };
  const quarantined = await PaymentOperation.findOneAndUpdate(
    { ...attempt, ...quarantinedTransfer }, { $set: { status: "needs_reconciliation" } }, options
  );
  if (quarantined) return quarantined;
  // A caller's generic failure must never make an unknown transfer retryable.
  const held = await PaymentOperation.findOneAndUpdate(
    { ...attempt, ...unresolvedTransfer },
    { $set: { ...update, status: "needs_reconciliation" } },
    options
  );
  if (held) return held;
  return PaymentOperation.findOneAndUpdate(
    { ...attempt, $nor: [unresolvedTransfer, quarantinedTransfer] },
    {
      $set: update,
    },
    options
  );
}

async function recordPaymentOperationEvidence(
  operation,
  { refundId, refundAmount, transferId, transferAmount } = {},
  { session } = {}
) {
  if (!operation?._id) return null;
  const update = {};
  if (refundId) update.stripeRefundId = String(refundId);
  if (Number.isFinite(Number(refundAmount))) update.refundAmount = Math.max(0, Math.round(Number(refundAmount)));
  if (transferId) {
    update.stripeTransferId = String(transferId);
    update.stripeObjectId = String(transferId);
  }
  if (Number.isFinite(Number(transferAmount))) update.transferAmount = Math.max(0, Math.round(Number(transferAmount)));
  if (!Object.keys(update).length) return operation;
  return PaymentOperation.findByIdAndUpdate(
    operation._id,
    { $set: update },
    { returnDocument: "after", ...(session ? { session } : {}) }
  );
}

module.exports = {
  verifiedRefundForTransfer,
  STALE_PENDING_MS,
  TRANSFER_OPERATION_KINDS,
  claimPaymentOperation,
  failPaymentOperation,
  operationFingerprint,
  recordPaymentOperationEvidence,
  succeedPaymentOperation,
};
