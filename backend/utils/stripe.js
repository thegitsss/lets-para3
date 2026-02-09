// backend/utils/stripe.js
const Stripe = require("stripe");

// ----------------------------------------
// Stripe client
// ----------------------------------------
const API_VERSION = process.env.STRIPE_API_VERSION || "2024-06-20";
const SECRET = process.env.STRIPE_SECRET_KEY || "";

if (!SECRET) {
  console.warn("[stripe] STRIPE_SECRET_KEY is not set — Stripe calls will fail.");
}

const stripe = new Stripe(SECRET, {
  apiVersion: API_VERSION,
  maxNetworkRetries: Number(process.env.STRIPE_MAX_RETRIES || 2),
  telemetry: true,
  timeout: Number(process.env.STRIPE_TIMEOUT_MS || 20000),
});

// ----------------------------------------
// Small utilities
// ----------------------------------------
function parseCents(amount) {
  const n = Math.round(Number(amount || 0));
  return Number.isFinite(n) ? n : 0;
}

const DEFAULT_ATTORNEY_FEE_PCT = Number(
  process.env.PLATFORM_FEE_ATTORNEY_PERCENT || process.env.PLATFORM_FEE_PERCENT || 22
);
const DEFAULT_PARALEGAL_FEE_PCT = Number(
  process.env.PLATFORM_FEE_PARALEGAL_PERCENT || 18
);

/**
 * Calculate fee snapshots given total amount in cents.
 * Returns integers (cents): { feeAttorneyAmount, feeParalegalAmount, payout }
 */
function calculateFees(
  totalAmount,
  feeAttorneyPct = DEFAULT_ATTORNEY_FEE_PCT,
  feeParalegalPct = DEFAULT_PARALEGAL_FEE_PCT
) {
  const total = parseCents(totalAmount);
  const feeA = Math.round((total * (Number(feeAttorneyPct) || 0)) / 100);
  const feeP = Math.round((total * (Number(feeParalegalPct) || 0)) / 100);
  const payout = Math.max(0, total - feeP);
  return { feeAttorneyAmount: feeA, feeParalegalAmount: feeP, payout };
}

/**
 * Build the canonical transfer_group for a case (used for Connect transfers).
 */
function caseTransferGroup(caseId) {
  return `case_${String(caseId)}`;
}

/**
 * Create (or safely reuse/update) a PaymentIntent with a transfer_group set.
 * - Ensures amount/currency/metadata match your case
 * - Returns the PI object
 */
async function ensureEscrowIntent({
  caseId,
  amount,           // cents
  currency = "usd",
  attorneyId,
  paralegalId,
  caseName,
  jobTitle,
  paralegalName,
  existingIntentId, // optional: reuse if active
  idempotencyKey,   // optional: pass through for creation
}) {
  const transfer_group = caseTransferGroup(caseId);
  const cleanCaseName = caseName || `Case ${String(caseId)}`;
  const cleanJobTitle = jobTitle || cleanCaseName;
  const cleanParalegalName = paralegalName || "Unassigned Paralegal";
  const meta = {
    caseId: String(caseId),
    caseName: cleanCaseName,
    jobTitle: cleanJobTitle,
    attorneyId: attorneyId ? String(attorneyId) : "",
    paralegalId: paralegalId ? String(paralegalId) : "",
    paralegalName: cleanParalegalName,
  };
  const description = `Case: ${cleanCaseName} — Job: ${cleanJobTitle} — Paralegal: ${cleanParalegalName}`;

  if (existingIntentId) {
    const pi = await stripe.paymentIntents.retrieve(existingIntentId);
    if (pi && !["succeeded", "canceled"].includes(pi.status)) {
      const editable = ["requires_payment_method", "requires_confirmation"].includes(pi.status);
      const needsTG = !pi.transfer_group || pi.transfer_group !== transfer_group;
      const needsAmt = editable && pi.amount !== amount;
      const needsCurr = editable && (pi.currency || "").toLowerCase() !== String(currency).toLowerCase();

      if (editable) {
        return stripe.paymentIntents.update(pi.id, {
          ...(needsTG ? { transfer_group } : {}),
          ...(needsAmt ? { amount } : {}),
          ...(needsCurr ? { currency } : {}),
          metadata: meta,
          description,
        });
      }
      return pi;
    }
  }

  // Create new PI
  return stripe.paymentIntents.create(
    {
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      transfer_group,
      metadata: meta,
      description,
    },
    idempotencyKey ? { idempotencyKey } : undefined
  );
}

/**
 * Create a Checkout Session to fund a specific case (optional flow).
 * Attaches transfer_group to the underlying PaymentIntent.
 */
async function createCheckoutSession({
  caseId,
  amount,                // cents
  currency = "usd",
  successURL,
  cancelURL,
  customerEmail,
}) {
  return stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: customerEmail || undefined,
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: `Case funding #${caseId}` },
          unit_amount: parseCents(amount),
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      transfer_group: caseTransferGroup(caseId),
      metadata: { caseId: String(caseId) },
    },
    success_url: successURL,
    cancel_url: cancelURL,
  });
}

/**
 * Construct & verify a webhook event from a RAW body route.
 * - Detects Connect events via `Stripe-Account` header and picks the right secret.
 * - Throws on signature failure (caller should 400).
 */
function constructWebhookEvent(req) {
  const sig = req.headers["stripe-signature"];
  const isConnect = !!req.headers["stripe-account"];
  const secret = isConnect && process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error("Missing STRIPE_WEBHOOK_SECRET (and STRIPE_CONNECT_WEBHOOK_SECRET for Connect)");
  }

  // req.body must be a Buffer (raw)
  return stripe.webhooks.constructEvent(req.body, sig, secret);
}

/**
 * Get public config for frontend.
 */
function publicConfig() {
  return {
    publishableKey:
      process.env.STRIPE_PUBLISHABLE_KEY ||
      process.env.STRIPE_PK ||
      "",
  };
}

function isStripeTestMode() {
  return String(SECRET || "").startsWith("sk_test_");
}

function getPaymentIntentCharge(paymentIntent) {
  if (!paymentIntent) return null;
  const charges = paymentIntent.charges?.data;
  if (Array.isArray(charges) && charges.length) return charges[0];
  const latest = paymentIntent.latest_charge;
  if (latest && typeof latest === "object") return latest;
  if (latest && typeof latest === "string") return { id: latest };
  return null;
}

function isTransferablePaymentIntent(paymentIntent, { caseId } = {}) {
  if (!paymentIntent || paymentIntent.status !== "succeeded") {
    return { transferable: false, charge: null };
  }
  const charge = getPaymentIntentCharge(paymentIntent);
  if (charge) {
    if (charge.status && charge.status === "failed") return { transferable: false, charge };
    if (charge.paid === false || charge.captured === false) return { transferable: false, charge };
    const amount = Number(charge.amount || 0);
    const refunded = Number(charge.amount_refunded || 0);
    if (amount > 0 && refunded >= amount) return { transferable: false, charge };
  } else if (isStripeTestMode()) {
    return { transferable: true, charge: null };
  }
  const expectedGroup = caseId ? caseTransferGroup(caseId) : "";
  const transferGroup = paymentIntent.transfer_group || charge?.transfer_group || "";
  if (expectedGroup && transferGroup && transferGroup !== expectedGroup) {
    return { transferable: false, charge };
  }
  return { transferable: true, charge };
}

function sanitizeStripeError(err, fallback) {
  const safeFallback = fallback || "We couldn't complete that Stripe action. Please try again.";
  if (!err) return safeFallback;
  const isStripe =
    !!err.type ||
    !!err.code ||
    !!err.raw ||
    !!err.decline_code ||
    (typeof err === "object" && err.name === "StripeError");
  if (isStripe) return safeFallback;
  return err.message || safeFallback;
}

// ----------------------------------------
// Exports
// ----------------------------------------
module.exports = stripe; // default: Stripe client (backwards-compatible)

module.exports.createCheckoutSession = createCheckoutSession; // (kept)
module.exports.ensureEscrowIntent = ensureEscrowIntent;
module.exports.calculateFees = calculateFees;
module.exports.caseTransferGroup = caseTransferGroup;
module.exports.constructWebhookEvent = constructWebhookEvent;
module.exports.publicConfig = publicConfig;
module.exports.isStripeTestMode = isStripeTestMode;
module.exports.getPaymentIntentCharge = getPaymentIntentCharge;
module.exports.isTransferablePaymentIntent = isTransferablePaymentIntent;
module.exports.sanitizeStripeError = sanitizeStripeError;
