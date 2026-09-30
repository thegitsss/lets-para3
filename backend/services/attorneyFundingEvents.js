"use strict";

const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose");
const Case = require("../models/Case"), User = require("../models/User"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { fingerprint } = require("./matterDraftRevision"), { operationFingerprint } = require("../utils/paymentOperationFingerprint");
const { inspectFundingCandidate, distinctFundingIntentIds, operationMatchesEvidence, fundingOperationKey, captureRecoveryUpdate } = require("./fundingEvidenceBackfillService");
const { amountsFor, validateIntent, expandCapturedIntent, paymentProjection, mayActivateFunding, approvedFundingParticipant: approved, lockFundingActivation } = require("./attorneyFunding");
const id = value => String(value?._id || value?.id || value || ""), validId = value => /^[a-f0-9]{24}$/i.test(id(value));
const external = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(value);
const personProjection = { role: 1, status: 1, disabled: 1, deleted: 1, stripeCustomerId: 1 };

async function inventory(intentId, session) {
  const options = { session };
  const cases = await Case.collection.find({ $or: [{ paymentIntentId: intentId }, { escrowIntentId: intentId }, { hiringClaimPaymentIntentId: intentId }, { relatedPaymentIntentIds: intentId }] }, options).sort({ _id: 1 }).limit(3).toArray();
  const references = await Operation.collection.find({ kind: "funding", $or: [{ stripePaymentIntentId: intentId }, { stripeObjectId: intentId }] }, options).sort({ _id: 1 }).limit(3).toArray();
  const caseIds = [...new Set([...cases.map(row => id(row._id)), ...references.map(row => id(row.caseId))])];
  if (cases.length > 1 || references.length > 1 || caseIds.length !== 1 || !validId(caseIds[0])) return { problem: caseIds.length ? "ambiguous_payment" : "unassociated_payment", cases, references };
  const raw = cases[0] || await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseIds[0]) }, options);
  if (!raw) return { problem: "missing_matter", cases, references };
  const refs = [raw._id, id(raw._id)];
  const operations = await Operation.collection.find({ caseId: { $in: refs } }, options).sort({ _id: 1 }).limit(4001).toArray();
  const payouts = await Payout.collection.find({ caseId: { $in: refs } }, options).sort({ _id: 1 }).limit(4001).toArray();
  if (operations.length > 4000 || payouts.length > 4000) throw new Error("The funding record inventory exceeds its verification limit.");
  const ownerId = raw.attorney || raw.attorneyId, paraId = raw.paralegal || raw.paralegalId;
  const owner = validId(ownerId) ? await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id(ownerId)) }, { ...options, projection: personProjection }) : null;
  const person = validId(paraId) ? await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id(paraId)) }, { ...options, projection: personProjection }) : null;
  const ids = distinctFundingIntentIds(raw);
  const problem = ids.some(value => value !== intentId) ? "conflicting_payment_references" : !owner || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId) ? "owner_mismatch" : raw.paralegal && raw.paralegalId && id(raw.paralegal) !== id(raw.paralegalId) ? "assignment_mismatch" : "";
  return { problem, raw, cases, references, operations, payouts, owner, person };
}

async function duplicateEvidence(raw, evidence, session) {
  return Operation.collection.findOne({ kind: "funding", caseId: { $nin: [raw._id, id(raw._id)] }, $or: [{ stripePaymentIntentId: evidence.stripePaymentIntentId }, { stripeObjectId: evidence.stripePaymentIntentId }, { stripeChargeId: evidence.stripeChargeId }, { stripeBalanceTransactionId: evidence.stripeBalanceTransactionId }] }, { session });
}

async function record({ event, receiptFilter, stripe, ip, ua }) {
  const object = event.data?.object || {}, intentId = object.id;
  const eventHash = fingerprint([event.id, event.type, event.created, event.livemode, event.account, object]);
  const auditId = new mongoose.Types.ObjectId(fingerprint(["stripe_funding_event", event.id]).slice(0, 24));
  let problem = !external(intentId, "pi") || object.object !== "payment_intent" ? "invalid_payment" : typeof event.livemode !== "boolean" || object.livemode !== event.livemode ? "invalid_mode" : event.account ? "unsupported_connected_account_funding" : "";
  let view = null, intent = null, inspection = null;
  // Funding is created on the platform. An authenticated connected-account
  // event must not be interpreted as a platform payment with the same ID.
  const alreadyRecorded = await Audit.collection.findOne({ _id: auditId }, { readConcern: { level: "majority" } });
  if (!alreadyRecorded && !problem) {
    view = await inventory(intentId);
    problem = view.problem;
    if (!problem) {
      intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge.balance_transaction"] });
      try {
        if (intent?.id !== intentId || intent?.object !== "payment_intent" || intent.livemode !== event.livemode) throw Object.assign(new Error("Payment identity mismatch"), { status: 409 });
        // A retained funding operation can supply association when old Case
        // aliases are absent; metadata alone never supplies that association.
        const checkedRaw = { ...view.raw, paymentIntentId: intentId, escrowIntentId: intentId };
        const checked = { ...view, raw: checkedRaw, amounts: amountsFor(checkedRaw) };
        validateIntent(intent, checked);
        intent = await expandCapturedIntent(intent, checked, stripe);
        if (intent.status === "succeeded") {
          inspection = await inspectFundingCandidate({ caseDoc: checkedRaw, operations: view.operations, stripeClient: stripe, paymentIntent: intent, allowCaptureRecovery: true });
          if (inspection.action === "review" || !external(inspection.evidence?.stripeChargeId, "ch") || !external(inspection.evidence?.stripeBalanceTransactionId, "txn")) problem = "capture_needs_review";
          else if (await duplicateEvidence(view.raw, inspection.evidence)) problem = "shared_funding_evidence";
        }
      } catch (error) {
        if (error.status !== 409) throw error;
        problem = "payment_evidence_mismatch";
      }
    }
  }
  const session = await mongoose.startSession();
  let dispatchNotice;
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    if (!await Delivery.collection.findOne(receiptFilter, { session })) throw new Error("The funding delivery attempt is no longer current.");
    const previous = await Audit.collection.findOne({ _id: auditId }, { session });
    let result = { caseId: view?.raw?._id || null, needsReview: Boolean(problem), outcome: problem ? "needs_review" : "observed", workReady: false, paymentAction: false, paymentStatus: intent?.status || null };
    if (previous) {
      if (previous.meta?.eventHash !== eventHash) throw new Error("The retained funding event does not match this delivery.");
      result = { ...result, caseId: previous.case || null, needsReview: false, outcome: "already_recorded" };
    } else {
      if (alreadyRecorded) throw new Error("The retained funding event disappeared before verification.");
      if (view && fingerprint(await inventory(intentId, session)) !== fingerprint(view)) throw new Error("The Matter funding records changed during provider verification.");
      if (!problem && inspection && await duplicateEvidence(view.raw, inspection.evidence, session)) throw new Error("The funding evidence was associated with another Matter during verification.");
      if (!problem) {
        const raw = view.raw, now = new Date();
        const values = paymentProjection(raw, intent.status, view.operations, view.payouts);
        if (inspection) {
          const evidence = inspection.evidence;
          if (inspection.action === "create") await Operation.create([{ operationKey: fundingOperationKey(id(raw._id), intentId), caseId: raw._id, kind: "funding", fingerprint: operationFingerprint(evidence), status: "succeeded", amount: evidence.grossAmount, stripeObjectId: intentId, ...evidence, evidenceVerifiedAt: now, completedAt: now }], { session });
          else {
            const operation = view.operations.find(row => id(row._id) === id(inspection.operationId));
            if (!operation) throw new Error("The retained funding operation changed.");
            const recovery = inspection.action === "recover" ? captureRecoveryUpdate(operation, evidence, now) : null;
            const comparison = operationMatchesEvidence(operation, evidence);
            if (inspection.action === "recover" ? !recovery : comparison.conflicts.length) throw new Error("The retained funding evidence changed.");
            const saved = await Operation.collection.updateOne({ _id: operation._id, status: operation.status, fingerprint: operation.fingerprint }, { $set: { ...(recovery || comparison.missing), ...(!operation.evidenceVerifiedAt ? { evidenceVerifiedAt: now } : {}), updatedAt: now } }, { session });
            if (saved.matchedCount !== 1) throw new Error("The retained funding operation could not be updated.");
          }
          Object.assign(values, { paymentIntentId: intentId, escrowIntentId: intentId, stripeMode: intent.livemode ? "live" : "test", fundingIntegrityStatus: "verified", fundingIntegrityFailure: "", fundingVerifiedAt: raw.fundingVerifiedAt || now });
          if (mayActivateFunding(raw, view.operations, view.payouts) && approved(view.owner, "attorney") && approved(view.person, "paralegal")) {
            await lockFundingActivation(view, session);
            values.escrowStatus = "funded";
            if (!["in progress", "in_progress"].includes(raw.status)) values.status = "in progress";
            if (!raw.hiredAt) values.hiredAt = now;
            result.workReady = raw.escrowStatus !== "funded";
          }
          result.outcome = "verified";
        } else result.paymentAction = Boolean(values.paymentStatus && ["requires_action", "requires_payment_method", "canceled"].includes(intent.status));
        if (Object.keys(values).length) {
          const saved = await Case.collection.updateOne({ _id: raw._id }, { $set: { ...values, updatedAt: now }, $inc: { __v: 1 } }, { session });
          if (saved.matchedCount !== 1) throw new Error("The Matter funding projection could not be updated.");
        }
        if (result.workReady) {
          dispatchNotice = await require("../utils/notifyUser").notifyUser(id(raw.paralegal || raw.paralegalId), "case_work_ready", { caseId: raw._id, caseTitle: raw.title || "Untitled Matter", link: `case-detail.html?caseId=${raw._id}` }, { session, deferDispatch: true, workReady: true });
        } else if (result.paymentAction && raw.escrowStatus !== "funded" && ["open", "in progress", "in_progress"].includes(raw.status)) {
          dispatchNotice = await require("../utils/notifyUser").notifyUser(id(raw.attorney || raw.attorneyId), "case_update", {
            caseId: raw._id, caseTitle: raw.title || "Untitled Matter", outcome: "payment_action_required",
            summary: require("./matterPaymentNotifications").paymentActionSummary(intent.status),
            link: `case-detail.html?caseId=${raw._id}&tab=financials`,
          }, { session, deferDispatch: true, paymentAction: { paymentIntentId: intentId, paymentStatus: intent.status } });
        }
      }
      await Audit.create([{
        _id: auditId, actor: null, actorRole: "system", action: !problem && inspection ? "payment.intent.succeeded" : problem ? "payment.intent.needs_review" : event.type,
        targetType: "payment", targetId: external(intentId, "pi") ? intentId : null, case: result.caseId, ip, ua, method: "POST", path: "/api/webhooks/stripe",
        meta: { eventId: event.id, eventHash, externalRef: external(intentId, "pi") ? intentId : null, outcome: result.outcome, associationProblem: problem || null, status: intent?.status || null, amount: intent?.amount ?? null, currency: intent?.currency || null },
      }], { session });
    }
    const finalized = await Delivery.updateOne(receiptFilter, { $set: { status: "processed", lastError: "" } }, { session });
    if (!finalized.matchedCount) throw new Error("The funding delivery attempt changed before commit.");
    await session.commitTransaction();
    if (dispatchNotice) await dispatchNotice().catch(reportOperationalFailure("services.attorneyFundingEvents.funding_notice_dispatch"));
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyFundingEvents.transaction_abort"));
    throw error;
  } finally { await session.endSession(); }
}

module.exports = { record };
