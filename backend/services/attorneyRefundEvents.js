"use strict";

const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose");
const Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { fingerprint } = require("./matterDraftRevision"), { expectedCaseFunding, validatePaymentIntentForCase } = require("../utils/paymentIntegrity"), { currentStripeMode } = require("../utils/stripeMode");
const id = value => String(value?._id || value?.id || value || ""), cents = value => Number.isSafeInteger(value) && value >= 0;
const external = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(value);
const date = seconds => Number.isSafeInteger(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? new Date(seconds * 1000) : null;
const statuses = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]), negative = new Set(["failed", "canceled"]);
const types = new Set(["charge.refunded", "charge.refund.updated", "refund.created", "refund.updated", "refund.failed"]);

async function inventory(intentId, session) {
  const options = { session };
  const cases = await Case.collection.find({ $or: [{ paymentIntentId: intentId }, { escrowIntentId: intentId }] }, options).sort({ _id: 1 }).limit(3).toArray();
  const references = await Operation.collection.find({ stripePaymentIntentId: intentId }, options).sort({ _id: 1 }).limit(4001).toArray();
  if (references.length > 4000) throw new Error("The refund reference inventory exceeds its verification limit.");
  const caseIds = [...new Set([...cases.map(row => id(row._id)), ...references.map(row => id(row.caseId))])];
  if (cases.length > 1 || caseIds.length !== 1 || !/^[a-f0-9]{24}$/i.test(caseIds[0])) return { problem: caseIds.length ? "ambiguous_payment" : "unassociated_payment", cases, references };
  const raw = cases[0] || await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseIds[0]) }, options);
  if (!raw) return { problem: "missing_matter", cases, references };
  const refs = [raw._id, id(raw._id)];
  const operations = await Operation.collection.find({ caseId: { $in: refs } }, options).sort({ _id: 1 }).limit(4001).toArray();
  const payouts = await Payout.collection.find({ caseId: { $in: refs } }, options).sort({ _id: 1 }).limit(4001).toArray();
  const requests = await Audit.collection.find({ case: raw._id, action: "dispute.refund.requested" }, options).sort({ _id: 1 }).limit(4001).toArray();
  if ([operations, payouts, requests].some(rows => rows.length > 4000)) throw new Error("The Matter refund inventory exceeds its verification limit.");
  const problem = [raw.paymentIntentId, raw.escrowIntentId].filter(Boolean).some(value => value !== intentId) ? "conflicting_payment_references" : raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId) ? "owner_mismatch" : "";
  return { problem, raw, cases, references, operations, payouts, requests };
}
async function refundReferences(refunds, session) {
  const ids = refunds.map(refund => refund.id);
  const rows = await Operation.collection.find({ $or: [{ stripeRefundId: { $in: ids } }, { stripeObjectId: { $in: ids } }] }, { session }).sort({ _id: 1 }).limit(4001).toArray();
  if (rows.length > 4000) throw new Error("The retained refund inventory exceeds its verification limit.");
  return rows;
}
async function allRefunds(stripe, chargeId) {
  const refunds = [], seen = new Set(); let after;
  do {
    const page = await stripe.refunds.list({ charge: chargeId, limit: 100, ...(after ? { starting_after: after } : {}) });
    if (!Array.isArray(page?.data) || typeof page.has_more !== "boolean" || page.data.length > 100 || page.has_more && !page.data.length) throw new Error("Stripe returned an incomplete refund list.");
    for (const refund of page.data) {
      if (!external(refund?.id, "re") || seen.has(refund.id)) throw new Error("Stripe returned duplicate or invalid refund references.");
      seen.add(refund.id); refunds.push(refund);
    }
    if (refunds.length > 4000) throw new Error("The charge refund list exceeds its verification limit.");
    if (!page.has_more) return refunds;
    after = refunds.at(-1).id;
  } while (after);
  throw new Error("The refund list could not be completed.");
}
function refundShape(refund) { return [refund.id, refund.status, refund.amount, refund.currency, id(refund.charge), id(refund.payment_intent)]; }
function evidenceProblem({ event, target, charge, intent, refunds, raw }) {
  const expected = expectedCaseFunding(raw), mode = currentStripeMode();
  if (intent?.object !== "payment_intent" || !external(intent.id, "pi") || intent.status !== "succeeded" || !validatePaymentIntentForCase(intent, raw).valid || intent.amount !== expected.totalAmount || intent.amount_received !== expected.totalAmount || intent.livemode !== event.livemode || mode !== "unknown" && mode !== (event.livemode ? "live" : "test") || intent.metadata?.attorneyId && intent.metadata.attorneyId !== id(raw.attorney || raw.attorneyId)) return "payment_mismatch";
  if (charge?.object !== "charge" || !external(charge.id, "ch") || id(charge.payment_intent) !== intent.id || id(intent.latest_charge) !== charge.id || charge.paid !== true || charge.captured !== true || charge.status !== "succeeded" || charge.amount !== expected.totalAmount || charge.amount_captured !== expected.totalAmount || charge.currency !== intent.currency || charge.livemode !== event.livemode || !cents(charge.amount_refunded) || charge.amount_refunded > charge.amount) return "capture_mismatch";
  if (!refunds.length) return "missing_refunds";
  for (const refund of refunds) {
    if (refund.object !== "refund" || !statuses.has(refund.status) || !cents(refund.amount) || !refund.amount || refund.amount > charge.amount || refund.currency !== charge.currency || id(refund.charge) !== charge.id || id(refund.payment_intent) !== intent.id || refund.metadata?.caseId && refund.metadata.caseId !== id(raw._id)) return "refund_mismatch";
  }
  if (target && (target.object !== "refund" || id(target.payment_intent) !== intent.id || id(target.charge) !== charge.id || target.currency !== charge.currency)) return "refund_mismatch";
  if (target && (!refunds.some(refund => refund.id === target.id) || fingerprint(refundShape(refunds.find(refund => refund.id === target.id))) !== fingerprint(refundShape(target)))) return "refund_snapshot_changed";
  const succeeded = refunds.filter(refund => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0);
  const active = refunds.filter(refund => !negative.has(refund.status)).reduce((sum, refund) => sum + refund.amount, 0);
  if (!cents(succeeded) || !cents(active) || active > charge.amount || ![succeeded, active].includes(charge.amount_refunded)) return "refund_totals_changed";
  return "";
}
function associations({ event, target, refunds, view, references, intent, charge }) {
  const result = [];
  for (const refund of refunds) {
    const matches = references.filter(row => row.stripeRefundId === refund.id || row.stripeObjectId === refund.id);
    if (matches.length > 1) return { problem: "ambiguous_refund" };
    let operation = matches[0] || null;
    if (!operation && target?.id === refund.id && typeof event.request?.idempotency_key === "string") {
      // The signed original request key, not editable refund metadata, connects
      // an interrupted create response with the durable server-side request.
      const requests = view.requests.filter(row => row.meta?.idempotencyKey === event.request.idempotency_key);
      if (requests.length > 1) return { problem: "ambiguous_refund_request" };
      if (requests.length === 1) {
        const requested = requests[0];
        operation = view.operations.find(row => id(row._id) === requested.meta.operationId && row.operationKey === requested.meta.operationKey);
        if (!operation || requested.meta.paymentIntentId !== intent.id || requested.meta.chargeId !== charge.id || requested.meta.amount !== refund.amount || requested.meta.currency !== refund.currency || refund.metadata?.disputeId && refund.metadata.disputeId !== requested.meta.disputeId) return { problem: "refund_request_mismatch" };
      }
    }
    if (!operation && view.requests.some(requested => view.operations.some(row => id(row._id) === requested.meta?.operationId && !row.stripeRefundId))) return { problem: "unassociated_refund_request" };
    if (operation) {
      const expectedAmount = operation.refundAmount > 0 ? operation.refundAmount : operation.kind === "refund" ? operation.amount : null;
      if (id(operation.caseId) !== id(view.raw._id) || !["refund", "dispute_settlement"].includes(operation.kind) || operation.stripeRefundId && operation.stripeRefundId !== refund.id || operation.stripePaymentIntentId && operation.stripePaymentIntentId !== intent.id || operation.stripeChargeId && operation.stripeChargeId !== charge.id || expectedAmount != null && expectedAmount !== refund.amount || operation.currency && operation.currency !== refund.currency || ["test", "live"].includes(operation.stripeMode) && operation.stripeMode !== (event.livemode ? "live" : "test")) return { problem: "refund_operation_mismatch" };
    }
    result.push({ refund, operation });
  }
  return { result, problem: "" };
}

async function record({ event, receiptFilter, stripe, ip, ua }) {
  const object = event.data?.object || {}, chargeEvent = event.type === "charge.refunded";
  const eventHash = fingerprint([event.id, event.type, event.created, event.livemode, event.account, event.request, object]);
  const auditId = new mongoose.Types.ObjectId(fingerprint(["stripe_refund_event", event.id]).slice(0, 24));
  let problem = !types.has(event.type) ? "unsupported_refund_event" : typeof event.livemode !== "boolean" ? "invalid_mode" : event.account ? "unsupported_connected_account_refund" : !external(object.id, chargeEvent ? "ch" : "re") || object.object !== (chargeEvent ? "charge" : "refund") ? "invalid_refund_event" : "";
  let view, target, charge, intent, refunds = [], references = [], matched = [];
  const alreadyRecorded = await Audit.collection.findOne({ _id: auditId }, { readConcern: { level: "majority" } });
  if (!alreadyRecorded && !problem) {
    target = chargeEvent ? null : await stripe.refunds.retrieve(object.id);
    const chargeId = chargeEvent ? object.id : id(target?.charge);
    if (!external(chargeId, "ch") || target && target.id !== object.id) problem = "invalid_refund_reference";
    else {
      charge = await stripe.charges.retrieve(chargeId);
      const intentId = id(charge?.payment_intent);
      if (!external(intentId, "pi") || charge?.id !== chargeId) problem = "invalid_charge_reference";
      else {
        view = await inventory(intentId); problem = view.problem;
        if (!problem) {
          intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] });
          refunds = await allRefunds(stripe, chargeId);
          problem = evidenceProblem({ event, target, charge, intent, refunds, raw: view.raw });
          if (["refund_snapshot_changed", "refund_totals_changed"].includes(problem)) throw new Error("Stripe refund records changed during verification; a fresh delivery is required.");
          if (!problem) {
            references = await refundReferences(refunds);
            const association = associations({ event, target, refunds, view, references, intent, charge }); problem = association.problem; matched = association.result || [];
          }
        }
      }
    }
  }
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    if (!await Delivery.collection.findOne(receiptFilter, { session })) throw new Error("The refund delivery attempt is no longer current.");
    const previous = await Audit.collection.findOne({ _id: auditId }, { session });
    let result = { caseId: view?.raw?._id || null, needsReview: Boolean(problem), outcome: problem ? "needs_review" : "observed" };
    if (previous) {
      if (previous.meta?.eventHash !== eventHash) throw new Error("The retained refund event does not match this delivery.");
      result = { caseId: previous.case || null, needsReview: false, outcome: "already_recorded" };
    } else {
      if (alreadyRecorded) throw new Error("The retained refund event disappeared during verification.");
      if (view && fingerprint(await inventory(id(charge.payment_intent), session)) !== fingerprint(view)) throw new Error("The Matter refund records changed during provider verification.");
      if (!problem && fingerprint(await refundReferences(refunds, session)) !== fingerprint(references)) throw new Error("The refund references changed during verification.");
      let confirmedTotal = null;
      if (!problem) {
        const now = new Date(), mode = event.livemode ? "live" : "test";
        for (const { refund, operation } of matched) {
          const values = { stripeRefundId: refund.id, refundAmount: refund.amount, stripePaymentIntentId: intent.id, stripeChargeId: charge.id, currency: refund.currency, stripeMode: mode, refundStatus: refund.status, refundEvidenceStatus: "verified", refundVerifiedAt: now, refundCreatedAt: date(refund.created), updatedAt: now };
          if (!operation) {
            await Operation.create([{ operationKey: `stripe_refund:${mode}:${refund.id}`, caseId: view.raw._id, kind: "refund", fingerprint: fingerprint([id(view.raw._id), intent.id, charge.id, refund.id, refund.amount, refund.currency, mode]), amount: refund.amount, stripeObjectId: refund.id, status: refund.status === "succeeded" ? "succeeded" : negative.has(refund.status) ? "failed" : "pending", ...values }], { session });
          } else {
            if (operation.kind === "refund") Object.assign(values, { status: refund.status === "succeeded" ? "succeeded" : negative.has(refund.status) ? "failed" : "pending", stripeObjectId: refund.id });
            else if (negative.has(refund.status) && operation.status !== "succeeded") Object.assign(values, { status: "needs_reconciliation", evidenceStatus: "quarantined", lastError: "Stripe recorded a refund that did not complete for this settlement." });
            const saved = await Operation.collection.updateOne({ _id: operation._id }, { $set: values }, { session });
            if (saved.matchedCount !== 1) throw new Error("The retained refund operation could not be updated.");
          }
        }
        confirmedTotal = refunds.filter(refund => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0);
        const pending = refunds.some(refund => ["pending", "requires_action"].includes(refund.status));
        const paymentStatus = confirmedTotal === charge.amount ? "refunded" : confirmedTotal > 0 ? "partially_refunded" : pending ? "refund_pending" : "refund_failed";
        // A refund to the attorney does not undo a separate paralegal transfer,
        // reopen the Matter, or restore its remaining amount.
        const knownPaymentStatuses = [null, undefined, "", "pending", "succeeded", "refunded", "partially_refunded", "refund_pending", "refund_failed", "refund_canceled", "requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "verification_failed"];
        const protectedStatus = !knownPaymentStatuses.includes(view.raw.paymentStatus) || view.operations.some(row => row.kind === "chargeback" && ["pending_review", "acknowledged"].includes(row.administrativeStatus));
        const values = !protectedStatus && view.raw.paymentStatus !== paymentStatus ? { paymentStatus } : {};
        const saved = await Case.collection.updateOne({ _id: view.raw._id }, { $set: { ...values, updatedAt: now }, $inc: { __v: 1 } }, { session });
        if (saved.matchedCount !== 1) throw new Error("The Matter refund projection could not be updated.");
        result.outcome = paymentStatus;
        result.needsReview = refunds.some(refund => negative.has(refund.status)) || Boolean(charge.disputed) || protectedStatus;
      }
      await Audit.create([{
        _id: auditId, actor: null, actorRole: "system", action: event.type, targetType: "payment", case: result.caseId, ip, ua, method: "POST", path: "/api/webhooks/stripe",
        meta: { eventId: event.id, eventHash, kind: "refund_observation", externalRef: typeof object.id === "string" ? object.id.slice(0, 220) : null, outcome: result.outcome, associationProblem: problem || null, confirmedRefundAmount: confirmedTotal, refundCount: refunds.length, currency: intent?.currency || null },
      }], { session });
    }
    const finalized = await Delivery.updateOne(receiptFilter, { $set: { status: "processed", lastError: "" } }, { session });
    if (!finalized.matchedCount) throw new Error("The refund delivery attempt changed before commit.");
    await session.commitTransaction();
    return result;
  } catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyRefundEvents.transaction_abort")); throw error; }
  finally { await session.endSession(); }
}

module.exports = { record };
