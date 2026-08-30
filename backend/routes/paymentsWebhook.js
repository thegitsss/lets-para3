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
const mongoose = require("mongoose");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog"); // match filename
const WebhookEvent = require("../models/WebhookEvent");
const Payout = require("../models/Payout");
const PaymentOperation = require("../models/PaymentOperation");
const { notifyUser } = require("../utils/notifyUser");
const { currentStripeMode, pickStripeMode, stripeModeFromLivemode } = require("../utils/stripeMode");
const { sendOwnerAlert } = require("../utils/opsAlerting");
const { expectedCaseFunding, validatePaymentIntentForCase } = require("../utils/paymentIntegrity");
const { reconcileFundingEvidence } = require("../services/fundingEvidenceBackfillService");
const { createLogger, logPromiseFailure } = require("../utils/logger");
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
async function claimWebhookEvent(event) {
  if (!event?.id) return { deduped: false };
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
      { upsert: true, returnDocument: "after" }
    );
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

async function markWebhookEventProcessed(eventId) {
  if (!eventId) return;
  const result = await WebhookEvent.updateOne(
    { eventId, status: "processing" },
    { $set: { status: "processed", lastError: "" } }
  );
  if (!result?.matchedCount) {
    throw new Error(`Webhook delivery receipt could not be finalized for ${eventId}.`);
  }
}

async function markWebhookEventFailed(eventId, err) {
  if (!eventId) return;
  try {
    await WebhookEvent.updateOne(
      { eventId },
      { $set: { status: "failed", lastError: String(err?.message || err || "Unknown error") } }
    );
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

function stripeAccountOpts(req) {
  const acct = req.headers["stripe-account"];
  return acct ? { stripeAccount: acct } : {};
}


// Map PI -> Case using metadata.caseId or escrowIntentId
async function findCaseForPaymentIntent(pi) {
  const caseIdMeta = pi?.metadata?.caseId;
  if (caseIdMeta && mongoose.isValidObjectId(caseIdMeta)) {
    const c = await Case.findById(caseIdMeta);
    if (c) return c;
  }
  if (pi?.id) {
    const c = await Case.findOne({
      $or: [{ escrowIntentId: pi.id }, { paymentIntentId: pi.id }],
    });
    if (c) return c;
  }
  return null;
}

function buildCaseLink(caseDoc) {
  const id = caseDoc?._id || caseDoc?.id;
  return id ? `case-detail.html?caseId=${encodeURIComponent(id)}` : "";
}

const CONFIRMED_REFUND_STATUSES = new Set(["refunded", "partially_refunded"]);

function resolveRefundProjection(currentStatus, eventType, refundObject, expectedTotal) {
  const current = String(currentStatus || "").toLowerCase();
  const objectStatus = String(refundObject?.status || "").toLowerCase();
  const failed = eventType === "refund.failed" || objectStatus === "failed";
  if (failed) return CONFIRMED_REFUND_STATUSES.has(current) ? current : "refund_failed";

  const succeeded =
    eventType === "charge.refunded" ||
    eventType === "refund.succeeded" ||
    objectStatus === "succeeded";
  if (!succeeded) return currentStatus;
  const refundedAmount = Number(refundObject?.amount_refunded ?? refundObject?.amount ?? 0);
  return refundedAmount >= Number(expectedTotal || 0) ? "refunded" : "partially_refunded";
}

function resolveTransferProjection(caseDoc, eventType, transfer) {
  const existingTransferId = String(caseDoc?.payoutTransferId || "");
  const incomingTransferId = String(transfer?.id || "");
  const current = String(caseDoc?.payoutStatus || "not_started").toLowerCase();
  if (existingTransferId && incomingTransferId && existingTransferId !== incomingTransferId) {
    return { status: "needs_reconciliation", preserveRelease: true, reason: "Stripe transfer reference mismatch" };
  }
  if (current === "reversed") {
    return { status: "reversed", preserveRelease: false, reason: caseDoc.payoutFailureReason || "Stripe transfer was reversed" };
  }
  if (current === "failed" && ["transfer.created", "transfer.updated"].includes(eventType)) {
    return { status: "failed", preserveRelease: false, reason: caseDoc.payoutFailureReason || "Stripe transfer failed" };
  }
  if (eventType === "transfer.reversed") {
    return { status: "reversed", preserveRelease: false, reason: "Stripe transfer was reversed" };
  }
  if (eventType === "transfer.failed") {
    return {
      status: "failed",
      preserveRelease: false,
      reason: String(transfer?.failure_message || transfer?.failure_code || "Stripe transfer failed"),
    };
  }
  if (eventType === "transfer.created") {
    return { status: "paid", preserveRelease: true, reason: "" };
  }
  return { status: current, preserveRelease: true, reason: caseDoc?.payoutFailureReason || "" };
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
    return res.status(503).json({ received: false, handled: false, retryable: true });
  }
  const { deduped, retryLater } = claim;
  if (deduped) {
    return res.json({ received: true, deduped: true });
  }
  if (retryLater) {
    return res.status(503).json({ received: false, handled: false, retryable: true });
  }

  try {
    switch (event.type) {
      // ------------------------------
      // PaymentIntent lifecycle
      // ------------------------------
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const c = await findCaseForPaymentIntent(pi);
        const stripeMode = pickStripeMode(
          stripeModeFromLivemode(pi?.livemode),
          stripeModeFromLivemode(event?.livemode),
          c?.stripeMode,
          currentStripeMode()
        );

        if (c) {
          // Snapshot funding info (do NOT auto-release or payout here)
          const wasFunded = String(c.escrowStatus || "").toLowerCase() === "funded";
          const integrity = validatePaymentIntentForCase(pi, c);
          c.stripeMode = stripeMode;
          if (!integrity.valid) {
            c.fundingIntegrityStatus = "failed";
            c.fundingIntegrityFailure = integrity.reasons.join(",");
            if (!wasFunded) c.paymentStatus = "verification_failed";
            await c.save();
            await AuditLog.create({
              actor: null,
              actorRole: "system",
              action: "payment.intent.integrity_failed",
              targetType: "payment",
              targetId: pi.id,
              case: c._id,
              ip: req.ip,
              ua: req.headers["user-agent"],
              method: "POST",
              path: "/api/webhooks/stripe",
              meta: {
                eventId: event.id,
                reasons: integrity.reasons,
                expected: integrity.expected,
                actual: integrity.actual,
              },
            });
            await sendOwnerAlert("LPC urgent: Stripe funding verification failed", [
              `Case: ${String(c._id)}`,
              `PaymentIntent: ${String(pi.id || "unknown")}`,
              `Checks: ${integrity.reasons.join(", ")}`,
              "The Matter was not marked funded.",
            ]).catch(logPromiseFailure(logger, "Payment-integrity owner alert delivery failed.", {
              eventId: event.id,
            }));
            break;
          }
          if (!c.escrowIntentId) c.escrowIntentId = pi.id;
          if (!c.paymentIntentId) c.paymentIntentId = pi.id;
          const { transferable } = stripe.isTransferablePaymentIntent(pi, { caseId: c._id });
          if (!c.escrowStatus || c.escrowStatus !== "funded") {
            if (transferable) {
              c.escrowStatus = "funded";
            } else if (!wasFunded) {
              c.escrowStatus = c.escrowStatus || "awaiting_funding";
            }
          }
          if (!CONFIRMED_REFUND_STATUSES.has(String(c.paymentStatus || "").toLowerCase())) {
            c.paymentStatus = "succeeded";
          }
          c.fundingIntegrityStatus = "verified";
          c.fundingIntegrityFailure = "";
          c.fundingVerifiedAt = new Date();
          const hasParalegal = !!(c.paralegal || c.paralegalId);
          const status = String(c.status || "").toLowerCase();
          if (transferable && hasParalegal && ["awaiting_funding", "assigned", "open"].includes(status)) {
            c.hiredAt = c.hiredAt || new Date();
            c.transitionTo("in progress");
          }
          await c.save();
          await reconcileFundingEvidence({
            caseDoc: c,
            paymentIntent: pi,
            stripeClient: stripe,
            PaymentOperation,
          }).catch(logPromiseFailure(logger, "Funding-evidence reconciliation failed.", {
            eventId: event.id,
            caseId: c._id,
          }));

          if (!wasFunded && transferable && hasParalegal) {
            const paralegalId = c.paralegal?._id || c.paralegalId || c.paralegal;
            if (paralegalId) {
              try {
                await notifyUser(paralegalId, "case_work_ready", {
                  caseId: c._id,
                  caseTitle: c.title || "Untitled Matter",
                  link: buildCaseLink(c),
                });
              } catch (err) {
                logger.warn("Case-work-ready notification failed.", errorMetadata(err));
              }
            }
          }

          await AuditLog.create({
            actor: null,
            actorRole: "system",
            action: "payment.intent.succeeded",
            targetType: "payment",
            targetId: pi.id,
            case: c._id,
            ip: req.ip,
            ua: req.headers["user-agent"],
            method: "POST",
            path: "/api/webhooks/stripe",
            meta: {
              eventId: event.id,
              amount: pi.amount,
              currency: pi.currency,
              stripeMode,
              transfer_group: pi.transfer_group || null,
            },
          });
        }
        if (!c) {
          await AuditLog.create({
            actor: null,
            actorRole: "system",
            action: "payment.intent.unmatched",
            targetType: "payment",
            targetId: pi.id,
            case: null,
            ip: req.ip,
            ua: req.headers["user-agent"],
            method: "POST",
            path: "/api/webhooks/stripe",
            meta: { eventId: event.id, metadataCaseId: pi?.metadata?.caseId || null },
          });
        }
        break;
      }

      case "payment_intent.amount_capturable_updated":
      case "payment_intent.processing":
      case "payment_intent.requires_action":
      case "payment_intent.canceled":
      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const c = await findCaseForPaymentIntent(pi);
        if (c) {
          const wasFunded = String(c.escrowStatus || "").toLowerCase() === "funded";
          if (!wasFunded) {
            if (!c.paymentIntentId) c.paymentIntentId = pi.id;
            if (!c.currency) c.currency = pi.currency || c.currency || "usd";
            if (!c.escrowStatus) c.escrowStatus = "awaiting_funding";
            c.paymentStatus = pi.status || c.paymentStatus || "pending";
            await c.save();
          }
          if (["payment_intent.payment_failed", "payment_intent.canceled", "payment_intent.requires_action"].includes(event.type)) {
            const attorneyId = c.attorney?._id || c.attorneyId || c.attorney || null;
            if (attorneyId) {
              const link = buildCaseLink(c);
              const summary =
                event.type === "payment_intent.requires_action"
                  ? "Payment requires action. Open the Matter to update funding."
                  : "Funding failed. Please update your payment method and try again.";
              try {
                await notifyUser(attorneyId, "case_update", {
                  caseId: c._id,
                  caseTitle: c.title || "Untitled Matter",
                  summary,
                  link,
                });
              } catch (err) {
                logger.warn("Case-update notification failed.", errorMetadata(err));
              }
            }
          }
        }

        await AuditLog.create({
          actor: null,
          actorRole: "system",
          action: event.type,
          targetType: "payment",
          targetId: pi.id,
          case: c?._id || null,
          ip: req.ip,
          ua: req.headers["user-agent"],
          method: "POST",
          path: "/api/webhooks/stripe",
          meta: {
            eventId: event.id,
            last_payment_error: pi.last_payment_error?.message || null,
            amount: pi.amount || null,
            currency: pi.currency || null,
            status: pi.status || null,
          },
        });
        break;
      }

      // ------------------------------
      // Checkout Session (optional flow)
      // ------------------------------
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        const caseId =
          session?.metadata?.caseId ||
          session?.client_reference_id ||
          null;

        if (caseId && mongoose.isValidObjectId(caseId)) {
          const c = await Case.findById(caseId);
          if (c) {
            c.escrowSessionId = session.id;
            if (session.payment_intent && !c.escrowIntentId) {
              c.escrowIntentId =
                typeof session.payment_intent === "string"
                  ? session.payment_intent
                  : session.payment_intent.id;
            }
            await c.save();

            await AuditLog.create({
              actor: null,
              actorRole: "system",
              action: event.type,
              targetType: "payment",
              targetId: session.id,
              case: c._id,
              ip: req.ip,
              ua: req.headers["user-agent"],
              method: "POST",
              path: "/api/webhooks/stripe",
              meta: {
                eventId: event.id,
                payment_intent: session.payment_intent || null,
                amount_total: session.amount_total || null,
                currency: session.currency || null,
              },
            });
          }
        }
        break;
      }

      // ------------------------------
      // Refunds (charge/refund objects)
      // ------------------------------
      case "charge.refunded":
      case "refund.created":
      case "refund.updated":
      case "refund.succeeded":
      case "refund.failed": {
        const obj = event.data.object;
        // Try to link back to a case if we can hop via payment_intent
        let caseForRefund = null;
        if (obj.payment_intent) {
          try {
            const pi =
              typeof obj.payment_intent === "string"
                ? await stripe.paymentIntents.retrieve(
                    obj.payment_intent,
                    stripeAccountOpts(req)
                  )
                : obj.payment_intent;
            caseForRefund = await findCaseForPaymentIntent(pi);
          } catch (err) {
            logger.error("Refund payment-intent lookup failed.", {
              eventId: event.id,
              connectedAccount: Boolean(req.headers["stripe-account"]),
              ...errorMetadata(err),
            });
          }
        }

        if (caseForRefund) {
          const expected = expectedCaseFunding(caseForRefund);
          const nextPaymentStatus = resolveRefundProjection(
            caseForRefund.paymentStatus,
            event.type,
            obj,
            expected.totalAmount
          );
          if (nextPaymentStatus === "refund_failed") {
            await sendOwnerAlert("LPC urgent: Stripe refund failed", [
              `Case: ${String(caseForRefund._id)}`,
              `Refund: ${String(obj.id || "unknown")}`,
              `Amount: ${String(obj.amount || 0)} ${String(obj.currency || "")}`,
            ]).catch(logPromiseFailure(logger, "Refund-failure owner alert delivery failed.", {
              eventId: event.id,
            }));
          }
          caseForRefund.paymentStatus = nextPaymentStatus;
          if (nextPaymentStatus === "refunded") caseForRefund.paymentReleased = false;
          await caseForRefund.save();
        }

        await AuditLog.create({
          actor: null,
          actorRole: "system",
          action: event.type,
          targetType: "payment",
          case: caseForRefund?._id || null,
          ip: req.ip,
          ua: req.headers["user-agent"],
          method: "POST",
          path: "/api/webhooks/stripe",
          meta: {
            eventId: event.id,
            externalRef: obj.id,
            amount: obj.amount,
            currency: obj.currency,
            payment_intent: obj.payment_intent || null,
          },
        });
        break;
      }

      // ------------------------------
      // Connect Transfers (optional payouts)
      // ------------------------------
      case "transfer.created":
      case "transfer.updated":
      case "transfer.reversed":
      case "transfer.failed": {
        const tr = event.data.object;
        // If you used transfer_group: "case_<caseId>", try to recover caseId
        let caseId = null;
        if (tr.transfer_group && tr.transfer_group.startsWith("case_")) {
          const maybe = tr.transfer_group.slice(5);
          if (mongoose.isValidObjectId(maybe)) caseId = maybe;
        }
        const caseObj = caseId ? await Case.findById(caseId) : null;

        if (caseObj) {
          const projection = resolveTransferProjection(caseObj, event.type, tr);
          if (!caseObj.payoutTransferId && event.type === "transfer.created") caseObj.payoutTransferId = tr.id;
          caseObj.payoutStatus = projection.status;
          caseObj.payoutFailureReason = projection.reason;
          if (!projection.preserveRelease) caseObj.paymentReleased = false;
          if (projection.status === "paid") caseObj.paidOutAt = caseObj.paidOutAt || new Date();
          await caseObj.save();

          if (["transfer.reversed", "transfer.failed"].includes(event.type)) {
            await Payout.updateOne(
              { transferId: tr.id },
              {
                $set: {
                  status: event.type === "transfer.reversed" ? "reversed" : "failed",
                  failureReason: caseObj.payoutFailureReason,
                  ...(event.type === "transfer.reversed" ? { reversedAt: new Date() } : {}),
                },
              }
            );
            await sendOwnerAlert("LPC urgent: Stripe payout requires reconciliation", [
              `Case: ${String(caseObj._id)}`,
              `Transfer: ${String(tr.id || "unknown")}`,
              `Event: ${event.type}`,
            ]).catch(logPromiseFailure(logger, "Payout-reconciliation owner alert delivery failed.", {
              eventId: event.id,
            }));
          }

          if (event.type === "transfer.created") {
            await PaymentOperation.updateMany(
              { caseId: caseObj._id, status: "pending" },
              {
                $set: {
                  stripeObjectId: tr.id,
                  status: "needs_reconciliation",
                  lastError: "Stripe transfer exists; waiting for the local payout ledger to finalize.",
                },
              }
            );
          } else if (["transfer.reversed", "transfer.failed"].includes(event.type)) {
            await PaymentOperation.updateMany(
              { caseId: caseObj._id, stripeObjectId: { $in: ["", tr.id] } },
              {
                $set: {
                  stripeObjectId: tr.id,
                  status: "needs_reconciliation",
                  lastError: caseObj.payoutFailureReason,
                },
              }
            );
          }
        }

        await AuditLog.create({
          actor: null,
          actorRole: "system",
          action: event.type,
          targetType: "payment",
          case: caseObj?._id || null,
          ip: req.ip,
          ua: req.headers["user-agent"],
          method: "POST",
          path: "/api/webhooks/stripe",
          meta: {
            eventId: event.id,
            externalRef: tr.id,
            amount: tr.amount,
            currency: tr.currency,
            destination: tr.destination || null,
            transfer_group: tr.transfer_group || null,
            reversal: tr.reversal || null,
          },
        });
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
    await markWebhookEventFailed(event.id, err);
    return res.status(500).json({ received: false, handled: false });
  }

  try {
    await markWebhookEventProcessed(event.id);
  } catch (err) {
    logger.error("Webhook receipt finalization failed.", { eventId: event.id, ...errorMetadata(err) });
    await markWebhookEventFailed(event.id, err);
    return res.status(500).json({ received: false, handled: false });
  }
  res.json({ received: true });
});

module.exports = router;
