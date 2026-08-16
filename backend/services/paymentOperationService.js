const crypto = require("crypto");
const PaymentOperation = require("../models/PaymentOperation");

const STALE_PENDING_MS = 10 * 60 * 1000;

function operationFingerprint(value) {
  const material = typeof value === "string" ? value : JSON.stringify(value || {});
  return crypto.createHash("sha256").update(material).digest("hex");
}

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
  if (existing.status === "succeeded") {
    return { acquired: false, completed: true, operation: existing };
  }
  const stale = !existing.lastAttemptAt || now.getTime() - existing.lastAttemptAt.getTime() >= STALE_PENDING_MS;
  if (existing.status === "pending" && !stale) {
    return { acquired: false, inProgress: true, operation: existing };
  }

  const reclaimed = await PaymentOperation.findOneAndUpdate(
    {
      _id: existing._id,
      fingerprint: normalizedFingerprint,
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
  return PaymentOperation.findByIdAndUpdate(
    operation._id,
    {
      $set: {
        status: "succeeded",
        stripeObjectId: String(stripeObjectId || ""),
        lastError: "",
        completedAt: new Date(),
      },
    },
    { returnDocument: "after", ...(session ? { session } : {}) }
  );
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
  return PaymentOperation.findByIdAndUpdate(
    operation._id,
    {
      $set: update,
    },
    { returnDocument: "after", ...(session ? { session } : {}) }
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
  STALE_PENDING_MS,
  claimPaymentOperation,
  failPaymentOperation,
  operationFingerprint,
  recordPaymentOperationEvidence,
  succeedPaymentOperation,
};
