"use strict";

const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose"), Case = require("../models/Case"), User = require("../models/User"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Audit = require("../models/AuditLog"), Delivery = require("../models/WebhookEvent");
const { fingerprint } = require("./matterDraftRevision"), { expectedCaseFunding, validatePaymentIntentForCase } = require("../utils/paymentIntegrity"), { currentStripeMode } = require("../utils/stripeMode");
const id = value => String(value?._id || value?.id || value || ""), external = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(value), money = value => Number.isSafeInteger(value) && value >= 0;
const eventTypes = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"]);
const intentStates = new Set(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"]);
async function limited(collection, query, session) {
  const rows = await collection.find(query, { session }).sort({ _id: 1 }).limit(4001).toArray();
  if (rows.length > 4000) throw new Error("The original Checkout inventory exceeds its verification limit.");
  return rows;
}
async function inventory(sessionId, intentId, session) {
  const cases = await limited(Case.collection, { escrowSessionId: sessionId }, session), raw = cases.length === 1 ? cases[0] : null;
  const ownerId = id(raw?.attorney || raw?.attorneyId), owner = /^[a-f0-9]{24}$/i.test(ownerId) ? await User.collection.findOne({ _id: new mongoose.Types.ObjectId(ownerId) }, { session, projection: { stripeCustomerId: 1 } }) : null;
  const refs = raw ? [raw._id, id(raw._id)] : [];
  const operations = raw ? await limited(Operation.collection, { caseId: { $in: refs } }, session) : [], payouts = raw ? await limited(Payout.collection, { caseId: { $in: refs } }, session) : [];
  const intentCases = intentId ? await limited(Case.collection, { $or: [{ paymentIntentId: intentId }, { escrowIntentId: intentId }, { hiringClaimPaymentIntentId: intentId }, { relatedPaymentIntentIds: intentId }] }, session) : [];
  const intentOperations = intentId ? await limited(Operation.collection, { $or: [{ stripePaymentIntentId: intentId }, { stripeObjectId: intentId }] }, session) : [];
  return { cases, raw, owner, operations, payouts, intentCases, intentOperations };
}
async function observe(sessionId, event, stripe, { allowNoIntent = false, requestOptions } = {}) {
  let view = await inventory(sessionId, null);
  if (view.cases.length !== 1) return { view, problem: view.cases.length ? "checkout_session_ambiguous" : "checkout_session_unmatched" };
  const checkout = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] }, requestOptions);
  // Verify the retrieved session and retained owner before using its payment
  // reference for another provider read. These facts are checked again below
  // against the final local snapshot.
  if (checkout?.id !== sessionId || checkout.object !== "checkout.session" || checkout.mode !== "payment" || !["open", "complete", "expired"].includes(checkout.status) || !["paid", "unpaid", "no_payment_required"].includes(checkout.payment_status) || !money(checkout.amount_total) || checkout.amount_total <= 0 || !/^[a-z]{3}$/.test(checkout.currency || "")) return { view, checkout, problem: "checkout_evidence_conflict" };
  if (typeof checkout.livemode !== "boolean" || checkout.livemode !== event.livemode || ["live", "test"].includes(view.raw.stripeMode) && view.raw.stripeMode !== (checkout.livemode ? "live" : "test") || ["live", "test"].includes(currentStripeMode()) && currentStripeMode() !== (checkout.livemode ? "live" : "test")) return { view, checkout, problem: "checkout_mode_conflict" };
  if (!view.owner || !external(view.owner.stripeCustomerId, "cus") || id(checkout.customer) !== view.owner.stripeCustomerId) return { view, checkout, problem: "checkout_owner_conflict" };
  if (checkout.amount_total !== expectedCaseFunding(view.raw).totalAmount || checkout.currency !== String(view.raw.currency || "usd").toLowerCase()) return { view, checkout, problem: "checkout_amount_conflict" };
  const intentId = id(checkout?.payment_intent), intent = external(intentId, "pi") ? await stripe.paymentIntents.retrieve(intentId, {}, requestOptions) : null;
  const noIntent = allowNoIntent && checkout.payment_intent === null && ["open", "expired"].includes(checkout.status) && checkout.payment_status === "unpaid";
  view = await inventory(sessionId, external(intentId, "pi") ? intentId : null);
  const raw = view.raw, mode = checkout?.livemode ? "live" : "test";
  let problem = !raw ? "checkout_session_changed" : checkout?.id !== sessionId || checkout.object !== "checkout.session" || checkout.mode !== "payment" || !["open", "complete", "expired"].includes(checkout.status) || !["paid", "unpaid", "no_payment_required"].includes(checkout.payment_status) || !money(checkout.amount_total) || checkout.amount_total <= 0 || !/^[a-z]{3}$/.test(checkout.currency || "") ? "checkout_evidence_conflict" : "";
  if (!problem && (typeof checkout.livemode !== "boolean" || checkout.livemode !== event.livemode || ["live", "test"].includes(currentStripeMode()) && currentStripeMode() !== mode || ["live", "test"].includes(raw.stripeMode) && raw.stripeMode !== mode)) problem = "checkout_mode_conflict";
  if (!problem && (!view.owner || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId) || !external(view.owner.stripeCustomerId, "cus") || id(checkout.customer) !== view.owner.stripeCustomerId)) problem = "checkout_owner_conflict";
  if (!problem && (checkout.amount_total !== expectedCaseFunding(raw).totalAmount || checkout.currency !== String(raw.currency || "usd").toLowerCase())) problem = "checkout_amount_conflict";
  if (!problem && [checkout.client_reference_id, checkout.metadata?.caseId].filter(Boolean).some(value => value !== id(raw._id))) problem = "checkout_matter_conflict";
  if (!problem && !external(intentId, "pi") && !noIntent) problem = "checkout_payment_unavailable";
  if (!problem && !noIntent && (intent?.id !== intentId || intent.object !== "payment_intent" || !intentStates.has(intent.status) || intent.livemode !== checkout.livemode || id(intent.customer) !== id(checkout.customer) || intent.amount !== checkout.amount_total || intent.currency !== checkout.currency || !validatePaymentIntentForCase(intent, raw).valid || checkout.payment_status === "paid" && intent.status !== "succeeded")) problem = "checkout_payment_conflict";
  if (!problem && intent?.metadata?.attorneyId && intent.metadata.attorneyId !== id(raw.attorney || raw.attorneyId)) problem = "checkout_owner_conflict";
  if (!problem && [raw.paymentIntentId, raw.escrowIntentId, raw.hiringClaimPaymentIntentId, ...(raw.relatedPaymentIntentIds || [])].filter(Boolean).some(value => value !== intentId)) problem = "checkout_retained_payment_conflict";
  if (!problem && view.operations.some(value => [value.stripePaymentIntentId, value.kind === "funding" ? value.stripeObjectId : null].filter(reference => external(reference, "pi")).some(reference => reference !== intentId))) problem = "checkout_retained_payment_conflict";
  if (!problem && (view.intentCases.some(value => id(value._id) !== id(raw._id)) || view.intentOperations.some(value => id(value.caseId) !== id(raw._id)))) problem = "checkout_payment_reference_conflict";
  if (!problem && [raw.hiringClaimToken, raw.completionClaimToken, raw.withdrawalClaimToken].some(Boolean)) problem = "checkout_matter_decision_in_progress";
  return { view, checkout, intent, intentId: external(intentId, "pi") ? intentId : null, problem };
}

async function record({ event, receiptFilter, stripe, ip, ua }) {
  const sessionId = event.data?.object?.id, eventHash = fingerprint([event.id, event.type, event.created, event.livemode, event.account, event.request, event.data?.object]);
  const auditId = new mongoose.Types.ObjectId(fingerprint(["stripe_checkout_event", event.id]).slice(0, 24));
  const recorded = await Audit.collection.findOne({ _id: auditId }, { readConcern: { level: "majority" } });
  let problem = !external(event.id, "evt") || !external(sessionId, "cs") || event.data?.object?.object !== "checkout.session" || !eventTypes.has(event.type) || typeof event.livemode !== "boolean" ? "invalid_checkout_event" : event.account ? "unsupported_connected_account_checkout" : "";
  let observation;
  if (!recorded && !problem) { observation = await observe(sessionId, event, stripe); problem = observation.problem; }
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    if (receiptFilter && !await Delivery.collection.findOne(receiptFilter, { session })) throw new Error("The Checkout delivery attempt is no longer current.");
    const previous = await Audit.collection.findOne({ _id: auditId }, { session }); let result;
    if (previous) {
      if (previous.meta?.eventHash !== eventHash) throw new Error("The retained Checkout event does not match this delivery.");
      result = { alreadyRecorded: true, needsReview: Boolean(previous.meta?.problem), caseId: previous.case ? id(previous.case) : null };
    } else {
      if (recorded) throw new Error("The retained Checkout audit disappeared during verification.");
      if (observation && fingerprint(await inventory(sessionId, observation.intentId, session)) !== fingerprint(observation.view)) throw new Error("The original Checkout records changed during verification.");
      const raw = observation?.view.raw;
      if (!problem) {
        const saved = await Case.collection.updateOne({ _id: raw._id }, { $set: { paymentIntentId: observation.intent.id, escrowIntentId: observation.intent.id }, $inc: { __v: 1 } }, { session });
        if (saved.matchedCount !== 1) throw new Error("The original Checkout payment reference could not be retained.");
      }
      await Audit.create([{ _id: auditId, actor: null, actorRole: "system", action: event.type, targetType: "payment", targetId: external(sessionId, "cs") ? sessionId : null, case: raw?._id || null, ip, ua, method: "POST", path: "/api/webhooks/stripe", meta: { eventId: event.id, eventHash, problem, observationOrigin: "stripe_checkout_callback", checkoutStatus: observation?.checkout?.status || null, checkoutPaymentStatus: observation?.checkout?.payment_status || null, paymentIntentId: !problem ? observation.intent.id : null, referenceRetained: !problem } }], { session });
      result = { needsReview: Boolean(problem), caseId: raw ? id(raw._id) : null };
    }
    if (receiptFilter) {
      const saved = await Delivery.updateOne(receiptFilter, { $set: { status: "processed", lastError: "" } }, { session });
      if (saved.matchedCount !== 1) throw new Error("The Checkout delivery changed before commit.");
    }
    await session.commitTransaction(); return result;
  } catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyCheckoutEvents.transaction_abort")); throw error; }
  finally { await session.endSession(); }
}

module.exports = { record, observe, inventory };
