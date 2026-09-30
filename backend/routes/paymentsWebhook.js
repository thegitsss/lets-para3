// backend/routes/paymentsWebhook.js
/**
 * IMPORTANT: mount with RAW body in index.js (NO JSON parsing before this route):
 *
 *   // put this BEFORE any bodyParser.json()
 *   app.use("/api/webhooks/stripe", require("body-parser").raw({ type: "application/json" }));
 *   app.use("/api/webhooks", require("./routes/paymentsWebhook"));
 *
 * Do NOT JSON-parse this endpoint before constructEvent().
 */
const express = require("express");
const router = express.Router();
const stripe = require("../utils/stripe");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog"); // match filename
const WebhookEvent = require("../models/WebhookEvent");
const transferEvents = require("../services/attorneyTransferEvents");
const fundingEvents = require("../services/attorneyFundingEvents");
const refundEvents = require("../services/attorneyRefundEvents");
const checkoutEvents = require("../services/attorneyCheckoutEvents");
const { currentStripeMode, pickStripeMode, stripeModeFromLivemode } = require("../utils/stripeMode");
const { sendOwnerAlert } = require("../utils/opsAlerting");
const { recordChargebackEvent } = require("../services/chargebackService");
const { createLogger, logPromiseFailure } = require("../utils/logger");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const logger = createLogger("stripe-webhook");

function errorMetadata(error) {
  return {
    name: String(error?.name || "Error").slice(0, 80),
    code: String(error?.code || error?.type || "STRIPE_WEBHOOK_ERROR").slice(0, 100),
  };
}

// ----------------------------------------
// Durable dedupe (db-backed) with retry-safe status tracking
// ----------------------------------------
function processingAttempt(eventId, record) {
  if (!record?._id || record.eventId !== eventId || !Number.isSafeInteger(record.attempts) || record.attempts < 1 || !(record.lastAttemptAt instanceof Date) || !Number.isFinite(record.lastAttemptAt.getTime())) {
    throw new Error("The webhook delivery attempt could not be verified.");
  }
  return { _id: record._id, eventId, status: "processing", attempts: record.attempts, lastAttemptAt: record.lastAttemptAt };
}
async function claimWebhookEvent(event) {
  if (typeof event?.id !== "string" || !/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id) || typeof event.type !== "string" || !event.type || event.type.length > 200) throw new Error("The signed webhook event has no valid delivery identity.");
  // The existing unique index is the arbiter for concurrent first deliveries.
  // Refuse handling until it is present; this read creates no index or record.
  const indexes = await WebhookEvent.collection.indexes();
  if (!indexes.some(index => index.unique === true && !index.partialFilterExpression && Object.keys(index.key).length === 1 && index.key.eventId === 1)) throw new Error("The unique webhook delivery index is unavailable.");
  const now = new Date();
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const stripeMode = pickStripeMode(stripeModeFromLivemode(event?.livemode), currentStripeMode());
  try {
    const record = await WebhookEvent.findOneAndUpdate(
      {
        eventId: event.id,
        $or: [
          { status: { $in: ["received", "failed"] } },
          { status: "processing", lastAttemptAt: { $lt: staleCutoff } },
        ],
      },
      {
        $setOnInsert: { provider: "stripe", eventId: event.id, type: event.type },
        $set: { status: "processing", lastAttemptAt: now, stripeMode },
        $inc: { attempts: 1 },
      },
      { upsert: true, returnDocument: "after", writeConcern: { w: "majority" } }
    );
    processingAttempt(event.id, record);
    return { deduped: false, record };
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await WebhookEvent.findOne({ eventId: event.id }).select("status").lean();
      if (existing?.status === "processed") return { deduped: true };
      return { deduped: false, retryLater: true };
    }
    logger.error("Webhook receipt claim failed.", errorMetadata(err));
    throw err;
  }
}

async function markWebhookEventProcessed(eventId, record) {
  const result = await WebhookEvent.updateOne(
    processingAttempt(eventId, record),
    { $set: { status: "processed", lastError: "" } },
    { writeConcern: { w: "majority" } }
  );
  if (!result?.matchedCount) {
    throw new Error(`Webhook delivery receipt could not be finalized for ${eventId}.`);
  }
}

async function markWebhookEventFailed(eventId, err, record) {
  try {
    const result = await WebhookEvent.updateOne(
      processingAttempt(eventId, record),
      { $set: { status: "failed", lastError: String(err?.message || err || "Unknown error") } },
      { writeConcern: { w: "majority" } }
    );
    // A newer delivery may be active or already complete. A lost acknowledgement
    // may also have followed our successful processed write. Neither is ours to
    // reset or report as a fresh payment-processing failure.
    if (!result?.matchedCount) return;
    if (String(process.env.STRIPE_WEBHOOK_ALERTS_ENABLED || "true").toLowerCase() !== "false") {
      await sendOwnerAlert("LPC attention needed: payment status update issue", [
        "A payment status update did not finish cleanly and should be reviewed.",
        `Reference: ${eventId}`,
        `Details: ${String(err?.message || err || "Unknown error")}`,
      ]).catch(logPromiseFailure(logger, "Webhook failure owner alert delivery failed.", { eventId }));
    }
  } catch (updateErr) {
    logger.warn("Webhook failure-state update failed.", errorMetadata(updateErr));
  }
}

function pickSecret(req) {
  // If you configure a separate endpoint for Stripe Connect events, set STRIPE_CONNECT_WEBHOOK_SECRET
  const isConnect = !!req.headers["stripe-account"]; // header present for Connect webhooks
  return isConnect && process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET;
}

// ----------------------------------------
// Core webhook endpoint
// ----------------------------------------
router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = pickSecret(req);
  logger.info("Webhook delivery received.", {
    hasSignature: Boolean(sig),
    signatureState: req.headers["stripe-signature"] ? "present" : "missing",
  });

  let event;
  try {
    // req.body must be a Buffer (raw), not a parsed object
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    logger.warn("Webhook signature verification failed.", errorMetadata(err));
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  let claim;
  try {
    claim = await claimWebhookEvent(event);
  } catch (err) {
    logger.warn("Webhook delivery could not be claimed.", errorMetadata(err));
    return res.status(503).json({ received: false, handled: false, retryable: true });
  }
  const { deduped, retryLater } = claim;
  if (deduped) {
    return res.json({ received: true, deduped: true });
  }
  if (retryLater) {
    return res.status(503).json({ received: false, handled: false, retryable: true });
  }

  let businessReceiptFinalized = false;
  try {
    switch (event.type) {
      // ------------------------------
      // PaymentIntent lifecycle
      // ------------------------------
      case "payment_intent.succeeded":
      case "payment_intent.amount_capturable_updated":
      case "payment_intent.processing":
      case "payment_intent.requires_action":
      case "payment_intent.canceled":
      case "payment_intent.payment_failed": {
        const outcome = await fundingEvents.record({ event, receiptFilter: processingAttempt(event.id, claim.record), stripe, ip: req.ip, ua: req.headers["user-agent"] });
        businessReceiptFinalized = true;
        if (outcome.caseId) {
          await (async () => {
            const current = await Case.findById(outcome.caseId);
            if (!current) return;
            publishCaseProjectionRefresh(current, "matter_payment_refresh", { discovery: true });
          })().catch(logPromiseFailure(logger, "Funding projection notification failed.", { eventId: event.id }));
        }
        if (outcome.needsReview) await sendOwnerAlert("LPC attention needed: Matter funding review", [`Reference: ${event.id}`, "The funding evidence was retained for review without changing financial records."]).catch(logPromiseFailure(logger, "Funding review alert delivery failed.", { eventId: event.id }));
        break;
      }

      // ------------------------------
      // Checkout Session (optional flow)
      // ------------------------------
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const result = await checkoutEvents.record({ event, receiptFilter: processingAttempt(event.id, claim.record), stripe, ip: req.ip, ua: req.headers["user-agent"] });
        businessReceiptFinalized = true;
        if (!result.alreadyRecorded && result.caseId) await (async () => {
          const current = await Case.findById(result.caseId).select("_id attorney attorneyId paralegal paralegalId withdrawnParalegalId").lean();
          if (current) publishCaseProjectionRefresh(current, "matter_payment_refresh");
        })().catch(logPromiseFailure(logger, "Original Checkout projection refresh failed.", { eventId: event.id }));
        if (!result.alreadyRecorded && result.needsReview) await sendOwnerAlert("LPC attention needed: original Checkout payment", [`Event: ${event.id}`, "The original payment reference needs review. Existing Matter and financial records have been preserved."]).catch(logPromiseFailure(logger, "Original Checkout review alert failed.", { eventId: event.id }));
        break;
      }

      // ------------------------------
      // Stripe chargebacks (separate from LPC work-quality disputes)
      // ------------------------------
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated": {
        const dispute = event.data.object;
        const result = await recordChargebackEvent({
          event,
          dispute,
          stripeClient: stripe,
          receiptFilter: processingAttempt(event.id, claim.record),
          ip: req.ip,
          ua: req.headers["user-agent"],
        });
        businessReceiptFinalized = true;
        if (result.alreadyRecorded) break;
        if (result.operation?.caseId) await (async () => {
          const chargebackCase = await Case.findById(result.operation.caseId)
            .select("_id attorney attorneyId paralegal paralegalId withdrawnParalegalId")
            .lean();
          if (chargebackCase) publishCaseProjectionRefresh(chargebackCase, "matter_chargeback_refresh");
        })().catch(logPromiseFailure(logger, "Chargeback projection refresh failed.", { eventId: event.id }));
        await sendOwnerAlert("LPC attention needed: Stripe chargeback review", [
          `Matter: ${String(result.operation?.caseId || "unmatched")}`,
          `Dispute reference: ${String(dispute.id)}`,
          `Processor status: ${String(result.operation?.processorStatus || "unknown")}`,
          `Evidence status: ${String(result.operation?.evidenceStatus || "needs_review")}`,
        ]).catch(logPromiseFailure(logger, "Chargeback owner alert delivery failed.", {
          eventId: event.id,
        }));
        break;
      }

      // ------------------------------
      // Refunds (charge/refund objects)
      // ------------------------------
      case "charge.refunded":
      case "charge.refund.updated":
      case "refund.created":
      case "refund.updated":
      case "refund.succeeded":
      case "refund.failed": {
        const outcome = await refundEvents.record({ event, receiptFilter: processingAttempt(event.id, claim.record), stripe, ip: req.ip, ua: req.headers["user-agent"] });
        businessReceiptFinalized = true;
        if (outcome.caseId) await (async () => {
          const current = await Case.findById(outcome.caseId);
          if (current) publishCaseProjectionRefresh(current, "matter_refund_refresh");
        })().catch(logPromiseFailure(logger, "Refund projection refresh failed.", { eventId: event.id }));
        if (outcome.needsReview) await sendOwnerAlert("LPC attention needed: refund review", [`Reference: ${event.id}`, "The retained refund outcome needs payment review. Separate paralegal payouts and Matter history have been preserved."]).catch(logPromiseFailure(logger, "Refund review alert delivery failed.", { eventId: event.id }));
        break;
      }

      // ------------------------------
      // Connect Transfers (optional payouts)
      // ------------------------------
      case "transfer.created":
      case "transfer.updated":
      case "transfer.reversed":
      case "transfer.failed": {
        const result = await transferEvents.record({ event, receiptFilter: processingAttempt(event.id, claim.record), ip: req.ip, ua: req.headers["user-agent"] });
        businessReceiptFinalized = true;
        if (result.caseId) {
          const current = await Case.findById(result.caseId);
          if (current) publishCaseProjectionRefresh(current, "matter_payout_refresh");
        }
        if (result.needsReview) {
          await sendOwnerAlert("LPC: Stripe transfer requires payment review", [
            `Case: ${String(result.caseId || "unassociated")}`,
            `Transfer: ${String(event.data?.object?.id || "unknown").slice(0, 200)}`,
            `Event: ${event.type}`,
          ]).catch(logPromiseFailure(logger, "Payout-reconciliation owner alert delivery failed.", { eventId: event.id }));
        }
        break;
      }

      // ------------------------------
      // Fallback: log other events at low detail (optional)
      // ------------------------------
      default: {
        await AuditLog.create({
          actor: null,
          actorRole: "system",
          action: `stripe.${event.type}`,
          targetType: "other",
          targetId: event.id,
          case: null,
          ip: req.ip,
          ua: req.headers["user-agent"],
          method: "POST",
          path: "/api/webhooks/stripe",
          meta: { eventId: event.id, type: event.type },
        });
        break;
      }
    }
  } catch (err) {
    logger.error("Webhook handling failed.", { eventId: event.id, ...errorMetadata(err) });
    await markWebhookEventFailed(event.id, err, claim.record);
    return res.status(500).json({ received: false, handled: false });
  }

  try {
    if (!businessReceiptFinalized) await markWebhookEventProcessed(event.id, claim.record);
  } catch (err) {
    logger.error("Webhook receipt finalization failed.", { eventId: event.id, ...errorMetadata(err) });
    await markWebhookEventFailed(event.id, err, claim.record);
    return res.status(500).json({ received: false, handled: false });
  }
  res.json({ received: true });
});

module.exports = router;
