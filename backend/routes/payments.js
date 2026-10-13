const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:payments");
// backend/routes/payments.js
const router = require("express").Router();
const {computeParalegalFeeFromGross,computeGrossFromDesiredPayout,disputeRevision}=require("../services/disputePreviewService");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const stripe = require("../utils/stripe");
const Case = require("../models/Case");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const Payout = require("../models/Payout");
const PaymentOperation = require("../models/PaymentOperation");
const { buildReceiptPdfBuffer, uploadPdfToS3 } = require("../services/caseLifecycle");
const attorneyReceipts = require("../services/attorneyReceipts");
const { currentStripeMode, pickStripeMode, stripeModeFromLivemode } = require("../utils/stripeMode");
const {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
} = require("../services/platformFeePolicy");
const { createDevOnlyEmailSet } = require("../utils/devOnlyEmailSet");
const { hasStripeConnectBypass } = require("../utils/stripeConnectBypass");
const { validatePaymentIntentForCase } = require("../utils/paymentIntegrity");
const {
  claimPaymentOperation,
  failPaymentOperation,
  recordPaymentOperationEvidence,
  succeedPaymentOperation,
} = require("../services/paymentOperationService");
const {
  upsertPayoutLedger,
  upsertPlatformIncomeLedger,
  withPayoutTransaction,
} = require("../services/paymentLedgerService");
const { getAttorneyPaymentSummary } = require("../services/paymentProjectionService");
const attorneyFunding = require("../services/attorneyFunding");
const paymentCardEvidence = require("../services/paymentCardEvidence");
const attorneyCheckoutRecovery = require("../services/attorneyCheckoutRecovery");
const refundRequests = require("../services/refundRequestService");
const reviewNotices = require("../services/matterReviewNotifications");
const { createPayoutTransfer } = require("../services/payoutHoldService");
const { projectPayoutReadiness } = require("../services/paralegalReadinessService");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");

const fundingResponse = run => async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await run(req)); }
  catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "WORKSPACE_FUNDING_UNAVAILABLE", error: error.publicCode === "WORKSPACE_FUNDING_AMOUNT_TOO_SMALL" ? "Amount must be at least $400." : "Matter funding could not be verified. Review the current payment before continuing." }); }
};

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STRIPE_APPROVAL_BYPASS_EMAILS = createDevOnlyEmailSet([
  "samanthasider+11@gmail.com",
  "samanthasider+cattorney@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);
const STRIPE_PAYOUT_BYPASS_EMAILS = createDevOnlyEmailSet([
  "samanthasider+11@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);

function trimSlash(value) {
  if (!value) return "";
  return String(value).replace(/\/$/, "");
}

function normalizeEmail(value) {
  return String(value || "").toLowerCase().trim();
}

function connectStatusPayload(input = {}) {
  const payload = {
    details_submitted: input.detailsSubmitted === true,
    charges_enabled: input.chargesEnabled === true,
    payouts_enabled: input.payoutsEnabled === true,
    connected: input.connected === true,
    accountId: input.accountId || null,
    bank_name: input.bankName || "",
    bank_last4: input.bankLast4 || "",
    ...(input.devBypass === true ? { devBypass: true } : {}),
  };
  return {
    ...payload,
    readiness: projectPayoutReadiness({
      ...payload,
      source: input.source || "live",
      evidenceState: input.evidenceState || "verified",
    }),
  };
}

async function refundRequestError(res, operation, error) {
  if (operation) await failPaymentOperation(operation, error, { needsReconciliation: true }).catch(logPromiseFailure(runtimeLogger, "Refund request review marker failed."));
  return res.status(error.status || 503).json({ error: error.publicCode ? error.message : "The refund outcome could not be verified. Payment review is required before settling this dispute.", code: error.publicCode || "REFUND_REQUIRES_REVIEW" });
}


function ensureAbsoluteUrl(value, defaultScheme = "https") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `${defaultScheme}:${trimmed}`;
  const lower = trimmed.toLowerCase();
  const isLocal =
    lower.startsWith("localhost") ||
    lower.startsWith("127.0.0.1") ||
    lower.startsWith("0.0.0.0");
  const scheme = isLocal ? "http" : defaultScheme;
  return `${scheme}://${trimmed}`;
}

function resolveConnectUrls() {
  const returnUrl = ensureAbsoluteUrl(process.env.STRIPE_CONNECT_RETURN_URL || "");
  const refreshUrl = ensureAbsoluteUrl(process.env.STRIPE_CONNECT_REFRESH_URL || "");
  if (returnUrl && refreshUrl) {
    return { returnUrl, refreshUrl };
  }
  const baseRaw = process.env.CLIENT_BASE_URL || process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || "";
  const base = trimSlash(ensureAbsoluteUrl(baseRaw));
  if (!base) {
    throw new Error(
      "[payments] Stripe Connect requires STRIPE_CONNECT_RETURN_URL/STRIPE_CONNECT_REFRESH_URL or CLIENT_BASE_URL/FRONTEND_BASE_URL/APP_BASE_URL."
    );
  }
  return {
    returnUrl: `${base}/profile-settings.html?onboarding=success`,
    refreshUrl: `${base}/profile-settings.html?onboarding=refresh`,
  };
}

const { returnUrl: CONNECT_RETURN_URL, refreshUrl: CONNECT_REFRESH_URL } = resolveConnectUrls();
const CONNECT_COUNTRY = process.env.STRIPE_CONNECT_COUNTRY || "US";

const PLATFORM_FEE_ATTORNEY_PERCENT = DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
const PLATFORM_FEE_PARALEGAL_PERCENT = DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;

const CLIENT_BASE_URL = trimSlash(process.env.CLIENT_BASE_URL || process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL);




function resolveAttorneyFeePct(doc = {}) {
  return typeof doc.feeAttorneyPct === "number" && Number.isFinite(doc.feeAttorneyPct)
    ? doc.feeAttorneyPct
    : PLATFORM_FEE_ATTORNEY_PERCENT;
}

function resolveParalegalFeePct(doc = {}) {
  return typeof doc.feeParalegalPct === "number" && Number.isFinite(doc.feeParalegalPct)
    ? doc.feeParalegalPct
    : PLATFORM_FEE_PARALEGAL_PERCENT;
}

function hasActiveDispute(doc) {
  if (!doc) return false;
  const termination = String(doc.terminationStatus || "").toLowerCase();
  if (termination === "disputed" || termination === "resolved") return true;
  if (!Array.isArray(doc.disputes)) return false;
  return doc.disputes.some((d) => {
    const status = String(d?.status || "").toLowerCase();
    return status === "open" || status === "resolved";
  });
}

function hasResolvedDispute(doc) {
  if (!doc) return false;
  const termination = String(doc.terminationStatus || "").toLowerCase();
  if (termination === "resolved") return true;
  if (!Array.isArray(doc.disputes)) return false;
  return doc.disputes.some((d) => String(d?.status || "").toLowerCase() === "resolved");
}

async function ensureStripeOnboarded(paralegal) {
  if (!paralegal?.stripeAccountId) return false;
  if (paralegal.stripeOnboarded && paralegal.stripePayoutsEnabled) return true;
  try {
    const account = await stripe.accounts.retrieve(paralegal.stripeAccountId);
    const submitted = !!account?.details_submitted;
    const chargesEnabled = !!account?.charges_enabled;
    const payoutsEnabled = !!account?.payouts_enabled;
    paralegal.stripeChargesEnabled = chargesEnabled;
    paralegal.stripePayoutsEnabled = payoutsEnabled;
    paralegal.stripeOnboarded = submitted && payoutsEnabled;
    await paralegal.save();
    return paralegal.stripeOnboarded;
  } catch (err) {
    runtimeLogger.warn("[payments] stripe onboarding status check failed", err?.message || err);
  }
  return false;
}

async function ensureConnectAccount(user) {
  if (!user) throw new Error("User not found");
  if (!user.email) throw new Error("Email is required for Stripe onboarding");
  if (user.stripeAccountId) return user.stripeAccountId;
  const account = await stripe.accounts.create(
    {
      type: "express",
      country: CONNECT_COUNTRY,
      email: user.email,
      business_type: "individual",
      capabilities: { transfers: { requested: true } },
      metadata: { userId: String(user._id || "") },
    },
    { idempotencyKey: stripe.stripeIdempotencyKey("connect_account", user._id) }
  );
  user.stripeAccountId = account.id;
  user.stripeOnboarded = false;
  user.stripeChargesEnabled = false;
  user.stripePayoutsEnabled = false;
  await user.save();
  return account.id;
}

async function createConnectLink(accountId) {
  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: CONNECT_REFRESH_URL,
    return_url: CONNECT_RETURN_URL,
    type: "account_onboarding",
  });
}



function resolveClientBase(req) {
  if (CLIENT_BASE_URL) return CLIENT_BASE_URL;

  if (process.env.NODE_ENV === "production") {
    const configuredOrigin = trimSlash(ensureAbsoluteUrl(process.env.PUBLIC_ORIGIN || ""));
    if (configuredOrigin) return configuredOrigin;
    throw new Error(
      "[payments] Production client origin requires CLIENT_BASE_URL/FRONTEND_BASE_URL/APP_BASE_URL or PUBLIC_ORIGIN."
    );
  }

  const origin = req?.headers?.origin || req?.get?.("origin");
  if (origin) {
    try {
      const parsed = new URL(String(origin));
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return trimSlash(parsed.origin);
      }
    } catch (_) {}
  }

  const referer = req?.headers?.referer || req?.get?.("referer");
  if (referer) {
    try {
      const parsed = new URL(String(referer));
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return trimSlash(parsed.origin);
      }
    } catch (_) {}
  }

  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req?.headers?.["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || req?.headers?.host || req?.get?.("host");
  if (host) {
    const scheme = forwardedProto || (req?.secure ? "https" : "http");
    return trimSlash(`${scheme}://${host}`);
  }

  const fallback = process.env.PUBLIC_ORIGIN || "http://localhost:5001";
  return trimSlash(fallback);
}

function extractBankDetails(account) {
  const accounts = Array.isArray(account?.external_accounts?.data)
    ? account.external_accounts.data
    : [];
  const bank = accounts.find((item) => item?.object === "bank_account") || accounts[0] || null;
  return {
    bankName: bank?.bank_name || "",
    bankLast4: bank?.last4 || "",
  };
}

function fullName(person = {}) {
  return [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
}



















function formatCurrency(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents) || cents <= 0) return "$0.00";
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getWithdrawalReceiptKey(caseId, kind, paralegalId) {
  const safeKind = kind === "paralegal" ? "paralegal" : "attorney";
  const suffix =
    safeKind === "paralegal" && paralegalId ? `paralegal-${String(paralegalId)}` : safeKind;
  return `cases/${caseId}/receipt-withdrawal-${suffix}.pdf`;
}

function buildWithdrawalReceiptPayloads(caseDoc, grossAmount) {
  const { gross, feePct, feeAmount, net } = computeParalegalFeeFromGross(grossAmount, caseDoc);
  const issuedAt = caseDoc.payoutFinalizedAt || caseDoc.updatedAt || new Date();
  const attorneyName = fullName(caseDoc.attorney || {}) || caseDoc.attorneyNameSnapshot || "Attorney";
  const paralegalName = fullName(caseDoc.paralegal || {}) || caseDoc.paralegalNameSnapshot || "Paralegal";
  const receiptId = `${caseDoc._id}-withdrawal-${new Date(issuedAt).getTime()}`;
  return {
    attorneyPayload: {
      title: "Payout Receipt",
      receiptId,
      issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
      partyLabel: "Attorney",
      partyName: attorneyName,
      caseTitle: caseDoc.title || "Untitled Matter",
      lineItems: [
        { label: "Partial payout released", value: formatCurrency(gross) },
        { label: "Attorney fee", value: "$0.00" },
      ],
      totalLabel: "Total released",
      totalAmount: formatCurrency(gross),
      paymentMethod: "Stripe release",
      paymentStatus: gross > 0 ? "Released" : "No payout",
    },
    paralegalPayload: {
      title: "Payout Receipt",
      receiptId,
      issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
      partyLabel: "Payee",
      partyName: paralegalName,
      attorneyName,
      caseTitle: caseDoc.title || "Untitled Matter",
      lineItems: [
        { label: "Gross amount", value: formatCurrency(gross) },
        { label: `Platform fee (${feePct}%)`, value: formatCurrency(feeAmount) },
      ],
      totalLabel: "Net paid",
      totalAmount: formatCurrency(net),
      paymentMethod: "Stripe release",
      paymentStatus: gross > 0 ? "Paid" : "No payout",
    },
    netAmount: net,
  };
}



async function ensureStripeCustomer(user, req) {
  if (!user) throw new Error("User not found");
  const previous = String(user.stripeCustomerId || "");
  await paymentSetupAccount(req, previous);
  if (user.stripeCustomerId) {
    const existing = await stripe.customers.retrieve(user.stripeCustomerId, {}, { timeout: 10000, maxNetworkRetries: 0 });
    await paymentSetupAccount(req, previous);
    paymentCardEvidence.customer(existing, previous, user._id);
    return previous;
  }
  const customer = await stripe.customers.create(
    {
      email: user.email || undefined,
      name: fullName(user) || undefined,
      metadata: {
        userId: user._id ? String(user._id) : "",
        role: user.role || "",
      },
    },
    { idempotencyKey: stripe.stripeIdempotencyKey("customer", user._id), timeout: 10000, maxNetworkRetries: 0 }
  );
  const current = await paymentSetupAccount(req, previous);
  paymentCardEvidence.customer(customer, customer?.id, user._id);
  const exact = Object.fromEntries(["role", "status", "disabled", "deleted", "authVersion", "stripeCustomerId"].map(key => [key, current[key] === undefined ? { $exists: false } : { $eq: current[key] }]));
  const saved = await User.collection.updateOne({ _id: current._id, ...exact }, { $set: { stripeCustomerId: customer.id, updatedAt: new Date() }, $inc: { __v: 1 } });
  if (saved.matchedCount !== 1) throw Object.assign(new Error("The saved payment account changed. Refresh before continuing."), { status: 409, publicCode: "PAYMENT_SETUP_CHANGED" });
  user.stripeCustomerId = customer.id;
  return customer.id;
}

function summarizePaymentMethod(pm) {
  if (!pm) return null;
  const card = pm.card || (pm.type === "card" ? pm.card : null);
  return {
    id: pm.id,
    type: pm.type,
    brand: card?.brand || null,
    last4: card?.last4 || null,
    exp_month: card?.exp_month || null,
    exp_year: card?.exp_year || null,
  };
}

async function fetchDefaultPaymentMethod(customerId, req) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId, {}, { timeout: 10000, maxNetworkRetries: 0 });
  await paymentSetupAccount(req, customerId);
  if (!customer || customer.deleted) throw new Error("Saved payment customer is unavailable.");
  paymentCardEvidence.customer(customer, customerId, req.user.id);
  if (!customer.invoice_settings || !Object.hasOwn(customer.invoice_settings, "default_payment_method")) paymentCardEvidence.invalid();
  const reference = customer.invoice_settings?.default_payment_method;
  if (reference === null) return null;
  const defaultPmId = reference?.id || reference;
  if (typeof defaultPmId !== "string" || !/^pm_[A-Za-z0-9_]{1,200}$/.test(defaultPmId)) paymentCardEvidence.invalid();
  try {
    const pm = await stripe.paymentMethods.retrieve(defaultPmId, {}, { timeout: 10000, maxNetworkRetries: 0 });
    await paymentSetupAccount(req, customerId);
    paymentCardEvidence.card(pm, customerId, defaultPmId);
    return summarizePaymentMethod(pm);
  } catch (err) {
    runtimeLogger.warn(`[payments] unable to retrieve default payment method ${defaultPmId}:`, err?.message || err);
    throw err;
  }
}

const attorneyAccountBoundary = require("../services/attorneyAccountBoundary");
async function paymentSetupAccount(req, expectedCustomerId) {
  const providedOwnerId = req.method === "GET" ? req.query?.expectedOwnerId : req.body?.expectedOwnerId;
  const expectedOwnerId = providedOwnerId === undefined ? String(req.user.id) : providedOwnerId;
  const user = await attorneyAccountBoundary.read(req, expectedOwnerId, ["stripeCustomerId"]);
  if (expectedCustomerId !== undefined && String(user.stripeCustomerId || "") !== String(expectedCustomerId || "")) throw Object.assign(new Error("The saved payment account changed. Refresh before continuing."), { status: 409, publicCode: "PAYMENT_SETUP_CHANGED" });
  return user;
}
function paymentSetupFailure(error, res) { return res.status(error.status || 403).json({ code: error.publicCode, error: error.message }); }
async function verifiedCardSetup(req, customerId, intentId) {
  const invalid = () => { throw Object.assign(new Error("This card setup could not be verified for your account."), { status: 409, publicCode: "PAYMENT_SETUP_UNAVAILABLE" }); };
  if (!customerId || typeof intentId !== "string" || !/^seti_[A-Za-z0-9]{1,200}$/.test(intentId)) invalid();
  const intent = await stripe.setupIntents.retrieve(intentId, {}, { timeout: 10000, maxNetworkRetries: 0 });
  await paymentSetupAccount(req, customerId);
  paymentCardEvidence.setup(intent, customerId, intentId, req.user.id);
  let paymentMethod = null;
  if (intent.status === "succeeded") {
    const pmId = intent.payment_method?.id || intent.payment_method;
    if (typeof pmId !== "string" || !/^pm_[A-Za-z0-9_]{1,200}$/.test(pmId)) invalid();
    const pm = await stripe.paymentMethods.retrieve(pmId, {}, { timeout: 10000, maxNetworkRetries: 0 });
    await paymentSetupAccount(req, customerId);
    paymentCardEvidence.card(pm, customerId, pmId);
    paymentMethod = summarizePaymentMethod(pm);
  }
  await paymentSetupAccount(req, customerId);
  return { intentId, status: intent.status, paymentMethod };
}

// ----------------------------------------
// PUBLIC: Stripe publishable key for Stripe.js
// GET /api/payments/config
// ----------------------------------------
router.get('/config', (_req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// All routes below require auth + approval
router.use(verifyToken);
router.use((req, res, next) => {
  const email = String(req.user?.email || "").toLowerCase().trim();
  if (STRIPE_APPROVAL_BYPASS_EMAILS.has(email)) return next();
  return requireApproved(req, res, next);
});
router.param("caseId", ensureCaseParticipant("caseId"));

router.get(
  "/payment-method/default",
  requireRole("attorney"),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { await paymentSetupAccount(req); } catch (error) { return paymentSetupFailure(error, res); }
    const user = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (STRIPE_APPROVAL_BYPASS_EMAILS.has(normalizeEmail(user.email))) {
      try { await paymentSetupAccount(req, user.stripeCustomerId || ""); } catch (error) { return paymentSetupFailure(error, res); }
      return res.json({
        customerId: null,
        hasDefault: true,
        paymentMethod: null,
        devBypass: true,
      });
    }
    if (!user.stripeCustomerId) {
      try { await paymentSetupAccount(req, ""); } catch (error) { return paymentSetupFailure(error, res); }
      return res.json({
        customerId: null,
        hasDefault: false,
        paymentMethod: null,
      });
    }

    try {
      const customerId = user.stripeCustomerId;
      const paymentMethod = await fetchDefaultPaymentMethod(customerId, req);
      await paymentSetupAccount(req, customerId);
      return res.json({
        customerId,
        hasDefault: !!paymentMethod,
        paymentMethod,
      });
    } catch (err) {
      if (err.publicCode) return paymentSetupFailure(err, res);
      runtimeLogger.error("[payments] default payment method lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to load payment method" });
    }
  })
);

router.post(
  "/payment-method/setup-intent",
  requireRole("attorney"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { await paymentSetupAccount(req); } catch (error) { return paymentSetupFailure(error, res); }
    const user = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      const requestKey = String(req.get("Idempotency-Key") || req.get("X-Idempotency-Key") || "").trim();
      if (!/^[A-Za-z0-9._:-]{16,200}$/.test(requestKey)) {
        return res.status(400).json({
          error: "A valid Idempotency-Key header is required to start card setup.",
          code: "IDEMPOTENCY_KEY_REQUIRED",
        });
      }
      const customerId = await ensureStripeCustomer(user, req);
      const intent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          userId: user._id ? String(user._id) : "",
          role: user.role || "",
          email: user.email || "",
        },
      }, {
        idempotencyKey: stripe.stripeIdempotencyKey("setup_intent", user._id, requestKey), timeout: 10000, maxNetworkRetries: 0,
      });

      await paymentSetupAccount(req, customerId);
      paymentCardEvidence.setup(intent, customerId, intent?.id, req.user.id);
      if (typeof intent.client_secret !== "string" || !intent.client_secret.startsWith(`${intent.id}_secret_`) || !/^[A-Za-z0-9_]{1,500}$/.test(intent.client_secret)) paymentCardEvidence.invalid();
      res.json({ clientSecret: intent.client_secret, intentId: intent.id, customerId });
    } catch (err) {
      if (err.publicCode) return paymentSetupFailure(err, res);
      runtimeLogger.error("[payments] setup_intent creation failed", err?.message || err);
      res.status(502).json({ error: "Unable to start card setup" });
    }
  })
);

router.post(
  "/payment-method/default",
  requireRole("attorney"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { await paymentSetupAccount(req); } catch (error) { return paymentSetupFailure(error, res); }
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) {
      return res.status(400).json({ error: "paymentMethodId is required" });
    }
    if (typeof paymentMethodId !== "string" || !/^pm_[A-Za-z0-9_]{1,200}$/.test(paymentMethodId)) return res.status(400).json({ error: "A valid payment method is required." });

    const user = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      const customerId = await ensureStripeCustomer(user, req);
      if (req.body.expectedOwnerId !== undefined) {
        const setup = await verifiedCardSetup(req, customerId, req.body.intentId);
        if (setup.status !== "succeeded" || setup.paymentMethod?.id !== paymentMethodId) return res.status(409).json({ code: "PAYMENT_SETUP_UNAVAILABLE", error: "Complete and verify this card setup before making it the default." });
      }
      let pm = await stripe.paymentMethods.retrieve(paymentMethodId, {}, { timeout: 10000, maxNetworkRetries: 0 });
      if (!pm || pm.type !== "card") {
        return res.status(400).json({ error: "Unsupported payment method type" });
      }
      await paymentSetupAccount(req, customerId);
      paymentCardEvidence.card(pm, customerId, paymentMethodId, { allowUnattached: req.body.expectedOwnerId === undefined });

      const pmCustomerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
      if (!pmCustomerId) {
        pm = await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }, { timeout: 10000, maxNetworkRetries: 0 });
        await paymentSetupAccount(req, customerId);
        paymentCardEvidence.card(pm, customerId, paymentMethodId);
      } else if (pmCustomerId !== customerId) {
        return res.status(403).json({ error: "Payment method does not belong to this customer" });
      }

      await paymentSetupAccount(req, customerId);
      const updated = await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      }, { timeout: 10000, maxNetworkRetries: 0 });

      await paymentSetupAccount(req, customerId);
      paymentCardEvidence.customer(updated, customerId, req.user.id);
      const savedDefault = updated.invoice_settings?.default_payment_method;
      if ((savedDefault?.id || savedDefault) !== paymentMethodId) paymentCardEvidence.invalid();
      res.json({ ok: true, customerId, paymentMethod: summarizePaymentMethod(pm) });
    } catch (err) {
      if (err.publicCode) return paymentSetupFailure(err, res);
      runtimeLogger.error("[payments] failed to set default payment method", err?.message || err);
      res.status(502).json({ error: "Unable to save payment method" });
    }
  })
);

router.get("/payment-method/setup-intent/:intentId", requireRole("attorney"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const user = await attorneyAccountBoundary.read(req, req.query.expectedOwnerId, ["stripeCustomerId"]);
    const setup = await verifiedCardSetup(req, String(user.stripeCustomerId || ""), req.params.intentId);
    return res.json({ ownerId: String(user._id), ...setup });
  } catch (error) {
    if (error.publicCode) return paymentSetupFailure(error, res);
    return res.status(502).json({ error: "Unable to verify card setup." });
  }
}));

/**
 * POST /api/payments/portal
 * Creates a Stripe Billing Portal session for the authenticated attorney.
 */
router.post("/portal", requireRole("attorney"), csrfProtection, async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await require("../services/attorneyPaymentPortal").create(req, { stripe, clientBase: resolveClientBase(req), legacy: true })); }
  catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "PAYMENT_SETUP_PORTAL_UNAVAILABLE", error: "Billing could not be opened. Check the saved card and try again." }); }
});

/**
 * POST /api/payments/start-escrow
 * Body: { caseId }
 * Ensures the attorney has hired a paralegal and initiates funding
 */
router.post("/start-escrow", requireRole("attorney"), csrfProtection, fundingResponse(async req => attorneyFunding.legacy(req, stripe, "prepare")));

router.post(
  "/connect",
  requireRole("paralegal"),
  csrfProtection,
  require("../utils/supportAccountBoundary").requireSupportAccount,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("email stripeAccountId stripeOnboarded");
    if (!user) return res.status(404).json({ error: "User not found" });
    try {
      const accountId = await ensureConnectAccount(user);
      const link = await createConnectLink(accountId);
      res.json({ url: link.url, accountId });
    } catch (err) {
      runtimeLogger.error("[payments] Stripe onboarding link failed", err?.message || err);
      res.status(400).json({ error: "Unable to start Stripe onboarding" });
    }
  })
);

router.post(
  "/connect/create-account",
  requireRole("paralegal"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("email stripeAccountId stripeOnboarded");
    if (!user) return res.status(404).json({ error: "User not found" });
    try {
      const accountId = await ensureConnectAccount(user);
      res.json({ ok: true, accountId });
    } catch (err) {
      runtimeLogger.error("[payments] Stripe account preparation failed", err?.message || err);
      res.status(400).json({ error: "Unable to prepare Stripe account" });
    }
  })
);

router.post(
  "/connect/onboard-link",
  requireRole("paralegal"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { accountId } = req.body || {};
    const user = await User.findById(req.user.id).select("stripeAccountId");
    if (!user) return res.status(404).json({ error: "User not found" });
    const targetAccount = accountId || user.stripeAccountId;
    if (!targetAccount) {
      return res.status(400).json({ error: "Stripe account not created yet" });
    }
    if (user.stripeAccountId && user.stripeAccountId !== targetAccount) {
      return res.status(403).json({ error: "Invalid account reference" });
    }

    const link = await createConnectLink(targetAccount);

    res.json({ url: link.url });
  })
);

router.get(
  "/connect/status",
  requireRole("paralegal"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select(
      "email stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled"
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    if (hasStripeConnectBypass(user.email)) {
      return res.json(connectStatusPayload({
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        connected: true,
        devBypass: true,
        source: "development_bypass",
      }));
    }
    if (!user.stripeAccountId) {
      return res.json(connectStatusPayload({ source: "stored" }));
    }

    try {
      const account = await stripe.accounts.retrieve(user.stripeAccountId, {
        expand: ["external_accounts"],
      });
      const submitted = !!account?.details_submitted;
      const chargesEnabled = !!account?.charges_enabled;
      const payoutsEnabled = !!account?.payouts_enabled;
      const connected = submitted && payoutsEnabled;
      const { bankName, bankLast4 } = extractBankDetails(account);
      const shouldSave =
        user.stripeOnboarded !== connected ||
        user.stripeChargesEnabled !== chargesEnabled ||
        user.stripePayoutsEnabled !== payoutsEnabled;
      if (shouldSave) {
        user.stripeOnboarded = connected;
        user.stripeChargesEnabled = chargesEnabled;
        user.stripePayoutsEnabled = payoutsEnabled;
        await user.save();
      }
      return res.json(connectStatusPayload({
        detailsSubmitted: submitted,
        chargesEnabled,
        payoutsEnabled,
        connected,
        accountId: user.stripeAccountId,
        bankName,
        bankLast4,
        source: "live",
      }));
    } catch (err) {
      runtimeLogger.error("[connect] status error", err?.message || err);
      return res.json(connectStatusPayload({
        accountId: user.stripeAccountId,
        source: "live_lookup_failed",
        evidenceState: "temporarily_unavailable",
      }));
    }
  })
);

/**
 * PATCH /api/payments/:caseId/budget
 * Body: { amountUsd, currency }
 * Attorney-owner or admin only. Validates case budget >= $400.
 */
router.get("/matter/:caseId/funding", requireRole("attorney"), fundingResponse(req => attorneyFunding.read(req)));
router.get("/matter/:caseId/checkout", requireRole("attorney"), fundingResponse(req => attorneyCheckoutRecovery.read(req, stripe)));
router.post("/matter/:caseId/checkout/resume", requireRole("attorney"), csrfProtection, fundingResponse(req => attorneyCheckoutRecovery.resume(req, stripe)));
router.post("/matter/:caseId/funding", requireRole("attorney"), csrfProtection, fundingResponse(req => attorneyFunding.write(req, stripe)));

router.patch("/:caseId/budget", requireRole("attorney", "admin"), csrfProtection, fundingResponse(async req => attorneyFunding.budget(req)));

/**
 * POST /api/payments/intent/:caseId
 * Creates (or reuses) a PaymentIntent to fund this Matter.
 * Attorney (owner) or admin only.
 * Optional header: x-idempotency-key
 */
router.post("/intent/:caseId", requireRole("attorney", "admin"), csrfProtection, fundingResponse(async req => attorneyFunding.legacy(req, stripe, "prepare")));

/**
 * POST /api/payments/confirm/:caseId
 * Confirms Matter funding after client-side Stripe confirmation.
 * Sets escrowStatus to funded and transitions case to in progress when eligible.
 */
router.post("/confirm/:caseId", requireRole("attorney", "admin"), csrfProtection, fundingResponse(async req => attorneyFunding.legacy(req, stripe, "check", true)));

/**
 * POST /api/payments/reconcile/:caseId
 * Re-checks Stripe PaymentIntent and updates case funding state.
 */
router.post("/reconcile/:caseId", requireRole("attorney", "admin"), csrfProtection, fundingResponse(async req => attorneyFunding.legacy(req, stripe, "check")));

/**
 * POST /api/payments/dispute/settle/:caseId
 * Admin-only dispute settlement actions: refund, full release, partial release.
 * Body: { action: 'refund'|'release_full'|'release_partial', disputeId?, grossAmountCents? }
 */
router.post(
  "/dispute/settle/:caseId",
  requireRole("admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const { action, disputeId, grossAmountCents, payoutAmountCents } = req.body || {};
    const allowed = new Set(["refund", "release_full", "release_partial"]);
    if (!allowed.has(String(action || ""))) {
      return res.status(400).json({ error: "Invalid dispute action." });
    }

    const c = await Case.findById(caseId).populate(
      "paralegal",
      "stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled firstName lastName email role"
    );
    await c?.populate?.(
      "withdrawnParalegalId",
      "stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled firstName lastName email role"
    );
    if (!c) return res.status(404).json({ error: "Matter not found" });
    if(req.body?.previewRevision && req.body.previewRevision!==disputeRevision(c))return res.status(409).json({error:"The matter changed after the preview. Review the updated amounts before confirming."});

    const disputes = Array.isArray(c.disputes) ? c.disputes : [];
    let targetDispute = null;
    if (disputeId) {
      targetDispute = disputes.find(
        (d) => String(d.disputeId || d._id) === String(disputeId)
      );
    }
    if (!targetDispute) {
      targetDispute = disputes.find((d) => String(d.status || "").toLowerCase() === "open") || disputes[0];
    }
    if (!targetDispute) {
      return res.status(400).json({ error: "No dispute found for this Matter." });
    }
    const disputeKey = String(targetDispute.disputeId || targetDispute._id || "");
    const operationKey = `dispute_settlement:${String(c._id)}:${disputeKey}`;
    const storedSettlement = c.disputeSettlement || {};
    const requestedPayout = payoutAmountCents ?? grossAmountCents;
    const claimSettlementOperation = () => claimPaymentOperation({
      operationKey,
      caseId: c._id,
      kind: "dispute_settlement",
      fingerprint: {
        action,
        grossAmountCents: grossAmountCents ?? null,
        payoutAmountCents: payoutAmountCents ?? null,
        paymentIntentId: c.escrowIntentId || "",
        paralegalId: String(
          c.paralegal?._id ||
          c.paralegalId ||
          c.paralegal ||
          c.withdrawnParalegalId?._id ||
          c.withdrawnParalegalId ||
          ""
        ),
      },
      amount: Number(payoutAmountCents ?? grossAmountCents ?? c.remainingAmount ?? c.lockedTotalAmount ?? c.totalAmount ?? 0),
      currency: c.currency || "usd",
    });
    const respondToSettlementClaim = (claim) => {
      if (claim.conflict) {
        return res.status(409).json({
          error: "This dispute already has a different financial resolution in progress or completed.",
          code: "PAYMENT_OPERATION_CONFLICT",
        });
      }
      if (claim.needsReconciliation) {
        return res.status(409).json({
          error: "This settlement needs payment review before another financial request can be made.",
          code: "PAYMENT_OPERATION_REQUIRES_REVIEW",
        });
      }
      if (claim.inProgress) {
        return res.status(409).json({
          error: "This dispute settlement is already being processed.",
          code: "PAYMENT_OPERATION_IN_PROGRESS",
        });
      }
      if (claim.completed) {
        return res.status(409).json({ error: "The payment operation is complete but this dispute is still open. The settlement records need payment review.", code: "PAYMENT_OPERATION_REQUIRES_REVIEW" });
      }
      return null;
    };
    let settlementClaim = null, resolutionDispatches = [];
    const storedSettlementMatches =
      String(storedSettlement.disputeId || "") === disputeKey &&
      String(storedSettlement.action || "") === String(action) &&
      !!storedSettlement.resolvedAt &&
      (action !== "release_partial" ||
        (Number.isFinite(Number(requestedPayout)) &&
          Number(storedSettlement.payoutAmount) === Math.round(Number(requestedPayout))));
    if (String(targetDispute.status || "open").toLowerCase() !== "open") {
      if (storedSettlementMatches && ["closed", "paused"].includes(String(c.status || "").toLowerCase())) {
        const retained = await PaymentOperation.findOne({ operationKey }).lean();
        if (!retained || retained.status !== "succeeded" || retained.evidenceStatus === "quarantined" || String(retained.caseId) !== String(c._id) || storedSettlement.refundId && retained.stripeRefundId !== storedSettlement.refundId || storedSettlement.transferId && retained.stripeTransferId !== storedSettlement.transferId) {
          return res.status(409).json({ error: "The retained settlement records need payment review.", code: "PAYMENT_OPERATION_REQUIRES_REVIEW" });
        }
        if (storedSettlement.refundId) {
          try { await refundRequests.verifyRecorded({ caseDoc: c, refundId: storedSettlement.refundId, amount: Number(storedSettlement.refundAmount), disputeId: disputeKey, stripe }); }
          catch (error) { return res.status(error.status || 503).json({ error: "The recorded refund could not be confirmed. Its current outcome needs payment review.", code: error.publicCode || "REFUND_REQUIRES_REVIEW" }); }
        }
        if (storedSettlement.transferId && !await Payout.exists({ operationKey, transferId: storedSettlement.transferId, caseId: c._id, status: "paid" })) {
          return res.status(409).json({ error: "The recorded payout needs payment review.", code: "PAYMENT_OPERATION_REQUIRES_REVIEW" });
        }
        return res.json({
          ok: true,
          alreadySettled: true,
          transferId: storedSettlement.transferId || null,
          payout: Number(storedSettlement.payoutAmount || 0),
          refundId: storedSettlement.refundId || null,
          refundAmount: Number(storedSettlement.refundAmount || 0),
        });
      }
      return res.status(409).json({ error: "This dispute has already been finalized." });
    }
    if (String(c.status || "").toLowerCase() !== "disputed") {
      return res.status(409).json({ error: "This matter does not have an active dispute." });
    }

    try { await reviewNotices.ready(); }
    catch (error) {
      runtimeLogger.warn("[payments] Review notice preparation unavailable", error?.message || error);
      return res.status(503).json({ error: "The decision could not be prepared. No settlement was submitted. Please try again.", code: "REVIEW_NOTICE_UNAVAILABLE" });
    }
    const statusKey = String(c.status || "").toLowerCase();
    const pausedReason = String(c.pausedReason || "");
    const hasActiveParalegal = !!(c.paralegal || c.paralegalId);
    const isWithdrawalDispute =
      c.withdrawnParalegalId &&
      !hasActiveParalegal &&
      (pausedReason === "dispute" || pausedReason === "paralegal_withdrew" || statusKey === "disputed");

    if (isWithdrawalDispute) {
      if (
        pausedReason === "paralegal_withdrew" &&
        c.disputeDeadlineAt &&
        statusKey !== "disputed" &&
        new Date().getTime() < new Date(c.disputeDeadlineAt).getTime()
      ) {
        return res.status(400).json({ error: "Awaiting the 24-hour dispute window before admin review." });
      }
      const resolvedAt = new Date();
      const baseAmount = Number(c.remainingAmount ?? c.lockedTotalAmount ?? c.totalAmount ?? 0);
      if (!Number.isFinite(baseAmount) || baseAmount < 0) {
        return res.status(400).json({ error: "Matter amount is invalid." });
      }
      let gross = 0;
      if (action === "refund") {
        gross = 0;
      } else if (action === "release_full") {
        gross = baseAmount;
      } else {
        const payoutTarget = payoutAmountCents ?? grossAmountCents;
        const payoutPlan = computeGrossFromDesiredPayout(payoutTarget, c, baseAmount);
        if (!payoutPlan) {
          return res.status(400).json({ error: "Payout amount is invalid." });
        }
        gross = payoutPlan.gross;
      }
      if (!Number.isFinite(gross) || gross < 0) {
        return res.status(400).json({ error: "Settlement amount is invalid." });
      }
      if (gross > baseAmount) {
        return res.status(400).json({ error: "Settlement amount exceeds remaining Matter funds." });
      }

      const payoutParalegal =
        c.withdrawnParalegalId && typeof c.withdrawnParalegalId === "object"
          ? c.withdrawnParalegalId
          : null;
      if (!payoutParalegal) {
        return res.status(400).json({ error: "Withdrawn paralegal not found." });
      }

      const { net, feePct, feeAmount } = computeParalegalFeeFromGross(gross, c);
      let transferId = null;
      let pending = false;
      if (gross > 0 && net > 0) {
        if (!c.escrowIntentId) return res.status(400).json({ error: "Not funded" });
        let pi;
        try {
          pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
        } catch (err) {
          runtimeLogger.error("[payments] withdrawal dispute intent lookup failed", err?.message || err);
          return res.status(502).json({ error: "Unable to verify Matter funding." });
        }
        const { transferable, charge } = stripe.isTransferablePaymentIntent(pi, { caseId: c._id });
        const fundingIntegrity = validatePaymentIntentForCase(pi, c);
        if (!transferable || !fundingIntegrity.valid) {
          return res.status(400).json({ error: "Stripe payment is not ready to release yet." });
        }

        const bypassPayouts = STRIPE_PAYOUT_BYPASS_EMAILS.has(normalizeEmail(payoutParalegal?.email));
        if (!payoutParalegal.stripeAccountId) {
          if (bypassPayouts) {
            await ensureConnectAccount(payoutParalegal);
          }
        }
        if (!payoutParalegal.stripeAccountId) {
          pending = true;
        } else if (!bypassPayouts) {
          if (!payoutParalegal.stripeOnboarded || !payoutParalegal.stripePayoutsEnabled) {
            const refreshed = await ensureStripeOnboarded(payoutParalegal);
            if (!refreshed) {
              pending = true;
            }
          }
        }

        if (pending) {
          return res.status(409).json({
            error: "The withdrawn paralegal must finish Stripe payout setup before this settlement can be finalized.",
            code: "PAYOUT_SETUP_REQUIRED",
          });
        }

        if (!pending) {
          settlementClaim = await claimSettlementOperation();
          const claimResponse = respondToSettlementClaim(settlementClaim);
          if (claimResponse) return claimResponse;
          let transfer;
          if (settlementClaim.operation.stripeTransferId) {
            transfer = { id: settlementClaim.operation.stripeTransferId };
          } else {
            try {
              const transferPayload = {
              amount: net,
              currency: c.currency || "usd",
              destination: payoutParalegal.stripeAccountId,
              transfer_group: `case_${c._id.toString()}`,
              metadata: {
                caseId: c._id.toString(),
                disputeId: String(targetDispute.disputeId || targetDispute._id || ""),
                action: "withdrawal_admin",
                operationKey: settlementClaim.operation.operationKey,
              },
            };
              if (charge?.id) {
                transferPayload.source_transaction = charge.id;
              }
              transfer = await createPayoutTransfer({
                caseId: c._id,
                stripeClient: stripe,
                payload: transferPayload,
                operation: settlementClaim.operation,
                stripeMode: pickStripeMode(stripeModeFromLivemode(pi.livemode), c.stripeMode, currentStripeMode()),
                onTransfer: known => { transfer = known; },
                stripeOptions: {
                  idempotencyKey: stripe.stripeIdempotencyKey(
                    "withdrawal_admin_payout",
                    c._id,
                    targetDispute.disputeId || targetDispute._id,
                    net,
                    c.escrowIntentId
                  ),
                },
                bypassTransfer: bypassPayouts ? { id: `bypass_${c._id}_${disputeKey}` } : null,
              });
            } catch (err) {
              await failPaymentOperation(settlementClaim.operation, err, { needsReconciliation: Boolean(transfer?.id || err?.payoutTransferAttempted), stripeObjectId: transfer?.id || "" }).catch(
                logPromiseFailure(runtimeLogger, "[payments] failed withdrawal dispute operation could not be marked", {
                  caseId: c._id,
                })
              );
              runtimeLogger.error("[payments] withdrawal dispute payout transfer failed", err?.message || err);
              const message = stripe.sanitizeStripeError(
                err,
                transfer?.id || err?.payoutTransferAttempted ? "This payout needs payment review before another release can be requested." : "We couldn't release the payment right now. Please try again shortly."
              );
              return res.status(400).json({ error: message });
            }
          }
          transferId = transfer?.id || null;
          await recordPaymentOperationEvidence(settlementClaim.operation, {
            transferId,
            transferAmount: net,
          });
        }
      }
      if (!settlementClaim) {
        settlementClaim = await claimSettlementOperation();
        const claimResponse = respondToSettlementClaim(settlementClaim);
        if (claimResponse) return claimResponse;
      }

      c.partialPayoutAmount = gross;
      c.payoutFinalizedType = "admin";
      c.payoutFinalizedAt = resolvedAt;
      if (transferId) {
        c.payoutTransferId = transferId;
        c.payoutStatus = "paid";
        c.payoutFailureReason = "";
        c.paidOutAt = resolvedAt;
      }
      c.disputeDeadlineAt = null;
      c.adminDisputeDeadlineAt = null;
      c.adminDisputeOverdueNotifiedAt = null;
      c.relistRequestedAt = c.relistRequestedAt || resolvedAt || new Date();
      c.relistPending = false;
      c.remainingAmount = Math.max(0, Math.round(baseAmount - gross));
      c.pausedReason = "paralegal_withdrew";
      targetDispute.status = "resolved";
      c.disputeSettlement = {
        action,
        grossAmount: gross,
        feeAttorneyAmount: 0,
        feeParalegalAmount: feeAmount,
        feeAttorneyPct: 0,
        feeParalegalPct: feePct,
        payoutAmount: net,
        refundAmount: 0,
        refundId: "",
        transferId: transferId || "",
        resolvedAt,
        disputeId: disputeKey,
      };
      c.ensureLifecycleStatus("paused");
      try {
        await withPayoutTransaction(async session => {
          if (transferId) {
            const paralegalObjectId = payoutParalegal._id || c.withdrawnParalegalId;
            const attorneyObjectId = c.attorney?._id || c.attorneyId || c.attorney;
            const stripeMode = pickStripeMode(c.stripeMode, currentStripeMode());
            await upsertPayoutLedger({
              operationKey,
              caseId: c._id,
              paralegalId: paralegalObjectId,
              amountPaid: net,
              transferId,
              stripeMode,
            }, { session });
            await upsertPlatformIncomeLedger({
              operationKey,
              caseId: c._id,
              attorneyId: attorneyObjectId,
              paralegalId: paralegalObjectId,
              feeAmount,
              stripeMode,
            }, { session });
          }
          await c.save({ session });
          if (settlementClaim?.operation) {
            await succeedPaymentOperation(
              settlementClaim.operation,
              transferId || `no_transfer_${c._id}_${disputeKey}`,
              { session }
            );
          }
          await AuditLog.create([{ actor: req.user?.id || req.user?._id, actorRole: req.user?.role || "system", action: "dispute.withdrawal.settle", targetType: "payment", targetId: String(c._id), case: c._id, ip: req.ip, ua: req.headers["user-agent"], method: req.method, path: req.originalUrl, meta: { grossAmount: gross, netAmount: net, feePct, feeAmount, transferId, pending } }], { session });
          resolutionDispatches = await reviewNotices.stageResolution(c, disputeKey, session, req.user.id);
        });
        publishCaseProjectionRefresh(c, "matter_payout_refresh", { discovery: true });
      } catch (err) {
        if (settlementClaim?.operation) {
          await failPaymentOperation(settlementClaim.operation, err, {
            needsReconciliation: Boolean(transferId),
            stripeObjectId: transferId || "",
          }).catch(logPromiseFailure(runtimeLogger, "[payments] settlement reconciliation operation marker failed", {
            caseId: c._id,
          }));
        }
        await Case.updateOne(
          { _id: c._id, payoutStatus: { $nin: ["failed", "reversed", "needs_reconciliation"] }, payoutFailureReason: { $in: ["", null] }, payoutTransferId: { $in: ["", null, transferId || ""] } },
          {
            $set: {
              payoutStatus: transferId ? "needs_reconciliation" : c.payoutStatus,
              payoutFailureReason: transferId
                ? "Stripe transfer succeeded but withdrawal settlement records did not finalize."
                : c.payoutFailureReason,
            },
          }
        ).catch(logPromiseFailure(runtimeLogger, "[payments] settlement reconciliation case marker failed", {
          caseId: c._id,
        }));
        return res.status(503).json({
          error: transferId ? "The financial action was recorded, but settlement records require reconciliation." : "The review decision was not recorded. No payment was submitted. Please try again.",
          code: transferId ? "PAYOUT_RECONCILIATION_REQUIRED" : "REVIEW_DECISION_UNAVAILABLE",
        });
      }

      try {
        const { attorneyPayload, paralegalPayload } = buildWithdrawalReceiptPayloads(c, gross);
        const attorneyKey = getWithdrawalReceiptKey(c._id, "attorney");
        const paralegalKey = getWithdrawalReceiptKey(
          c._id,
          "paralegal",
          payoutParalegal?._id || c.withdrawnParalegalId
        );
        const [attorneyPdf, paralegalPdf] = await Promise.all([
          buildReceiptPdfBuffer(attorneyPayload),
          buildReceiptPdfBuffer(paralegalPayload),
        ]);
        await Promise.all([
          uploadPdfToS3({ key: attorneyKey, buffer: attorneyPdf }),
          uploadPdfToS3({ key: paralegalKey, buffer: paralegalPdf }),
        ]);
      } catch (err) {
        runtimeLogger.warn("[payments] withdrawal receipt generation failed", err?.message || err);
      }

      for (const dispatch of resolutionDispatches) await dispatch();

      return res.json({ ok: true, payout: net, transferId, pending });
    }

    if (!hasActiveDispute(c) && !hasResolvedDispute(c)) {
      return res.status(400).json({ error: "Matter does not have an active dispute." });
    }

    const existingPayout = await Payout.findOne({
      caseId: c._id,
      paralegalId: c.paralegal?._id || c.paralegalId || c.paralegal,
    })
      .select("operationKey amountPaid transferId status")
      .sort({ createdAt: -1 })
      .lean();
    if (existingPayout && String(existingPayout.operationKey || "") !== operationKey) {
      return res.status(400).json({ error: "Payout already exists for this Matter." });
    }

    const baseAmount = Number(c.lockedTotalAmount ?? c.totalAmount ?? 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return res.status(400).json({ error: "Matter amount is invalid." });
    }

    const resolvedAt = new Date();

    if (action === "refund") {
      if (!c.escrowIntentId) {
        return res.status(400).json({ error: "Not funded" });
      }
      settlementClaim = await claimSettlementOperation();
      const claimResponse = respondToSettlementClaim(settlementClaim);
      if (claimResponse) return claimResponse;

      let refundOutcome;
      try { refundOutcome = await refundRequests.requestRefund({ operation: settlementClaim.operation, caseDoc: c, disputeId: disputeKey, action, stripe, req }); }
      catch (error) { return refundRequestError(res, settlementClaim.operation, error); }
      const { refund } = refundOutcome;

      if (c.payoutStatus === "needs_reconciliation" && !c.payoutTransferId && c.payoutFailureReason === "Stripe refund succeeded but the dispute settlement did not finalize.") {
        c.payoutStatus = "not_started";
        c.payoutFailureReason = "";
      }
      c.paymentReleased = false;
      c.paymentStatus = "refunded";
      c.escrowStatus = "refunded";
      targetDispute.status = "resolved";
      if (c.terminationDisputeId && String(c.terminationDisputeId) === disputeKey) {
        c.terminationStatus = "resolved";
      }
      c.disputeSettlement = {
        action,
        refundAmount: refund?.amount || 0,
        refundId: refund?.id || "",
        transferId: "",
        resolvedAt,
        disputeId: disputeKey,
      };
      c.pausedReason = null;
      c.disputeDeadlineAt = null;
      c.adminDisputeDeadlineAt = null;
      c.adminDisputeOverdueNotifiedAt = null;
      c.transitionTo("closed");
      try {
        await withPayoutTransaction(async session => {
          await refundRequests.guardCase(refundOutcome.source, session);
          const retained = await PaymentOperation.findOne({ _id: settlementClaim.operation._id, attempts: settlementClaim.operation.attempts, stripeRefundId: refund.id, evidenceStatus: { $ne: "quarantined" } }).session(session).lean();
          if (!retained) throw new Error("The refund operation changed before settlement.");
          await c.save({ session });
          await succeedPaymentOperation(settlementClaim.operation, refund.id, { session });
          await AuditLog.create([{ actor: req.user?.id || req.user?._id, actorRole: req.user?.role || "system", action: "dispute.settlement.refund", targetType: "payment", targetId: String(c._id), case: c._id, ip: req.ip, ua: req.headers["user-agent"], method: req.method, path: req.originalUrl, meta: { refundId: refund.id, refundAmount: refund.amount, disputeId: disputeKey, externalRef: c.escrowIntentId } }], { session });
          resolutionDispatches = await reviewNotices.stageResolution(c, disputeKey, session, req.user.id);
        });
      } catch (err) {
        await failPaymentOperation(settlementClaim.operation, err, {
          needsReconciliation: true,
          stripeObjectId: refund.id,
        }).catch(logPromiseFailure(runtimeLogger, "[payments] refund reconciliation operation marker failed", {
          caseId: c._id,
        }));
        await Case.updateOne(
          { _id: c._id, status: "disputed", payoutStatus: { $nin: ["failed", "reversed"] }, payoutTransferId: { $in: ["", null] } },
          {
            $set: {
              payoutStatus: "needs_reconciliation",
              payoutFailureReason: "Stripe refund succeeded but the dispute settlement did not finalize.",
            },
          }
        ).catch(logPromiseFailure(runtimeLogger, "[payments] refund reconciliation case marker failed", {
          caseId: c._id,
        }));
        return res.status(503).json({
          error: "The refund was issued, but settlement records require reconciliation.",
          code: "PAYOUT_RECONCILIATION_REQUIRED",
        });
      }

      await Promise.resolve().then(() => publishCaseProjectionRefresh(c, "matter_payout_refresh", { discovery: true })).catch(logPromiseFailure(runtimeLogger, "Refund settlement refresh failed."));


      for (const dispatch of resolutionDispatches) await dispatch();

      return res.json({ ok: true, refundId: refund.id, refundAmount: refund.amount || 0 });
    }

    if (!c.escrowIntentId) {
      return res.status(400).json({ error: "Not funded" });
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    } catch (err) {
      runtimeLogger.error("[payments] dispute intent lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to verify Matter funding." });
    }
    const { transferable, charge } = stripe.isTransferablePaymentIntent(pi, { caseId: c._id });
    const fundingIntegrity = validatePaymentIntentForCase(pi, c);
    if (!transferable || !fundingIntegrity.valid) {
      return res.status(400).json({ error: "Stripe payment is not ready to release yet." });
    }

    const bypassPayouts = STRIPE_PAYOUT_BYPASS_EMAILS.has(normalizeEmail(c.paralegal?.email));
    if (!c.paralegal || !c.paralegal.stripeAccountId) {
      if (bypassPayouts && c.paralegal) {
        await ensureConnectAccount(c.paralegal);
      }
    }
    if (!c.paralegal || !c.paralegal.stripeAccountId) {
      return res.status(400).json({ error: "Paralegal not onboarded for payouts" });
    }
    if (!bypassPayouts) {
      if (!c.paralegal.stripeOnboarded || !c.paralegal.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboarded(c.paralegal);
        if (!refreshed) {
          return res.status(400).json({ error: "Payment method needs to be updated before the payment can be released." });
        }
      }
    }

    const payoutPlan =
      action === "release_partial"
        ? computeGrossFromDesiredPayout(payoutAmountCents ?? grossAmountCents, c, baseAmount)
        : null;
    const settlementBase =
      action === "release_partial" ? Number(payoutPlan?.gross) : baseAmount;
    if (!Number.isFinite(settlementBase) || settlementBase <= 0) {
      return res.status(400).json({ error: "Settlement amount is invalid." });
    }
    if (settlementBase > baseAmount) {
      return res.status(400).json({ error: "Settlement amount exceeds Matter funding." });
    }

    const feeParalegalPct = resolveParalegalFeePct(c);
    const feeAttorneyPct = resolveAttorneyFeePct(c);
    const paralegalFee =
      action === "release_partial" && payoutPlan
        ? payoutPlan.feeAmount
        : Math.max(0, Math.round((settlementBase * feeParalegalPct) / 100));
    const attorneyFee = Math.max(0, Math.round((settlementBase * feeAttorneyPct) / 100));
    const payout =
      action === "release_partial" && payoutPlan
        ? payoutPlan.net
        : Math.max(0, settlementBase - paralegalFee);
    if (payout <= 0) {
      return res.status(400).json({ error: "Calculated payout must be positive." });
    }

    settlementClaim = await claimSettlementOperation();
    const claimResponse = respondToSettlementClaim(settlementClaim);
    if (claimResponse) return claimResponse;

    let refund = null, refundSource = null;
    const chargeAmount = Math.max(0, Number(charge?.amount ?? pi.amount_received ?? pi.amount ?? 0));
    const alreadyRefunded = Math.max(0, Number(charge?.amount_refunded || 0));
    let effectiveRefunded = alreadyRefunded;
    if (action === "release_partial") {
      const originalAttorneyFee = Math.max(0, Math.round((baseAmount * feeAttorneyPct) / 100));
      const desiredTotalRefund = Math.max(
        0,
        Math.min(chargeAmount, Math.round((baseAmount + originalAttorneyFee) - (settlementBase + attorneyFee)))
      );
      if (alreadyRefunded > desiredTotalRefund) {
        return res.status(400).json({
          error: "A previous partial refund already reduced the available charge amount. Enter a lower partial amount.",
        });
      }
      const refundAmount = Math.max(0, desiredTotalRefund - alreadyRefunded);
      if (refundAmount > 0 || settlementClaim.operation.stripeRefundId || await refundRequests.hasRefundRequest(settlementClaim.operation)) {
        try {
          const outcome = await refundRequests.requestRefund({ operation: settlementClaim.operation, caseDoc: c, disputeId: disputeKey, action, targetRefundTotal: desiredTotalRefund, stripe, req });
          refund = outcome.refund;
          refundSource = outcome.source;
          effectiveRefunded = outcome.targetRefundTotal;
        } catch (error) { return refundRequestError(res, settlementClaim.operation, error); }
      }
    }

    if (chargeAmount > 0) {
      const remainingSourceAmount = Math.max(0, chargeAmount - effectiveRefunded);
      if (payout > remainingSourceAmount) {
        return res.status(400).json({
          error: "The selected partial amount exceeds what remains available on the funded charge after refunds.",
        });
      }
    }

    let transfer;
    if (settlementClaim.operation.stripeTransferId) {
      transfer = { id: settlementClaim.operation.stripeTransferId };
    } else {
      try {
        const transferPayload = {
          amount: payout,
          currency: c.currency || "usd",
          destination: c.paralegal.stripeAccountId,
          transfer_group: `case_${c._id.toString()}`,
          metadata: {
            caseId: c._id.toString(),
            disputeId: disputeKey,
            action,
            operationKey: settlementClaim.operation.operationKey,
          },
        };
        if (charge?.id) {
          transferPayload.source_transaction = charge.id;
        }
        transfer = await createPayoutTransfer({
          caseId: c._id,
          stripeClient: stripe,
          payload: transferPayload,
          operation: settlementClaim.operation,
          stripeMode: pickStripeMode(stripeModeFromLivemode(pi.livemode), c.stripeMode, currentStripeMode()),
          onTransfer: known => { transfer = known; },
          stripeOptions: {
            idempotencyKey: stripe.stripeIdempotencyKey(
              "dispute_payout",
              c._id,
              disputeKey,
              action,
              payout,
              c.escrowIntentId
            ),
          },
          bypassTransfer: bypassPayouts ? { id: `bypass_${Date.now()}` } : null,
        });
      } catch (err) {
        await failPaymentOperation(settlementClaim.operation, err, {
          needsReconciliation: Boolean(refund?.id || transfer?.id || err?.payoutTransferAttempted),
          stripeObjectId: transfer?.id || "",
        }).catch(logPromiseFailure(runtimeLogger, "[payments] dispute payout reconciliation marker failed", {
          caseId: c._id,
        }));
        runtimeLogger.error("[payments] dispute payout transfer failed", err?.message || err);
        const message = stripe.sanitizeStripeError(
          err,
          transfer?.id || err?.payoutTransferAttempted ? "This payout needs payment review before another release can be requested." : "We couldn't release the payment right now. Please try again shortly."
        );
        return res.status(400).json({ error: message });
      }
    }

    await recordPaymentOperationEvidence(settlementClaim.operation, {
      transferId: transfer.id,
      transferAmount: payout,
    });

    c.paymentReleased = true;
    c.payoutTransferId = transfer.id;
    c.payoutStatus = "paid";
    c.payoutFailureReason = "";
    c.paidOutAt = resolvedAt;
    c.completedAt = c.completedAt || resolvedAt;
    targetDispute.status = "resolved";
    if (c.terminationDisputeId && String(c.terminationDisputeId) === disputeKey) {
      c.terminationStatus = "resolved";
    }
    if (!Number.isFinite(c.feeAttorneyPct)) c.feeAttorneyPct = feeAttorneyPct;
    if (!Number.isFinite(c.feeParalegalPct)) c.feeParalegalPct = feeParalegalPct;
    if (!Number.isFinite(c.feeAttorneyAmount)) c.feeAttorneyAmount = attorneyFee;
    if (!Number.isFinite(c.feeParalegalAmount)) c.feeParalegalAmount = paralegalFee;
    c.disputeSettlement = {
      action,
      grossAmount: settlementBase,
      feeAttorneyAmount: attorneyFee,
      feeParalegalAmount: paralegalFee,
      feeAttorneyPct,
      feeParalegalPct,
      payoutAmount: payout,
      refundAmount: refund?.amount || 0,
      refundId: refund?.id || settlementClaim.operation?.stripeRefundId || "",
      transferId: transfer.id,
      resolvedAt,
      disputeId: disputeKey,
    };
    c.pausedReason = null;
    c.disputeDeadlineAt = null;
    c.adminDisputeDeadlineAt = null;
    c.adminDisputeOverdueNotifiedAt = null;
    c.stripeMode = pickStripeMode(c.stripeMode, currentStripeMode());
    c.transitionTo("closed");
    try {
      const paralegalObjectId = c.paralegal?._id || c.paralegalId || c.paralegal;
      const attorneyObjectId = c.attorney?._id || c.attorneyId || c.attorney;
      const stripeMode = pickStripeMode(c.stripeMode, currentStripeMode());
      await withPayoutTransaction(async session => {
        if (refundSource) await refundRequests.guardCase(refundSource, session);
        await upsertPayoutLedger({
          operationKey,
          caseId: c._id,
          paralegalId: paralegalObjectId,
          amountPaid: payout,
          transferId: transfer.id,
          stripeMode,
        }, { session });
        await upsertPlatformIncomeLedger({
          operationKey,
          caseId: c._id,
          attorneyId: attorneyObjectId,
          paralegalId: paralegalObjectId,
          feeAmount: Math.max(0, attorneyFee + paralegalFee),
          stripeMode,
        }, { session });
        await c.save({ session });
        await succeedPaymentOperation(settlementClaim.operation, transfer.id, { session });
        await AuditLog.create([{ actor: req.user?.id || req.user?._id, actorRole: req.user?.role || "system", action: "dispute.settlement.release", targetType: "payment", targetId: String(c._id), case: c._id, ip: req.ip, ua: req.headers["user-agent"], method: req.method, path: req.originalUrl, meta: { action, payout, feeA: attorneyFee, feeP: paralegalFee, refundId: refund?.id || null, disputeId: disputeKey, externalRef: transfer.id } }], { session });
        resolutionDispatches = await reviewNotices.stageResolution(c, disputeKey, session, req.user.id);
      });
      publishCaseProjectionRefresh(c, "matter_payout_refresh", { discovery: true });
    } catch (err) {
      await failPaymentOperation(settlementClaim.operation, err, {
        needsReconciliation: true,
        stripeObjectId: transfer.id,
      }).catch(logPromiseFailure(runtimeLogger, "[payments] final settlement reconciliation operation marker failed", {
        caseId: c._id,
      }));
      await Case.updateOne(
        { _id: c._id, payoutStatus: { $nin: ["failed", "reversed", "needs_reconciliation"] }, payoutFailureReason: { $in: ["", null] }, payoutTransferId: { $in: ["", null, transfer.id] } },
        {
          $set: {
            payoutTransferId: transfer.id,
            payoutStatus: "needs_reconciliation",
            payoutFailureReason: "Stripe settlement succeeded but local settlement records did not finalize.",
          },
        }
      ).catch(logPromiseFailure(runtimeLogger, "[payments] final settlement reconciliation case marker failed", {
        caseId: c._id,
      }));
      return res.status(503).json({
        error: "The financial action was recorded, but settlement records require reconciliation.",
        code: "PAYOUT_RECONCILIATION_REQUIRED",
      });
    }

    for (const dispatch of resolutionDispatches) await dispatch();

    res.json({
      ok: true,
      transferId: transfer.id,
      payout,
      refundId: refund?.id || null,
      refundAmount: refund?.amount || 0,
    });
  })
);

router.get(
  "/summary",
  requireRole("attorney"),
  async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json(await getAttorneyPaymentSummary(req.user.id, { req })); }
    catch (error) { res.status(error.status || 503).json({ code: error.publicCode || 'PAYMENT_SUMMARY_UNAVAILABLE', error: 'Payment amounts could not be verified. Refresh Payments before continuing.' }); }
  }
);

router.get("/attorney-records", requireRole("attorney"), async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await require("../services/attorneyPaymentRecords").read(req)); }
  catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "WORKSPACE_PAYMENT_UNAVAILABLE", error: "Payment records could not be verified. Refresh Payments before continuing." }); }
});
async function sendFinancialHistory(req, res) {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await require("../services/attorneyFinancialHistory").read(req)); }
  catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "FINANCIAL_HISTORY_UNAVAILABLE", error: "Financial records could not be verified. Refresh the payment history before continuing." }); }
}
async function sendFinancialCsv(req, res) {
  res.set("Cache-Control", "private, no-store");
  try {
    const history = require("../services/attorneyFinancialHistory"), value = await history.read(req, { exportAll: true });
    const csv = history.csv(value);
    if (Buffer.byteLength(csv, "utf8") > 32 * 1024 * 1024) return res.status(413).json({ code: "FINANCIAL_HISTORY_TOO_LARGE", error: "The CSV exceeds the review limit. Choose one Matter or contact LPC support." });
    res.set("Content-Type", "text/csv; charset=utf-8"); res.set("X-Content-Type-Options", "nosniff"); res.set("Content-Disposition", 'attachment; filename="LPC-payment-history.csv"'); res.send(csv);
  } catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "FINANCIAL_HISTORY_UNAVAILABLE", error: "The CSV could not be verified. Refresh the payment history before downloading it." }); }
}
router.get("/attorney-financial-history", requireRole("attorney"), sendFinancialHistory);
router.get("/attorney-financial-history/csv", requireRole("attorney"), sendFinancialCsv);
router.post("/portal/attorney", requireRole("attorney"), csrfProtection, async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await require("../services/attorneyPaymentPortal").create(req, { stripe, clientBase: resolveClientBase(req) })); }
  catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "PAYMENT_SETUP_PORTAL_UNAVAILABLE", error: "Billing could not be opened. Check the saved card and try again." }); }
});

const paymentList = view => async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { res.json(await require("../services/attorneyPaymentSummary").list(req, view)); }
    catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "PAYMENT_SUMMARY_UNAVAILABLE", error: "Payment amounts could not be verified. Refresh Payments before continuing." }); }
};
router.get('/escrow/active', requireRole('attorney'), paymentList('active'));
router.get('/escrow/pending', requireRole('attorney'), paymentList('pending'));

router.use("/receipt/attorney", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
router.get("/receipt/attorney/:caseId/history", requireRole("attorney"), async (req, res) => {
  try { res.json(await attorneyReceipts.readHistory(req)); }
  catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "RECEIPT_UNAVAILABLE", error: "Receipt history could not be verified. Refresh the receipts before continuing." }); }
});
const attorneyReceiptOperation = download => async (req, res) => {
  const controller = new AbortController();
  req.receiptSignal = controller.signal;
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try {
    if (req.query.revision !== undefined && !/^[a-f0-9]{64}$/.test(req.query.revision)) return res.status(400).json({ code: "RECEIPT_INVALID", error: "Open the receipt again before downloading." });
    const value = await attorneyReceipts.read(req, { stripe, requireExpectedOwner: !download });
    if (!download) return res.json(value);
    if (!value.receipt) return res.status(409).json({ code: "RECEIPT_NOT_READY", reason: value.reason, error: "A receipt is not available for this payment state." });
    if (req.query.revision !== undefined && req.query.revision !== value.revision) return res.status(409).json({ code: "RECEIPT_CHANGED", error: "The receipt details changed. Open the receipt again before downloading." });
    // Generate from the verified current evidence; historical cached PDFs can carry stale paid/refund labels.
    const pdf = await buildReceiptPdfBuffer(attorneyReceipts.payload(value));
    const current = await attorneyReceipts.read(req, { stripe, requireExpectedOwner: false });
    if (current.revision !== value.revision) return res.status(409).json({ code: "RECEIPT_CHANGED", error: "The payment details changed while the receipt was being prepared. Open it again before downloading." });
    if (controller.signal.aborted || res.destroyed) return;
    if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Receipt renderer returned an invalid document");
    res.set("Content-Type", "application/pdf");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", `attachment; filename="receipt.pdf"; filename*=UTF-8''${encodeURIComponent(value.receipt.filename.toWellFormed()).replace(/'/g, "%27")}`);
    return res.send(pdf);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (error.publicCode) return res.status(error.status).json({ code: error.publicCode, error: error.message });
    runtimeLogger.error("[payments] attorney receipt unavailable", { caseId: req.params.caseId, error });
    return res.status(503).json({ code: "RECEIPT_UNAVAILABLE", error: "The receipt could not be prepared. Try opening it again." });
  } finally { res.removeListener("close", cancel); }
};
router.get("/receipt/attorney/:caseId/review", requireRole("attorney"), attorneyReceiptOperation(false));
router.get("/receipt/attorney/:caseId", requireRole("attorney"), attorneyReceiptOperation(true));

router.get("/receipt/paralegal/:caseId", requireRole("paralegal"), async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  const controller = new AbortController(), cancel = () => controller.abort(); res.once("close", cancel);
  try {
    const receipts = require("../services/paralegalPayoutReceipt"), value = await receipts.read(req);
    if (req.query.revision !== undefined && req.query.revision !== value.revision) return res.status(409).json({ code: "PAYOUT_RECEIPT_CHANGED", error: "Payout details changed. Open the receipt again." });
    if (controller.signal.aborted || res.destroyed) return;
    const pdf = await buildReceiptPdfBuffer(value.payload), current = await receipts.read(req);
    if (current.revision !== value.revision) return res.status(409).json({ code: "PAYOUT_RECEIPT_CHANGED", error: "Payout details changed while the receipt was being prepared. Open it again." });
    if (controller.signal.aborted || res.destroyed) return;
    if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Receipt renderer returned an invalid document");
    res.set("Content-Type", "application/pdf"); res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", `attachment; filename="receipt.pdf"; filename*=UTF-8''${encodeURIComponent(value.filename.toWellFormed()).replace(/'/g, "%27")}`);
    return res.send(pdf);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (error.publicCode) return res.status(error.status || 409).json({ code: error.publicCode, error: error.message });
    runtimeLogger.error("[payments] paralegal receipt unavailable", { caseId: req.params.caseId, error });
    return res.status(503).json({ code: "PAYOUT_RECEIPT_UNAVAILABLE", error: "The receipt could not be prepared. Try opening it again." });
  } finally { res.removeListener("close", cancel); }
});

// Compatibility paths use the same reviewed owner, inventory, filters and bytes.
router.get("/history", requireRole("attorney"), sendFinancialHistory);
router.get("/export/csv", requireRole("attorney"), sendFinancialCsv);

// ----------------------------------------
// Admin Receipts Index
// ----------------------------------------
router.get("/receipts", requireRole("admin"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await require("../services/adminReceiptIndex").read(req)); }
  catch (error) {
    if (error.publicCode) return res.status(error.status || 409).json({ code: error.publicCode, error: error.message });
    throw error;
  }
}));

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  runtimeLogger.error(err);
  res.status(500).json({ error: "Server error" });
});

module.exports = router;
