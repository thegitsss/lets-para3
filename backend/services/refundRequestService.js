"use strict";

const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose");
const Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Audit = require("../models/AuditLog");
const { fingerprint } = require("./matterDraftRevision"), { validatePaymentIntentForCase, expectedCaseFunding } = require("../utils/paymentIntegrity"), { currentStripeMode } = require("../utils/stripeMode");
const id = value => String(value?._id || value?.id || value || ""), cents = value => Number.isSafeInteger(value) && value >= 0;
const external = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(value);
const fail = (code = "REFUND_REQUIRES_REVIEW", message = "The refund needs payment review before this dispute can be settled.") => { throw Object.assign(new Error(message), { status: 409, publicCode: code }); };
const key = (operation, kind) => new mongoose.Types.ObjectId(fingerprint(["dispute_refund_request", id(operation._id), operation.operationKey, kind]).slice(0, 24));
const sourceFields = ["status", "archived", "readOnly", "purgedAt", "totalAmount", "lockedTotalAmount", "remainingAmount", "feeAttorneyPct", "feeAttorneyAmount", "feeParalegalPct", "feeParalegalAmount", "currency", "stripeMode", "paymentIntentId", "escrowIntentId", "paymentStatus", "escrowStatus", "paymentReleased", "payoutStatus", "payoutTransferId", "payoutFinalizedAt", "payoutFinalizedType", "partialPayoutAmount", "hiringClaimToken", "hiringClaimStatus", "completionClaimToken", "completionClaimStatus", "withdrawalClaimToken", "withdrawalClaimStatus", "terminationStatus", "terminationDisputeId"];
function sourceOf(value) {
  return { _id: id(value._id), ...Object.fromEntries(sourceFields.map(name => [name, name.endsWith("Token") ? value[name] || "" : value[name] ?? null])), attorney: id(value.attorney), attorneyId: id(value.attorneyId), paralegal: id(value.paralegal), paralegalId: id(value.paralegalId), withdrawnParalegalId: id(value.withdrawnParalegalId), disputes: (value.disputes || []).map(dispute => ({ id: id(dispute._id), disputeId: dispute.disputeId || null, status: dispute.status || null })) };
}
async function guardCase(source, session) {
  const current = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(source._id) }, { session });
  if (!current || fingerprint(sourceOf(current)) !== fingerprint(source)) fail("REFUND_MATTER_CHANGED", "The Matter changed while its refund was being checked. Review the current dispute before continuing.");
  const saved = await Case.collection.updateOne({ _id: current._id }, { $inc: { __v: 1 } }, { session });
  if (saved.matchedCount !== 1) fail("REFUND_MATTER_CHANGED");
  return current;
}
async function retained(operation, kind, session) {
  const record = await Audit.collection.findOne({ _id: key(operation, kind) }, { session, ...(session ? {} : { readConcern: { level: "majority" } }) });
  if (record && (record.action !== `dispute.refund.${kind}` || id(record.case) !== id(operation.caseId) || record.meta?.operationId !== id(operation._id) || record.meta?.operationKey !== operation.operationKey)) fail();
  return record;
}
async function hasUnresolvedRefundRequest(operation) {
  if (!["refund", "dispute_settlement"].includes(operation.kind) || external(operation.stripeRefundId, "re")) return false;
  const started = await retained(operation, "requested");
  if (!started) return false;
  const received = await retained(operation, "received");
  return !external(received?.meta?.refundId, "re");
}
async function hasRefundRequest(operation) { return Boolean(await retained(operation, "requested")); }
const entry = (operation, kind, meta, req) => ({ _id: key(operation, kind), actor: req?.user?.id || req?.user?._id || null, actorRole: req?.user?.role || "system", action: `dispute.refund.${kind}`, targetType: "payment", targetId: operation.operationKey, case: operation.caseId, meta: { operationId: id(operation._id), operationKey: operation.operationKey, ...meta } });

async function paymentSource(caseDoc, stripe) {
  const intentId = caseDoc.escrowIntentId || caseDoc.paymentIntentId;
  if (!external(intentId, "pi") || [caseDoc.escrowIntentId, caseDoc.paymentIntentId].filter(Boolean).some(value => value !== intentId)) fail();
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] });
  let charge = intent?.latest_charge;
  if (typeof charge === "string") charge = await stripe.charges.retrieve(charge);
  const expected = expectedCaseFunding(caseDoc), mode = currentStripeMode();
  if (intent?.id !== intentId || intent.object !== "payment_intent" || intent.status !== "succeeded" || !validatePaymentIntentForCase(intent, caseDoc).valid || intent.amount !== expected.totalAmount || intent.amount_received !== expected.totalAmount || typeof intent.livemode !== "boolean" || mode !== "unknown" && mode !== (intent.livemode ? "live" : "test") || intent.metadata?.attorneyId && intent.metadata.attorneyId !== id(caseDoc.attorney || caseDoc.attorneyId)) fail();
  if (!external(charge?.id, "ch") || id(charge.payment_intent) !== intentId || charge.paid !== true || charge.captured !== true || charge.status !== "succeeded" || charge.amount !== expected.totalAmount || charge.amount_captured !== expected.totalAmount || !cents(charge.amount_refunded) || charge.amount_refunded > charge.amount || charge.currency !== intent.currency || charge.livemode !== intent.livemode || charge.disputed) fail();
  return { intent, charge };
}
function checkRefund(refund, { intent, charge }, amount, caseDoc, disputeId) {
  if (!external(refund?.id, "re") || refund.object !== "refund" || !cents(refund.amount) || !refund.amount || refund.amount !== amount || refund.currency !== intent.currency || id(refund.payment_intent) !== intent.id || id(refund.charge) !== charge.id || !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(refund.status) || refund.metadata?.caseId && refund.metadata.caseId !== id(caseDoc._id) || refund.metadata?.disputeId && refund.metadata.disputeId !== disputeId) fail();
}
async function verifyRecorded({ caseDoc, refundId, amount, disputeId, stripe }) {
  if (!external(refundId, "re")) fail();
  const payment = await paymentSource(caseDoc, stripe), refund = await stripe.refunds.retrieve(refundId);
  checkRefund(refund, payment, amount, caseDoc, disputeId);
  if (refund.status !== "succeeded") fail("REFUND_NOT_CONFIRMED", "Stripe has not confirmed this refund as completed. Its current outcome needs payment review.");
  return refund;
}

async function requestRefund({ operation, caseDoc, disputeId, action, targetRefundTotal, stripe, req }) {
  if (!operation?._id || operation.kind !== "dispute_settlement" || id(operation.caseId) !== id(caseDoc._id) || operation.status !== "pending" || !Number.isSafeInteger(operation.attempts) || operation.attempts < 1) fail();
  const source = sourceOf(caseDoc), raw = await Case.collection.findOne({ _id: caseDoc._id });
  if (!raw || fingerprint(sourceOf(raw)) !== fingerprint(source)) fail("REFUND_MATTER_CHANGED");
  const [started, received] = await Promise.all([retained(operation, "requested"), retained(operation, "received")]);
  const reference = operation.stripeRefundId || received?.meta?.refundId || "";
  if (operation.stripeRefundId && received?.meta?.refundId && operation.stripeRefundId !== received.meta.refundId || reference && !external(reference, "re")) fail();
  if (started && !reference) fail("REFUND_RESULT_UNKNOWN", "The earlier refund request has an unconfirmed outcome. Payment review is required before another refund can be requested.");
  if (!started && !reference && operation.attempts > 1) fail("REFUND_RESULT_UNKNOWN", "This earlier payment operation has no verified refund reference. Payment review is required before another refund request.");
  const payment = await paymentSource(caseDoc, stripe);
  const target = targetRefundTotal ?? payment.charge.amount;
  if (!cents(target) || target <= 0 || target > payment.charge.amount || payment.charge.amount_refunded > target) fail();
  if (started && (started.meta?.targetRefundTotal !== target || started.meta?.paymentIntentId !== payment.intent.id || started.meta?.chargeId !== payment.charge.id || started.meta?.disputeId !== disputeId || started.meta?.action !== action)) fail();
  const amount = reference ? started?.meta?.amount ?? operation.refundAmount : target - payment.charge.amount_refunded;
  if (!cents(amount) || amount <= 0 || amount > target) fail();
  let refund;
  if (reference) {
    refund = await stripe.refunds.retrieve(reference);
  } else {
    const session = await mongoose.startSession();
    const idempotencyKey = action === "release_partial" ? stripe.stripeIdempotencyKey("dispute_partial_refund", caseDoc._id, disputeId, target) : stripe.stripeIdempotencyKey("dispute_refund", caseDoc._id, disputeId, caseDoc.lockedTotalAmount ?? caseDoc.totalAmount);
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      await guardCase(source, session);
      const saved = await Operation.collection.updateOne({ _id: operation._id, operationKey: operation.operationKey, status: "pending", attempts: operation.attempts, stripeRefundId: { $in: ["", null] }, evidenceStatus: { $ne: "quarantined" } }, { $set: { refundAmount: amount, stripePaymentIntentId: payment.intent.id, stripeChargeId: payment.charge.id, stripeMode: payment.intent.livemode ? "live" : "test", updatedAt: new Date() } }, { session });
      if (saved.matchedCount !== 1) fail();
      await Audit.create([entry(operation, "requested", { paymentIntentId: payment.intent.id, chargeId: payment.charge.id, amount, targetRefundTotal: target, currency: payment.intent.currency, disputeId, action, idempotencyKey }, req)], { session });
      await session.commitTransaction();
    } catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.refundRequestService.transaction_abort")); throw error; }
    finally { await session.endSession(); }
    try {
      refund = await stripe.refunds.create({ payment_intent: payment.intent.id, amount, metadata: { caseId: id(caseDoc._id), disputeId, action, operationKey: operation.operationKey } }, { idempotencyKey });
    } catch {
      await Operation.collection.updateOne({ _id: operation._id, attempts: operation.attempts, status: { $ne: "succeeded" } }, { $set: { status: "needs_reconciliation", lastError: "The refund request has an unconfirmed provider outcome." } }, { writeConcern: { w: "majority" } }).catch(reportOperationalFailure("services.refundRequestService.refund_reconciliation_marker"));
      fail("REFUND_RESULT_UNKNOWN", "The refund request has an unconfirmed outcome. Payment review is required before another request.");
    }
  }
  if (!external(refund?.id, "re") || reference && refund.id !== reference) fail();
  // Retain the provider reference before inspecting its outcome or doing any
  // settlement work. Either independent record can recover an interrupted write.
  const writes = await Promise.allSettled([
    received ? Promise.resolve(received) : Audit.create([entry(operation, "received", { refundId: refund.id, amount: refund.amount, paymentIntentId: payment.intent.id, chargeId: payment.charge.id, disputeId, action }, req)], { writeConcern: { w: "majority" } }),
    Operation.findOneAndUpdate({ _id: operation._id, attempts: operation.attempts, status: { $ne: "succeeded" }, evidenceStatus: { $ne: "quarantined" }, stripeRefundId: { $in: ["", null, refund.id] } }, { $set: { stripeRefundId: refund.id, refundAmount: refund.amount } }, { returnDocument: "after", writeConcern: { w: "majority" } }),
  ]);
  if (writes.every(value => value.status === "rejected")) fail("REFUND_REFERENCE_UNCONFIRMED");
  const current = await Operation.collection.findOne({ _id: operation._id });
  if (!current || current.stripeRefundId !== refund.id || current.attempts !== operation.attempts || current.evidenceStatus === "quarantined") fail("REFUND_REFERENCE_UNCONFIRMED");
  checkRefund(refund, payment, amount, caseDoc, disputeId);
  const observed = await Operation.collection.updateOne({ _id: operation._id, attempts: operation.attempts, stripeRefundId: refund.id, evidenceStatus: { $ne: "quarantined" }, refundVerifiedAt: operation.refundVerifiedAt || null, refundStatus: operation.refundStatus || null }, { $set: { refundStatus: refund.status, refundEvidenceStatus: "verified", refundVerifiedAt: new Date(), refundCreatedAt: Number.isSafeInteger(refund.created) && refund.created > 0 && Number.isFinite(new Date(refund.created * 1000).getTime()) ? new Date(refund.created * 1000) : null, updatedAt: new Date() } }, { writeConcern: { w: "majority" } });
  if (observed.matchedCount !== 1) fail("REFUND_EVIDENCE_CHANGED", "The refund changed while its outcome was being checked. Review its current status before continuing.");
  if (refund.status !== "succeeded") {
    await Operation.collection.updateOne({ _id: operation._id, attempts: operation.attempts, status: { $ne: "succeeded" } }, { $set: { status: "needs_reconciliation", lastError: `Stripe refund status: ${refund.status}.` } }, { writeConcern: { w: "majority" } });
    fail("REFUND_NOT_CONFIRMED", "Stripe has not confirmed the refund as completed. Check the current refund before settling this dispute.");
  }
  const after = await Case.collection.findOne({ _id: caseDoc._id });
  if (!after || fingerprint(sourceOf(after)) !== fingerprint(source)) fail("REFUND_MATTER_CHANGED");
  return { refund, source, targetRefundTotal: target };
}

module.exports = { requestRefund, verifyRecorded, hasUnresolvedRefundRequest, hasRefundRequest, guardCase, sourceOf };
