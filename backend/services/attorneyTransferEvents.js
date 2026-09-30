"use strict";

const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose");
const Case = require("../models/Case"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { fingerprint } = require("./matterDraftRevision");
const { TRANSFER_OPERATION_KINDS } = require("./paymentOperationService");
const id = value => String(value?._id || value?.id || value || "");
const text = value => typeof value === "string" ? value.slice(0, 300) : "";
const cents = value => Number.isSafeInteger(value) && value >= 0;
const knownMode = value => value === "test" || value === "live";
const negativeStatuses = ["failed", "reversed", "needs_reconciliation"];

function transferProblem(event, transfer) {
  if (transfer?.object !== "transfer" || !/^tr_[A-Za-z0-9_]{1,200}$/.test(transfer?.id || "")) return "invalid_transfer";
  if (!cents(transfer.amount) || transfer.amount === 0 || !/^[a-z]{3}$/.test(transfer.currency || "")) return "invalid_amount";
  if (typeof event.livemode !== "boolean" || transfer.livemode !== event.livemode) return "invalid_mode";
  if (!/^acct_[A-Za-z0-9_]+$/.test(id(transfer.destination))) return "invalid_destination";
  if (!cents(transfer.amount_reversed) || transfer.amount_reversed > transfer.amount || typeof transfer.reversed !== "boolean" || transfer.reversed !== (transfer.amount_reversed === transfer.amount)) return "invalid_reversal";
  if (event.type === "transfer.reversed" && transfer.amount_reversed === 0) return "missing_reversal";
  if (event.type === "transfer.failed") return "unsupported_transfer_failure";
  return "";
}

function associationProblem(transfer, matter, payout, operation) {
  if (!matter) return "missing_matter";
  if (transfer.transfer_group !== `case_${matter._id}` || transfer.metadata?.caseId && transfer.metadata.caseId !== id(matter._id)) return "matter_mismatch";
  if (payout && id(payout.caseId) !== id(matter._id) || operation && id(operation.caseId) !== id(matter._id)) return "record_mismatch";
  if (operation && !TRANSFER_OPERATION_KINDS.includes(operation.kind)) return "operation_kind_mismatch";
  if (payout?.operationKey && operation && payout.operationKey !== operation.operationKey) return "operation_mismatch";
  if (transfer.metadata?.operationKey && transfer.metadata.operationKey !== (operation?.operationKey || payout?.operationKey)) return "metadata_mismatch";
  const amount = payout?.amountPaid ?? (operation?.transferAmount > 0 ? operation.transferAmount : operation?.amount);
  if (!cents(amount) || amount !== transfer.amount || matter.currency !== transfer.currency || operation?.currency && operation.currency !== transfer.currency) return "amount_mismatch";
  if (payout && operation && (operation.transferAmount > 0 ? operation.transferAmount : operation.amount) !== payout.amountPaid) return "ledger_amount_mismatch";
  const modes = [matter.stripeMode, payout?.stripeMode, operation?.stripeMode].filter(knownMode), mode = transfer.livemode ? "live" : "test";
  if (!modes.length || modes.some(value => value !== mode)) return "mode_mismatch";
  if (operation?.stripeChargeId && id(transfer.source_transaction) !== operation.stripeChargeId) return "charge_mismatch";
  if (payout && transfer.metadata?.paralegalId && transfer.metadata.paralegalId !== id(payout.paralegalId)) return "payee_mismatch";
  if (transfer.metadata?.attorneyId && transfer.metadata.attorneyId !== id(matter.attorney || matter.attorneyId)) return "owner_mismatch";
  return "";
}

function isCurrentTransfer(matter, operation, transferId) {
  if (matter.payoutTransferId === transferId) return true;
  if (matter.payoutTransferId && matter.payoutTransferId !== transferId) return false;
  if (matter.completionClaimTransferId === transferId || matter.withdrawalClaimTransferId === transferId) return true;
  if (operation?.kind === "case_payout" && operation.operationKey === `case_payout:${matter._id}` && matter.completionClaimToken && ["claimed", "needs_reconciliation"].includes(matter.completionClaimStatus)) return true;
  if (operation?.kind === "partial_payout" && matter.withdrawalClaimToken && ["claimed", "needs_reconciliation"].includes(matter.withdrawalClaimStatus)) {
    return operation.operationKey === require("./attorneyWithdrawal").eventKey(matter);
  }
  return false;
}

async function record({ event, receiptFilter, ip, ua }) {
  const transfer = event.data?.object || {}, transferId = text(transfer.id);
  const eventHash = fingerprint([event.id, event.type, event.created, event.livemode, transfer]);
  const auditId = new mongoose.Types.ObjectId(fingerprint(["stripe_transfer_event", event.id]).slice(0, 24));
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    const receipt = await Delivery.collection.findOne(receiptFilter, { session });
    if (!receipt) throw new Error("The transfer delivery attempt is no longer current.");
    const existing = await Audit.collection.findOne({ _id: auditId }, { session });
    let result = { caseId: null, needsReview: false, outcome: "observed" };
    if (existing) {
      if (existing.meta?.eventHash !== eventHash) throw new Error("The retained transfer event does not match this delivery.");
      result = { caseId: existing.case || null, needsReview: false, outcome: "already_recorded" };
    } else {
      let problem = transferProblem(event, transfer), payout = null, operation = null, matter = null;
      if (!problem) {
        const payouts = await Payout.collection.find({ transferId }, { session }).limit(2).toArray();
        const operations = await Operation.collection.find({ $or: [{ stripeTransferId: transferId }, { stripeObjectId: transferId }] }, { session }).limit(3).toArray();
        if (payouts.length > 1 || operations.length > 1) problem = "ambiguous_transfer";
        else {
          payout = payouts[0]; operation = operations[0];
          const matterId = payout?.caseId || operation?.caseId;
          if (!matterId) problem = "unassociated_transfer";
          else { matter = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(id(matterId)) }, { session }); problem = associationProblem(transfer, matter, payout, operation); }
        }
      }
      result.caseId = matter?._id || null;
      result.needsReview = Boolean(problem);
      result.outcome = problem ? "needs_review" : transfer.amount_reversed === transfer.amount ? "reversed" : transfer.amount_reversed > 0 ? "partially_reversed" : "observed";
      if (!problem && transfer.amount_reversed > 0) {
        const full = result.outcome === "reversed" || payout?.status === "reversed";
        const reason = full ? "Stripe recorded a full reversal of this transfer." : "Stripe recorded a partial reversal of this transfer. The remaining payment requires review.";
        const at = Number.isSafeInteger(event.created) && event.created > 0 && Number.isFinite(new Date(event.created * 1000).getTime()) ? new Date(event.created * 1000) : null;
        if (payout && payout.status !== "reversed") {
          await Payout.collection.updateOne({ _id: payout._id, transferId }, { $set: { status: full ? "reversed" : "needs_reconciliation", failureReason: reason, ...(full ? { reversedAt: at } : {}) } }, { session });
        }
        if (operation) {
          await Operation.collection.updateOne({ _id: operation._id }, { $set: { status: "needs_reconciliation", evidenceStatus: "quarantined", stripeTransferId: transferId, stripeObjectId: transferId, stripeEventId: event.id, lastError: reason } }, { session });
        }
        if (isCurrentTransfer(matter, operation, transferId)) {
          const retain = matter.payoutStatus === "reversed" || !full && negativeStatuses.includes(matter.payoutStatus);
          await Case.collection.updateOne({ _id: matter._id }, { $set: { paymentReleased: false, ...(retain ? {} : { payoutStatus: full ? "reversed" : "needs_reconciliation", payoutFailureReason: reason }) }, $inc: { __v: 1 } }, { session });
        }
        result.needsReview = true;
      }
      await Audit.create([{
        _id: auditId, actor: null, actorRole: "system", action: event.type, targetType: "payment", case: result.caseId, ip, ua,
        method: "POST", path: "/api/webhooks/stripe",
        meta: { eventId: event.id, eventHash, externalRef: transferId, transferId, amount: cents(transfer.amount) ? transfer.amount : null, currency: text(transfer.currency), amountReversed: cents(transfer.amount_reversed) ? transfer.amount_reversed : null, destination: text(id(transfer.destination)), transfer_group: text(transfer.transfer_group), payoutId: payout ? id(payout._id) : null, operationId: operation ? id(operation._id) : null, outcome: result.outcome, associationProblem: problem || null },
      }], { session });
    }
    const finalized = await Delivery.updateOne(receiptFilter, { $set: { status: "processed", lastError: "" } }, { session });
    if (!finalized.matchedCount) throw new Error("The transfer delivery attempt changed before its records could be committed.");
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyTransferEvents.transaction_abort"));
    throw error;
  } finally { await session.endSession(); }
}

module.exports = { record };
