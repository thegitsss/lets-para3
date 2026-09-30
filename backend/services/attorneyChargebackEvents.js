"use strict";

const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose");
const User = require("../models/User"), AuthSession = require("../models/AuthSession");
const Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Income = require("../models/PlatformIncome"), Adjustment = require("../models/FinancialAdjustment"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { fingerprint } = require("./matterDraftRevision"), { expectedCaseFunding, validatePaymentIntentForCase } = require("../utils/paymentIntegrity"), { currentStripeMode } = require("../utils/stripeMode");
const id = value => String(value?._id || value?.id || value || "");
const reference = (value, prefix) => typeof value === "string" && new RegExp(`^(?:${prefix})_[A-Za-z0-9_]{1,200}$`).test(value);
const money = value => Number.isSafeInteger(value) && value >= 0;
const date = seconds => Number.isSafeInteger(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? new Date(seconds * 1000) : null;
const eventTypes = new Set(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"]);
const { PROCESSOR_STATES: processorStates, TERMINAL_PROCESSOR_STATES: terminalStates, buildAdjustmentCandidates } = require("./chargebackService");

async function limited(collection, filter, session) {
  const rows = await collection.find(filter, { session }).sort({ _id: 1 }).limit(4001).toArray();
  if (rows.length > 4000) throw new Error("The card-dispute inventory exceeds its verification limit.");
  return rows;
}

async function inventory(disputeId, intentId, session) {
  const operations = await limited(Operation.collection, { $or: [{ operationKey: `chargeback:${disputeId}` }, { stripeDisputeId: disputeId }, { stripeObjectId: disputeId }] }, session);
  const cases = intentId ? await limited(Case.collection, { $or: [{ paymentIntentId: intentId }, { escrowIntentId: intentId }] }, session) : [];
  const raw = cases.length === 1 ? cases[0] : null;
  const refs = raw ? [raw._id, id(raw._id)] : [];
  const caseOperations = raw ? await limited(Operation.collection, { caseId: { $in: refs } }, session) : [];
  const payouts = raw ? await limited(Payout.collection, { caseId: { $in: refs } }, session) : [];
  const incomes = raw ? await limited(Income.collection, { caseId: { $in: refs } }, session) : [];
  const adjustments = await limited(Adjustment.collection, { stripeDisputeId: disputeId }, session);
  return { operations, cases, raw, caseOperations, payouts, incomes, adjustments };
}

async function transactionReferences(transactions, session) {
  return limited(Adjustment.collection, { stripeBalanceTransactionId: { $in: transactions.map(value => value.id) } }, session);
}

function associationProblem(view, intent, charge, dispute, mode) {
  if (view.cases.length !== 1) return view.cases.length ? "case_ambiguous" : "case_unmatched";
  const raw = view.raw;
  if ([raw.paymentIntentId, raw.escrowIntentId].filter(Boolean).some(value => value !== intent.id)) return "case_payment_intent_conflict";
  if (raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId)) return "case_owner_conflict";
  if (["live", "test"].includes(raw.stripeMode) && raw.stripeMode !== mode) return "case_mode_conflict";
  const expected = expectedCaseFunding(raw);
  if (!validatePaymentIntentForCase(intent, raw).valid || intent.amount !== expected.totalAmount || intent.amount_received !== expected.totalAmount || charge.amount !== expected.totalAmount) return "case_capture_conflict";
  for (const object of [intent, charge, dispute]) if (object.metadata?.caseId && object.metadata.caseId !== id(raw._id)) return "case_metadata_conflict";
  if (intent.metadata?.attorneyId && intent.metadata.attorneyId !== id(raw.attorney || raw.attorneyId)) return "case_owner_conflict";
  return "";
}

function payoutPosition(view) {
  if (!view.raw) return "unknown";
  if (view.raw.paymentReleased || reference(view.raw.payoutTransferId, "tr")) return "post_payout";
  if (view.payouts.some(row => row.status === "paid" && reference(row.transferId, "tr"))) return "post_payout";
  if (view.caseOperations.some(row => ["case_payout", "partial_payout", "dispute_settlement"].includes(row.kind) && reference(row.stripeTransferId || row.stripeObjectId, "tr"))) return "post_payout";
  return "pre_payout";
}

function hasRetainedCase(view, evidence) {
  return Boolean(view?.raw && evidence?.intent?.id && [view.raw.paymentIntentId, view.raw.escrowIntentId].filter(Boolean).every(value => value === evidence.intent.id)
    && !(view.raw.attorney && view.raw.attorneyId && id(view.raw.attorney) !== id(view.raw.attorneyId))
    && (!["live", "test"].includes(view.raw.stripeMode) || view.raw.stripeMode === evidence.mode));
}

async function providerEvidence(disputeId, event, stripe) {
  const dispute = await stripe.disputes.retrieve(disputeId, { expand: ["charge", "balance_transactions"] });
  if (dispute?.id !== disputeId || dispute.object !== "dispute" || !processorStates.has(dispute.status) || !money(dispute.amount) || !dispute.amount || typeof dispute.livemode !== "boolean" || !/^[a-z]{3}$/.test(dispute.currency || "")) return { problem: "dispute_evidence_conflict", dispute };
  const mode = dispute.livemode ? "live" : "test";
  if (event && event.livemode !== dispute.livemode || currentStripeMode() !== "unknown" && currentStripeMode() !== mode) return { problem: "dispute_mode_conflict", dispute, mode };
  const chargeId = id(dispute.charge);
  if (!reference(chargeId, "ch")) return { problem: "charge_unmatched", dispute, mode };
  const charge = await stripe.charges.retrieve(chargeId, { expand: ["payment_intent"] });
  const intentId = id(charge?.payment_intent);
  if (charge?.id !== chargeId || charge.object !== "charge" || !reference(intentId, "pi")) return { problem: "charge_evidence_conflict", dispute, charge, mode };
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] });
  if (intent?.id !== intentId || intent.object !== "payment_intent" || intent.status !== "succeeded" || intent.livemode !== dispute.livemode || charge.livemode !== dispute.livemode || charge.status !== "succeeded" || charge.paid !== true || charge.captured !== true || !money(charge.amount) || charge.amount <= 0 || charge.amount_captured !== charge.amount || intent.amount_received !== charge.amount || intent.amount !== charge.amount || intent.currency !== charge.currency || charge.currency !== dispute.currency || id(intent.latest_charge) !== chargeId || dispute.payment_intent && id(dispute.payment_intent) !== intentId || !money(charge.amount_refunded) || charge.amount_refunded > charge.amount) return { problem: "capture_evidence_conflict", dispute, charge, intent, mode };
  if (!Array.isArray(dispute.balance_transactions) || dispute.balance_transactions.length > 4000) throw new Error("Stripe returned an incomplete dispute balance inventory.");
  const transactions = [], seen = new Set();
  for (const value of dispute.balance_transactions) {
    const transactionId = id(value);
    if (!reference(transactionId, "txn") || seen.has(transactionId)) throw new Error("Stripe returned duplicate or invalid dispute balance references.");
    seen.add(transactionId);
    // Expanded objects are provider-read evidence; event-snapshot objects never
    // reach this list. A reference-only entry is retrieved independently.
    const transaction = typeof value === "object" && value.object === "balance_transaction" ? value : await stripe.balanceTransactions.retrieve(transactionId);
    if (transaction?.id !== transactionId || transaction.object !== "balance_transaction" || !Number.isSafeInteger(transaction.amount) || !Number.isSafeInteger(transaction.fee) || !Number.isSafeInteger(transaction.net) || transaction.amount - transaction.fee !== transaction.net || transaction.currency !== dispute.currency || id(transaction.source) !== disputeId) return { problem: "balance_transaction_conflict", dispute, charge, intent, transactions, mode };
    transactions.push(transaction);
  }
  return { problem: "", dispute, charge, intent, transactions, mode };
}

const adjustmentMatches = (row, expected) => ["paymentOperationId", "caseId", "adjustmentType", "direction", "amount", "currency", "stripeDisputeId", "stripeChargeId", "stripeBalanceTransactionId", "stripeMode"].every(key => String(row[key] ?? "") === String(expected[key] ?? ""));

async function guardAdministrator(reconciliation, session) {
  const denied = () => { throw Object.assign(new Error("Your administrator access changed. Sign in again before checking the card dispute."), { statusCode: 403, code: "CHARGEBACK_ADMIN_CHANGED" }); };
  if (!/^[a-f0-9]{24}$/i.test(String(reconciliation.actorId || "")) || !Number.isSafeInteger(reconciliation.authVersion) || reconciliation.authVersion < 0) denied();
  const actorId = new mongoose.Types.ObjectId(String(reconciliation.actorId));
  const actor = await User.collection.findOne({ _id: actorId }, { session, projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!actor || actor.role !== "admin" || actor.status !== "approved" || actor.disabled || actor.deleted || Number(actor.authVersion || 0) !== reconciliation.authVersion) denied();
  if (session) {
    const saved = await User.collection.updateOne({ _id: actorId, role: "admin", status: "approved", disabled: { $ne: true }, deleted: { $ne: true }, authVersion: actor.authVersion ?? null }, { $inc: { __v: 1 } }, { session });
    if (saved.matchedCount !== 1) denied();
  }
  if (reconciliation.sessionId) {
    const filter = { sessionId: reconciliation.sessionId, userId: actorId, revokedAt: null, expiresAt: { $gt: new Date() } };
    if (session) { const saved = await AuthSession.collection.updateOne(filter, { $inc: { __v: 1 } }, { session }); if (saved.matchedCount !== 1) denied(); }
    else if (!await AuthSession.collection.findOne(filter)) denied();
  }
}

async function record({ event, stripeClient, receiptFilter, reconciliation, ip, ua }) {
  const isReconciliation = Boolean(reconciliation);
  const changed = message => Object.assign(new Error(isReconciliation ? `${message} Open the card dispute again before checking it.` : message), isReconciliation ? { statusCode: 409, code: "CHARGEBACK_CHANGED" } : {});
  if (isReconciliation) await guardAdministrator(reconciliation);
  const original = isReconciliation ? await Operation.collection.findOne({ _id: new mongoose.Types.ObjectId(String(reconciliation.operationId)), kind: "chargeback" }) : null;
  if (isReconciliation && (!original || !reference(original.stripeDisputeId, "dp|du") || !reference(original.stripeEventId, "evt"))) throw changed("The retained card-dispute reference is unavailable for reconciliation.");
  const disputeId = isReconciliation ? original.stripeDisputeId : event?.data?.object?.id;
  const auditId = isReconciliation ? new mongoose.Types.ObjectId() : new mongoose.Types.ObjectId(fingerprint(["stripe_chargeback_event", event?.id]).slice(0, 24));
  const eventHash = isReconciliation ? fingerprint(["admin_reconciliation", id(auditId), id(original._id), id(reconciliation.actorId)]) : fingerprint([event?.id, event?.type, event?.created, event?.livemode, event?.account, event?.request, event?.data?.object]);
  const eventId = isReconciliation ? original.stripeEventId : event?.id;
  const recorded = await Audit.collection.findOne({ _id: auditId }, { readConcern: { level: "majority" } });
  let problem = !isReconciliation && (!reference(eventId, "evt") || !eventTypes.has(event?.type) || typeof event?.livemode !== "boolean" || event?.data?.object?.object !== "dispute") ? "invalid_dispute_event" : !isReconciliation && event.account ? "unsupported_connected_account_dispute" : !reference(disputeId, "dp|du") ? "invalid_dispute_reference" : "";
  let evidence, view, refs = [];
  if (!recorded && !problem) {
    evidence = await providerEvidence(disputeId, isReconciliation ? null : event, stripeClient);
    problem = evidence.problem;
    view = await inventory(disputeId, evidence.intent?.id);
    if (!problem) problem = associationProblem(view, evidence.intent, evidence.charge, evidence.dispute, evidence.mode);
    if (view.operations.length > 1) problem = "dispute_operation_ambiguous";
    const current = view.operations[0];
    if (current && (current.kind !== "chargeback" || current.operationKey !== `chargeback:${disputeId}` || current.stripeDisputeId !== disputeId || current.caseId && id(current.caseId) !== id(view.raw?._id) || current.stripeChargeId && current.stripeChargeId !== evidence.charge?.id || current.stripePaymentIntentId && current.stripePaymentIntentId !== evidence.intent?.id || current.amount && current.amount !== evidence.dispute.amount || current.currency !== evidence.dispute.currency || ["live", "test"].includes(current.stripeMode) && current.stripeMode !== evidence.mode)) problem = "retained_dispute_conflict";
    if (isReconciliation && (!current || fingerprint(current) !== fingerprint(original))) throw changed("The card-dispute record changed before reconciliation.");
    if (!problem && terminalStates.has(current?.processorStatus) && current.processorStatus !== evidence.dispute.status) problem = "processor_terminal_conflict";
    if (!problem && (evidence.charge.amount_refunded > 0 || view.caseOperations.some(row => row.refundStatus === "succeeded" && row.refundEvidenceStatus === "verified" && row.refundAmount > 0))) problem = "refund_chargeback_overlap";
    refs = await transactionReferences(evidence.transactions || []);
    if (refs.some(row => row.stripeDisputeId !== disputeId || !current || id(row.paymentOperationId) !== id(current._id))) problem = "balance_reference_conflict";
    if (!problem && view.adjustments.some(row => !(evidence.transactions || []).some(transaction => transaction.id === row.stripeBalanceTransactionId))) problem = "balance_history_incomplete";
  }
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    if (isReconciliation) await guardAdministrator(reconciliation, session);
    if (receiptFilter && !await Delivery.collection.findOne(receiptFilter, { session })) throw new Error("The card-dispute delivery attempt is no longer current.");
    const previous = await Audit.collection.findOne({ _id: auditId }, { session });
    let result;
    if (previous) {
      if (previous.meta?.eventHash !== eventHash) throw new Error("The retained card-dispute event does not match this delivery.");
      result = { operation: previous.meta?.operationId ? await Operation.findById(previous.meta.operationId).session(session) : null, adjustments: [], reasons: previous.meta?.reasons || [], processorStateAccepted: false, alreadyRecorded: true };
    } else {
      if (recorded) throw new Error("The retained card-dispute audit disappeared during verification.");
      if (view && fingerprint(await inventory(disputeId, evidence.intent?.id, session)) !== fingerprint(view)) throw changed("The Matter financial records changed during card-dispute verification.");
      if (evidence && fingerprint(await transactionReferences(evidence.transactions || [], session)) !== fingerprint(refs)) throw changed("The card-dispute balance references changed during verification.");
      let operation = view?.operations.length === 1 && view.operations[0].kind === "chargeback" ? view.operations[0] : null;
      const adjustments = [], reasons = problem ? [problem] : [];
      if (["dispute_operation_ambiguous", "retained_dispute_conflict"].includes(problem)) {
        for (const retained of view.operations.filter(value => value.kind === "chargeback")) {
          const quarantined = await Operation.findOneAndUpdate({ _id: retained._id }, { $set: { evidenceStatus: "quarantined", administrativeStatus: "pending_review", status: "needs_reconciliation", lastError: problem, acknowledgedAt: null, acknowledgedBy: null } }, { session, returnDocument: "after" });
          if (!quarantined) throw changed("The retained card-dispute record changed during verification.");
          if (retained.caseId) await Case.collection.updateOne({ _id: retained.caseId }, { $inc: { __v: 1 } }, { session });
          if (operation && id(operation._id) === id(retained._id)) operation = quarantined;
        }
      }
      if (evidence?.dispute?.id === disputeId && evidence.dispute.object === "dispute" && reference(evidence.dispute.id, "dp|du") && typeof evidence.dispute.livemode === "boolean" && money(evidence.dispute.amount) && evidence.dispute.amount > 0 && /^[a-z]{3}$/.test(evidence.dispute.currency || "") && !["dispute_operation_ambiguous", "retained_dispute_conflict"].includes(problem)) {
        const now = new Date(), dispute = evidence.dispute;
        const canonicalStatus = processorStates.has(dispute.status) ? dispute.status : "unknown";
        const stateConflict = terminalStates.has(operation?.processorStatus) && operation.processorStatus !== canonicalStatus;
        const changed = operation && (operation.processorStatus !== canonicalStatus || problem || (evidence.transactions || []).some(transaction => !view.adjustments.some(row => row.stripeBalanceTransactionId === transaction.id)));
        const administrativeStatus = changed ? "pending_review" : operation?.administrativeStatus || "pending_review";
        const values = { processorStatus: stateConflict ? operation.processorStatus : canonicalStatus, evidenceStatus: problem ? "quarantined" : "verified", administrativeStatus, status: !problem && administrativeStatus !== "pending_review" ? "succeeded" : "needs_reconciliation", lastError: reasons.join(","), lastAttemptAt: now, stripeMode: evidence.mode || (dispute.livemode ? "live" : "test"), livemode: dispute.livemode, updatedAt: now };
        if (changed) Object.assign(values, { acknowledgedAt: null, acknowledgedBy: null });
        if (hasRetainedCase(view, evidence)) Object.assign(values, { caseId: view.raw._id, stripeChargeId: evidence.charge.id, stripePaymentIntentId: evidence.intent.id, payoutPosition: operation?.payoutPosition === "post_payout" ? "post_payout" : payoutPosition(view) });
        if (!problem) values.evidenceVerifiedAt = now;
        const incomingAt = !isReconciliation ? date(event.created) : null;
        if (!operation || incomingAt && (!operation.processorEventCreatedAt || incomingAt >= new Date(operation.processorEventCreatedAt))) Object.assign(values, { stripeEventId: eventId, processorEventCreatedAt: incomingAt });
        if (!operation) {
          const rows = await Operation.create([{ operationKey: `chargeback:${disputeId}`, kind: "chargeback", fingerprint: fingerprint({ stripeDisputeId: disputeId }), amount: dispute.amount, currency: dispute.currency, stripeObjectId: disputeId, stripeDisputeId: disputeId, stripeEventId: eventId, payoutPosition: "unknown", attempts: 1, ...values }], { session });
          operation = rows[0];
        } else {
          operation = await Operation.findOneAndUpdate({ _id: operation._id }, { $set: values }, { session, returnDocument: "after" });
          if (!operation) throw new Error("The card-dispute operation disappeared during commit.");
        }
        if (!problem) {
          const income = view.incomes.length === 1 ? view.incomes[0] : null;
          for (const values of buildAdjustmentCandidates({ dispute, charge: evidence.charge, event: { id: eventId }, balanceTransactions: evidence.transactions, stripeMode: evidence.mode })) {
            const candidate = { ...values, paymentOperationId: operation._id, caseId: view.raw._id, platformIncomeId: income?._id || null };
            const existing = view.adjustments.find(row => row.idempotencyKey === candidate.idempotencyKey);
            if (existing && !adjustmentMatches(existing, candidate)) throw new Error("The retained platform adjustment conflicts with current evidence.");
            if (existing) adjustments.push({ adjustment: existing, created: false });
            else { const rows = await Adjustment.create([candidate], { session }); adjustments.push({ adjustment: rows[0], created: true }); }
          }
        }
        if (hasRetainedCase(view, evidence)) {
          const saved = await Case.collection.updateOne({ _id: view.raw._id }, { $inc: { __v: 1 } }, { session });
          if (saved.matchedCount !== 1) throw new Error("The card-dispute Matter guard could not be retained.");
        }
      }
      const previousOperation = view?.operations[0], incomingAt = !isReconciliation ? date(event.created) : null;
      result = { operation, adjustments, reasons, association: { caseDoc: hasRetainedCase(view, evidence) ? view.raw : null, charge: evidence?.charge, paymentIntent: evidence?.intent }, processorStateAccepted: !problem && (isReconciliation || !previousOperation || previousOperation.processorStatus !== evidence?.dispute?.status || !previousOperation.processorEventCreatedAt || Boolean(incomingAt && incomingAt >= new Date(previousOperation.processorEventCreatedAt))) };
      await Audit.create([{
        _id: auditId, actor: isReconciliation ? reconciliation.actorId : null, actorRole: isReconciliation ? "admin" : "system", action: isReconciliation ? "chargeback.admin.reconcile" : event.type, targetType: "payment", targetId: reference(disputeId, "dp|du") ? disputeId : null, case: operation?.caseId || null, ip, ua, method: "POST", path: isReconciliation ? "/api/admin/chargebacks/:operationId/reconcile" : "/api/webhooks/stripe",
        meta: { eventId, eventHash, operationId: operation ? id(operation._id) : null, processorStatus: operation?.processorStatus || null, administrativeStatus: operation?.administrativeStatus || null, evidenceStatus: operation?.evidenceStatus || "needs_review", reasons, adjustmentCount: adjustments.length, observationOrigin: isReconciliation ? "admin_reconciliation" : "stripe_callback" },
      }], { session });
    }
    if (receiptFilter) {
      const saved = await Delivery.updateOne(receiptFilter, { $set: { status: "processed", lastError: "" } }, { session });
      if (!saved.matchedCount) throw new Error("The card-dispute delivery changed before commit.");
    }
    await session.commitTransaction();
    return result;
  } catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyChargebackEvents.transaction_abort")); throw error; }
  finally { await session.endSession(); }
}

async function reviewInventory(operationId, session) {
  const operation = await Operation.collection.findOne({ _id: new mongoose.Types.ObjectId(String(operationId)), kind: "chargeback" }, { session });
  const raw = operation?.caseId ? await Case.collection.findOne({ _id: operation.caseId }, { session }) : null;
  const refs = raw ? [raw._id, id(raw._id)] : [];
  return { operation, raw, payouts: raw ? await limited(Payout.collection, { caseId: { $in: refs } }, session) : [], operations: raw ? await limited(Operation.collection, { caseId: { $in: refs } }, session) : [] };
}

function canClearRemainingPayout(view) {
  const raw = view.raw;
  if (!raw || raw.paymentReleased || raw.completionClaimToken || raw.withdrawalClaimToken || ["failed", "reversed", "needs_reconciliation"].includes(raw.payoutStatus)) return false;
  const transfers = view.operations.filter(value => ["case_payout", "partial_payout", "dispute_settlement"].includes(value.kind));
  if (view.operation.payoutPosition === "pre_payout") return !raw.payoutTransferId && !view.payouts.length && !transfers.length;
  if (view.operation.payoutPosition !== "post_payout" || !money(raw.remainingAmount) || raw.remainingAmount <= 0) return false;
  const entries = [...(raw.withdrawalHistory || []), ...(raw.payoutFinalizedAt ? [raw] : [])].filter(value => value.partialPayoutAmount > 0);
  const original = raw.lockedTotalAmount ?? raw.totalAmount;
  if (!entries.length || !money(original) || entries.some(value => !money(value.partialPayoutAmount) || !reference(value.payoutTransferId, "tr") || !value.payoutFinalizedAt) || new Set(entries.map(value => value.payoutTransferId)).size !== entries.length || entries.reduce((sum, value) => sum + value.partialPayoutAmount, raw.remainingAmount) !== original) return false;
  if (raw.payoutTransferId && !entries.some(value => value.payoutTransferId === raw.payoutTransferId) || view.payouts.length !== entries.length || transfers.length !== entries.length) return false;
  return entries.every(entry => {
    const payout = view.payouts.find(value => value.transferId === entry.payoutTransferId), matches = transfers.filter(value => (value.stripeTransferId || value.stripeObjectId) === entry.payoutTransferId);
    return payout?.status === "paid" && !payout.reversedAt && money(payout.amountPaid) && payout.amountPaid > 0 && payout.stripeMode === view.operation.stripeMode && id(payout.paralegalId) === id(entry.withdrawnParalegalId) && matches.length === 1 && matches[0].kind === "partial_payout" && matches[0].status === "succeeded" && !["quarantined", "needs_reconciliation"].includes(matches[0].evidenceStatus) && matches[0].operationKey === payout.operationKey && matches[0].amount === payout.amountPaid && matches[0].stripeMode === view.operation.stripeMode && matches[0].currency === view.operation.currency && [matches[0].stripeTransferId, matches[0].stripeObjectId].filter(Boolean).every(value => value === payout.transferId);
  });
}

async function changeReview({ operationId, actorId, authVersion = 0, sessionId = null, action, ip, ua }) {
  const conflict = (message, code = "CHARGEBACK_CHANGED") => Object.assign(new Error(message), { statusCode: 409, code });
  if (!/^[a-f0-9]{24}$/i.test(String(operationId))) throw Object.assign(new Error("Invalid chargeback."), { statusCode: 400 });
  if (!["acknowledge", "clear-hold"].includes(action)) throw new Error("Unknown card-dispute review action.");
  const actor = { actorId, authVersion, sessionId }; await guardAdministrator(actor);
  const original = await reviewInventory(operationId);
  if (!original.operation) return { found: false };
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    await guardAdministrator(actor, session);
    const view = await reviewInventory(operationId, session);
    if (fingerprint(view) !== fingerprint(original)) throw conflict("The card-dispute records changed. Open the card dispute again before recording a decision.");
    const operation = view.operation;
    if (operation.administrativeStatus === "hold_cleared" || action === "acknowledge" && operation.administrativeStatus === "acknowledged") { await session.commitTransaction(); return { found: true, changed: false, operation }; }
    if (!["pending_review", "acknowledged", null, undefined].includes(operation.administrativeStatus)) throw conflict("The administrative review status needs reconciliation.");
    if (action === "clear-hold") {
      if (operation.processorStatus !== "won" || operation.evidenceStatus !== "verified" || !operation.caseId) throw conflict("This card-dispute hold is not eligible to clear.", "CHARGEBACK_HOLD_NOT_ELIGIBLE");
      if (!canClearRemainingPayout(view)) throw conflict("Payout evidence changed; the hold requires reconciliation.", "CHARGEBACK_HOLD_RECONCILIATION_REQUIRED");
    }
    const now = new Date(), values = action === "clear-hold" ? { administrativeStatus: "hold_cleared", payoutHoldClearedAt: now, payoutHoldClearedBy: actorId, status: "succeeded", lastError: "" } : { administrativeStatus: "acknowledged", acknowledgedAt: now, acknowledgedBy: actorId, ...(operation.evidenceStatus === "verified" ? { status: "succeeded", lastError: "" } : {}) };
    const updated = await Operation.findOneAndUpdate({ _id: operation._id }, { $set: values }, { session, returnDocument: "after" });
    if (!updated) throw conflict("The card-dispute record changed before the decision was saved.");
    if (view.raw) await Case.collection.updateOne({ _id: view.raw._id }, { $inc: { __v: 1 } }, { session });
    await Audit.create([{ actor: actorId, actorRole: "admin", action: action === "clear-hold" ? "chargeback.admin.hold_clear" : "chargeback.admin.acknowledge", targetType: "payment", targetId: operation.stripeDisputeId, case: operation.caseId || null, ip, ua, method: "POST", path: `/api/admin/chargebacks/:operationId/${action}`, meta: { operationId: id(operation._id), processorStatus: operation.processorStatus, evidenceStatus: operation.evidenceStatus } }], { session });
    await session.commitTransaction(); return { found: true, changed: true, operation: updated };
  } catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyChargebackEvents.transaction_abort")); throw error; }
  finally { await session.endSession(); }
}

module.exports = { record, changeReview };
