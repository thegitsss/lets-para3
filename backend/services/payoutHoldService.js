"use strict";

const { reportOperationalFailure } = require("../utils/operationalFailure");
const PaymentOperation = require("../models/PaymentOperation");
const Case = require("../models/Case");
const { TRANSFER_OPERATION_KINDS, verifiedRefundForTransfer } = require("./paymentOperationService");

const ACTIVE_ADMIN_REVIEW_STATES = Object.freeze(["pending_review", "acknowledged", null]);

function chargebackHoldsPayout(operation, caseDoc) {
  if (!operation || !ACTIVE_ADMIN_REVIEW_STATES.includes(operation.administrativeStatus ?? null)) return false;
  if (operation.payoutPosition !== "post_payout") return true;
  if (!caseDoc) return true;
  if (caseDoc.paymentReleased === true) return false;
  if (Number.isSafeInteger(caseDoc.remainingAmount)) return caseDoc.remainingAmount > 0;
  // An earlier partial payout does not establish that the remaining work has
  // been paid. A missing remaining balance must be reviewed, not treated as zero.
  return [caseDoc, ...(caseDoc.withdrawalHistory || [])].some(entry => entry.payoutFinalizedAt && entry.partialPayoutAmount > 0);
}

class PayoutHeldForChargebackError extends Error {
  constructor() {
    super("This payout is frozen for administrative payment review.");
    this.name = "PayoutHeldForChargebackError";
    this.code = "PAYOUT_HELD_FOR_CHARGEBACK";
    this.statusCode = 409;
  }
}

async function getPayoutHold(caseId, { PaymentOperationModel = PaymentOperation, CaseModel = Case } = {}) {
  if (!caseId) return { held: false, operation: null };
  const operations = await PaymentOperationModel.find({
    caseId,
    kind: "chargeback",
    administrativeStatus: { $in: ACTIVE_ADMIN_REVIEW_STATES },
  }).sort({ processorEventCreatedAt: -1, createdAt: -1 }).limit(4001);
  if (operations.length > 4000) throw new Error("The card-dispute payout review exceeds its verification limit.");
  const caseDoc = operations.some(value => value.payoutPosition === "post_payout") ? await CaseModel.findById(caseId).select("paymentReleased remainingAmount payoutFinalizedAt partialPayoutAmount withdrawalHistory").lean() : null;
  const operation = operations.find(value => chargebackHoldsPayout(value, caseDoc)) || null;
  return { held: Boolean(operation), operation };
}

async function assertPayoutNotHeld(caseId, options = {}) {
  const hold = await getPayoutHold(caseId, options);
  if (hold.held) throw new PayoutHeldForChargebackError();
  return hold;
}

async function createPayoutTransfer({
  caseId,
  stripeClient,
  payload,
  stripeOptions,
  bypassTransfer = null,
  operation,
  onTransfer,
  stripeMode = operation?.stripeMode || "unknown",
  PaymentOperationModel = PaymentOperation,
}) {
  await assertPayoutNotHeld(caseId, { PaymentOperationModel });
  if (!operation?._id || String(operation.caseId) !== String(caseId) || !TRANSFER_OPERATION_KINDS.includes(operation.kind) || !Number.isSafeInteger(operation.attempts) || operation.attempts < 1 || !Number.isSafeInteger(payload?.amount) || payload.amount <= 0 || !stripeOptions?.idempotencyKey) {
    throw new Error("A claimed payment operation is required before requesting a payout transfer.");
  }
  const attempt = { _id: operation._id, operationKey: operation.operationKey, caseId, kind: operation.kind, attempts: operation.attempts };
  const options = { returnDocument: "after", writeConcern: { w: "majority" } };
  // This marker survives a lost provider response, a process stop, and expiry of
  // the provider's idempotency key. It is not a claim that money was paid.
  const started = await PaymentOperationModel.findOneAndUpdate(
    { ...attempt, status: "pending", lastAttemptAt: operation.lastAttemptAt, stripeTransferId: { $in: ["", null] }, evidenceStatus: { $nin: ["needs_reconciliation", "quarantined"] }, $and: [verifiedRefundForTransfer] },
    { $set: { evidenceStatus: "needs_reconciliation", transferAmount: payload.amount, stripeMode: ["live", "test"].includes(stripeMode) ? stripeMode : "unknown", ...(typeof payload.source_transaction === "string" ? { stripeChargeId: payload.source_transaction } : {}), lastError: "Payout transfer request started; its result must be reconciled before another request." } },
    options
  );
  if (!started) throw new Error("This payout transfer requires review before another request.");
  let transfer;
  const knownTransfer = () => /^(?:tr_|bypass_)[A-Za-z0-9_]{1,200}$/.test(transfer?.id || "") ? { stripeTransferId: transfer.id, stripeObjectId: transfer.id, transferAmount: payload.amount, evidenceStatus: null } : {};
  try {
    await assertPayoutNotHeld(caseId, { PaymentOperationModel });
    transfer = bypassTransfer || await stripeClient.transfers.create(payload, stripeOptions);
    if (!Object.keys(knownTransfer()).length) throw new Error("The payout transfer result could not be identified. Payment review is required.");
    // Retain the provider result independently in the operation and the owning
    // Matter claim before chargeback projections or payout-ledger work runs.
    const retention = await Promise.allSettled([
      PaymentOperationModel.findOneAndUpdate(
        { ...attempt, stripeTransferId: { $in: ["", null, transfer.id] }, evidenceStatus: { $ne: "quarantined" } },
        { $set: knownTransfer() }, options
      ).then(record => { if (!record) throw new Error("The payout operation changed before its transfer could be recorded."); }),
      Promise.resolve().then(() => onTransfer?.(transfer)),
    ]);
    const failure = retention.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const retained = await PaymentOperationModel.findOne({ ...attempt, stripeTransferId: transfer.id });
    if (!retained || retained.evidenceStatus === "quarantined") throw new Error("The retained transfer changed or requires payment review.");
    await PaymentOperationModel.updateMany(
      {
        caseId,
        kind: "chargeback",
        payoutPosition: "pre_payout",
        administrativeStatus: { $in: ACTIVE_ADMIN_REVIEW_STATES },
      },
      {
        $set: {
          payoutPosition: "post_payout",
          status: "needs_reconciliation",
          lastError: "A payout transfer completed concurrently with chargeback processing; admin reconciliation is required.",
        },
      }
    );
    await PaymentOperationModel.updateMany(
      {
        caseId,
        kind: "chargeback",
        payoutPosition: "pre_payout",
      },
      { $set: { payoutPosition: "post_payout" } }
    );
    return transfer;
  } catch (error) {
    const err = error instanceof Error ? error : new Error("The payout transfer requires payment review.");
    err.payoutTransferAttempted = true;
    // If this write also fails, the pre-request marker remains the retry fence.
    await PaymentOperationModel.findOneAndUpdate(
      { ...attempt, status: { $ne: "succeeded" }, evidenceStatus: { $ne: "quarantined" }, stripeTransferId: { $in: ["", null, transfer?.id || ""] } },
      { $set: { ...knownTransfer(), status: "needs_reconciliation", lastError: String(err.message).slice(0, 2000) } }, options
    ).catch(reportOperationalFailure("services.payoutHoldService.payout_reconciliation_marker"));
    throw err;
  }
}

module.exports = {
  ACTIVE_ADMIN_REVIEW_STATES,
  PayoutHeldForChargebackError,
  assertPayoutNotHeld,
  createPayoutTransfer,
  getPayoutHold,
  chargebackHoldsPayout,
};
