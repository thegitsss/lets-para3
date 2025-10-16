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
const router = require("express").Router();
const stripe = require("../utils/stripe");
const mongoose = require("mongoose");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLogs"); // match filename

// ----------------------------------------
// Lightweight, per-process dedupe (use Redis/db in prod)
// ----------------------------------------
const seenEvents = new Set();
function dedupe(eventId) {
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  // keep the set from growing forever
  if (seenEvents.size > 5000) seenEvents.clear();
  seenEvents.add(eventId);
  return false;
}

function pickSecret(req) {
  // If you configure a separate endpoint for Stripe Connect events, set STRIPE_CONNECT_WEBHOOK_SECRET
  const isConnect = !!req.headers["stripe-account"]; // header present for Connect webhooks
  return isConnect && process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET;
}

function safeObjId(v) {
  try { return mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null; }
  catch { return null; }
}

// Map PI -> Case using metadata.caseId or escrowIntentId
async function findCaseForPaymentIntent(pi) {
  const caseIdMeta = pi?.metadata?.caseId;
  if (caseIdMeta && mongoose.isValidObjectId(caseIdMeta)) {
    const c = await Case.findById(caseIdMeta);
    if (c) return c;
  }
  if (pi?.id) {
    const c = await Case.findOne({ escrowIntentId: pi.id });
    if (c) return c;
  }
  return null;
}

// ----------------------------------------
// Core webhook endpoint
// ----------------------------------------
router.post("/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = pickSecret(req);

  let event;
  try {
    // req.body must be a Buffer (raw), not a parsed object
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[stripe] Bad signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Basic dedupe for Stripe retries
  if (dedupe(event.id)) {
    return res.json({ received: true, deduped: true });
  }

  try {
    switch (event.type) {
      // ------------------------------
      // PaymentIntent lifecycle
      // ------------------------------
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const c = await findCaseForPaymentIntent(pi);

        if (c) {
          // Snapshot funding info (do NOT auto-release or payout here)
          if (!c.escrowIntentId) c.escrowIntentId = pi.id;
          if (!c.currency) c.currency = pi.currency || c.currency || "usd";
          if (!c.totalAmount || c.totalAmount <= 0) c.totalAmount = pi.amount || c.totalAmount || 0;
          await c.save();

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
              transfer_group: pi.transfer_group || null,
            },
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
          const pi =
            typeof obj.payment_intent === "string"
              ? await stripe.paymentIntents.retrieve(obj.payment_intent)
              : obj.payment_intent;
          caseForRefund = await findCaseForPaymentIntent(pi);
        }

        await AuditLog.create({
          actor: null,
          actorRole: "system",
          action: event.type,
          targetType: "payment",
          targetId: obj.id,
          case: caseForRefund?._id || null,
          ip: req.ip,
          ua: req.headers["user-agent"],
          method: "POST",
          path: "/api/webhooks/stripe",
          meta: {
            eventId: event.id,
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

        if (caseObj && !caseObj.payoutTransferId) {
          caseObj.payoutTransferId = tr.id;
          if (event.type === "transfer.created") caseObj.paidOutAt = new Date();
          await caseObj.save();
        }

        await AuditLog.create({
          actor: null,
          actorRole: "system",
          action: event.type,
          targetType: "payment",
          targetId: tr.id,
          case: caseObj?._id || null,
          ip: req.ip,
          ua: req.headers["user-agent"],
          method: "POST",
          path: "/api/webhooks/stripe",
          meta: {
            eventId: event.id,
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
    console.error("[stripe] Webhook handling error:", err);
    // Return 2xx so Stripe doesn't retry forever if the error is non-retriable,
    // but in most cases 500 is okay. Keep 500 for now.
    return res.status(500).send("Webhook handler error");
  }

  res.json({ received: true });
});

module.exports = router;
