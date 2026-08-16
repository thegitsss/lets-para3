const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:payments");
// backend/routes/payments.js
const router = require("express").Router();
const mongoose = require("mongoose");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const { createS3Client } = require("../utils/s3Client");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const stripe = require("../utils/stripe");
const Case = require("../models/Case");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const Payout = require("../models/Payout");
const PaymentOperation = require("../models/PaymentOperation");
const { buildReceiptPdfBuffer, uploadPdfToS3, getReceiptKey } = require("../services/caseLifecycle");
const { notifyUser } = require("../utils/notifyUser");
const { currentStripeMode, pickStripeMode, stripeModeFromLivemode } = require("../utils/stripeMode");
const {
  MIN_MATTER_AMOUNT_CENTS,
} = require("../services/attorneyWorkflowPolicy");
const {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
} = require("../services/platformFeePolicy");
const { createDevOnlyEmailSet } = require("../utils/devOnlyEmailSet");
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
} = require("../services/paymentLedgerService");
const { buildCheckoutReturnUrl } = require("../services/paymentReturnUrl");
const { buildFundingFingerprint, ensureFundingRequestKey } = require("../utils/funding");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
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
const STRIPE_CONNECT_BYPASS_EMAILS = createDevOnlyEmailSet([
  "samanthasider+11@gmail.com",
  "samanthasider+56@gmail.com",
  "support.cr.e2e.paralegal@lets-paraconnect.dev",
]);
const MIN_CASE_AMOUNT_CENTS = MIN_MATTER_AMOUNT_CENTS;
const MIN_CASE_AMOUNT_MESSAGE = "Amount must be at least $400.";

function trimSlash(value) {
  if (!value) return "";
  return String(value).replace(/\/$/, "");
}

function normalizeEmail(value) {
  return String(value || "").toLowerCase().trim();
}

function isRefundAlreadyProcessed(err) {
  const code = err?.code || err?.raw?.code || err?.rawType || "";
  return (
    code === "charge_already_refunded" ||
    code === "payment_intent_already_refunded" ||
    code === "charge_refunded"
  );
}


function resolveAttorneyId(caseDoc) {
  const attorney = caseDoc?.attorney;
  if (attorney && typeof attorney === "object" && attorney._id) {
    return String(attorney._id);
  }
  if (caseDoc?.attorneyId) return String(caseDoc.attorneyId);
  if (attorney) return String(attorney);
  return "";
}

async function resolveFundingIdempotencyKey(caseDoc, amount, { mode, forceNew = false } = {}) {
  const fingerprint = buildFundingFingerprint({
    caseId: caseDoc?._id,
    amount,
    currency: caseDoc?.currency || "usd",
    mode,
  });
  return ensureFundingRequestKey(caseDoc?._id, fingerprint, { forceNew });
}

function buildDisputeReceiptPayloads({
  caseDoc,
  disputeId,
  action,
  payoutAmount = 0,
  refundAmount = 0,
}) {
  const caseTitle = caseDoc?.title || "Untitled Matter";
  const resolutionLabel =
    action === "refund" ? "Refund" : action === "release_partial" ? "Partial release" : "Full release";
  const basePayload = {
    title: "Review resolved",
    caseId: String(caseDoc?._id || ""),
    disputeId: String(disputeId || ""),
    resolution: action,
    resolutionLabel,
    caseTitle,
    refundAmount: refundAmount > 0 ? formatCurrency(refundAmount) : "",
    payoutAmount: payoutAmount > 0 ? formatCurrency(payoutAmount) : "",
  };

  const attorneyMessage =
    action === "refund"
      ? `The review for ${caseTitle} was resolved with a refund issued to you.`
      : action === "release_partial"
      ? `The review for ${caseTitle} was resolved with a partial release.`
      : `The review for ${caseTitle} was resolved with the payout released to the paralegal.`;

  const paralegalMessage =
    action === "refund"
      ? `The review for ${caseTitle} was resolved. No payout will be issued.`
      : action === "release_partial"
      ? `The review for ${caseTitle} was resolved with a partial payout.`
      : `The review for ${caseTitle} was resolved and your payout was released.`;

  const attorneyReceiptNote =
    "A receipt is available in your dashboard with refund and platform fee details.";
  const paralegalReceiptNote =
    "A receipt is available in your dashboard with payout, refund, and platform fee details.";

  return {
    attorneyPayload: {
      ...basePayload,
      message: attorneyMessage,
      receiptNote: attorneyReceiptNote,
      link: "dashboard-attorney.html#funds",
    },
    paralegalPayload: {
      ...basePayload,
      message: paralegalMessage,
      receiptNote: paralegalReceiptNote,
      link: "dashboard-paralegal.html#cases-completed",
    },
  };
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
const { Types } = mongoose;

const PLATFORM_FEE_ATTORNEY_PERCENT = DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
const PLATFORM_FEE_PARALEGAL_PERCENT = DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;
const MAX_HISTORY_ROWS = Number(process.env.BILLING_HISTORY_LIMIT || 500);
const MAX_EXPORT_ROWS = Number(process.env.BILLING_EXPORT_LIMIT || 2000);

const CLIENT_BASE_URL = trimSlash(process.env.CLIENT_BASE_URL || process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL);
const CHECKOUT_SUCCESS_URL = (process.env.STRIPE_CHECKOUT_SUCCESS_URL || "").trim();
const CHECKOUT_CANCEL_URL = (process.env.STRIPE_CHECKOUT_CANCEL_URL || "").trim();

const S3_BUCKET = process.env.S3_BUCKET || "";
const s3 = createS3Client();

function buildAttorneyMatch(userId) {
  if (!userId) return {};
  const clauses = [{ attorney: userId }, { attorneyId: userId }];
  if (mongoose.isValidObjectId(userId)) {
    const oid = new Types.ObjectId(userId);
    clauses.push({ attorney: oid }, { attorneyId: oid });
  }
  return { $or: clauses };
}

function cents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

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

function calculateAttorneyFee(baseAmount, pct = PLATFORM_FEE_ATTORNEY_PERCENT) {
  return Math.max(0, Math.round(cents(baseAmount) * ((Number(pct) || 0) / 100)));
}

function calculateParalegalFee(baseAmount, pct = PLATFORM_FEE_PARALEGAL_PERCENT) {
  return Math.max(0, Math.round(cents(baseAmount) * ((Number(pct) || 0) / 100)));
}

function computePlatformFee(doc = {}) {
  const pct = resolveAttorneyFeePct(doc);
  const base = doc.lockedTotalAmount ?? doc.totalAmount;
  const snap = cents(doc.feeAttorneyAmount);
  if (snap > 0 || cents(base) <= 0) return snap;
  return calculateAttorneyFee(base, pct);
}

function computeParalegalFee(doc = {}) {
  const pct = resolveParalegalFeePct(doc);
  const base = doc.lockedTotalAmount ?? doc.totalAmount;
  const snap = cents(doc.feeParalegalAmount);
  if (snap > 0 || cents(base) <= 0) return snap;
  return calculateParalegalFee(base, pct);
}

function syncPlatformFeeSnapshots(doc = {}, { baseAmount } = {}) {
  const base = cents(
    typeof baseAmount !== "undefined" ? baseAmount : doc.lockedTotalAmount ?? doc.totalAmount
  );
  const attorneyPct = resolveAttorneyFeePct(doc);
  const paralegalPct = resolveParalegalFeePct(doc);
  doc.feeAttorneyPct = attorneyPct;
  doc.feeParalegalPct = paralegalPct;
  doc.feeAttorneyAmount = calculateAttorneyFee(base, attorneyPct);
  doc.feeParalegalAmount = calculateParalegalFee(base, paralegalPct);
  return {
    baseAmount: base,
    attorneyPct,
    paralegalPct,
    attorneyFee: doc.feeAttorneyAmount,
    paralegalFee: doc.feeParalegalAmount,
  };
}

function resolveDisputeSettlement(doc = {}) {
  const settlement = doc.disputeSettlement || {};
  const action = String(settlement.action || "");
  if (!["release_full", "release_partial"].includes(action)) return null;
  const grossAmount = cents(settlement.grossAmount);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) return null;
  const feeAttorneyPct = Number.isFinite(settlement.feeAttorneyPct)
    ? settlement.feeAttorneyPct
    : resolveAttorneyFeePct(doc);
  const feeParalegalPct = Number.isFinite(settlement.feeParalegalPct)
    ? settlement.feeParalegalPct
    : resolveParalegalFeePct(doc);
  const feeAttorneySnapshot = cents(settlement.feeAttorneyAmount);
  const feeParalegalSnapshot = cents(settlement.feeParalegalAmount);
  const feeAttorneyAmount =
    feeAttorneySnapshot > 0 || grossAmount <= 0
      ? feeAttorneySnapshot
      : calculateAttorneyFee(grossAmount, feeAttorneyPct);
  const feeParalegalAmount =
    feeParalegalSnapshot > 0 || grossAmount <= 0
      ? feeParalegalSnapshot
      : calculateParalegalFee(grossAmount, feeParalegalPct);
  const payoutAmount = Number.isFinite(settlement.payoutAmount)
    ? cents(settlement.payoutAmount)
    : Math.max(0, grossAmount - feeParalegalAmount);
  return {
    grossAmount,
    feeAttorneyAmount,
    feeParalegalAmount,
    feeAttorneyPct,
    feeParalegalPct,
    payoutAmount,
  };
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

function pickLimit(rawValue, fallback = 200, max = 1000) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
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

function buildReturnUrl(req, type, caseId) {
  const specific = type === "success" ? CHECKOUT_SUCCESS_URL : CHECKOUT_CANCEL_URL;
  return buildCheckoutReturnUrl({
    configuredUrl: specific,
    clientBase: resolveClientBase(req),
    state: type === "success" ? "success" : "cancel",
    caseId,
  });
}

function fullName(person = {}) {
  return [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
}

function resolveCaseName(doc = {}) {
  return (
    doc.title ||
    doc.caseTitle ||
    doc.jobTitle ||
    (doc.jobId && typeof doc.jobId === "object" && doc.jobId.title) ||
    `Matter ${doc._id || doc.caseId || ""}`.trim() ||
    "Matter"
  );
}

function resolveJobTitle(doc = {}) {
  return (
    doc.jobTitle ||
    (doc.jobId && typeof doc.jobId === "object" && doc.jobId.title) ||
    doc.title ||
    doc.caseTitle ||
    "Matter posting"
  );
}

function buildCaseLink(caseDoc) {
  const id = caseDoc?._id || caseDoc?.id;
  return id ? `case-detail.html?caseId=${encodeURIComponent(id)}` : "";
}

async function applyPaymentIntentSnapshot(caseDoc, paymentIntent, { notifyOnSuccess = false } = {}) {
  if (!caseDoc || !paymentIntent) return { updated: false };
  const wasFunded = String(caseDoc.escrowStatus || "").toLowerCase() === "funded";
  const hasParalegal = !!(caseDoc.paralegal || caseDoc.paralegalId);
  const piStatus = paymentIntent.status || "";
  const stripeMode = pickStripeMode(
    stripeModeFromLivemode(paymentIntent?.livemode),
    caseDoc.stripeMode,
    currentStripeMode()
  );
  const { transferable } = stripe.isTransferablePaymentIntent(paymentIntent, { caseId: caseDoc._id });
  const integrity = validatePaymentIntentForCase(paymentIntent, caseDoc);

  if (!integrity.valid) {
    caseDoc.fundingIntegrityStatus = "failed";
    caseDoc.fundingIntegrityFailure = integrity.reasons.join(",");
    if (!wasFunded) caseDoc.paymentStatus = "verification_failed";
    await caseDoc.save();
    return {
      updated: true,
      fundingVerified: false,
      reasons: integrity.reasons,
      paymentStatus: caseDoc.paymentStatus,
      escrowStatus: caseDoc.escrowStatus,
      status: caseDoc.status,
    };
  }

  if (!caseDoc.paymentIntentId) caseDoc.paymentIntentId = paymentIntent.id;
  if (!caseDoc.escrowIntentId) caseDoc.escrowIntentId = paymentIntent.id;
  if (!caseDoc.currency) caseDoc.currency = paymentIntent.currency || caseDoc.currency || "usd";
  caseDoc.stripeMode = stripeMode;
  if (caseDoc.lockedTotalAmount == null && (!caseDoc.totalAmount || caseDoc.totalAmount <= 0) && Number.isFinite(paymentIntent.amount)) {
    caseDoc.totalAmount = paymentIntent.amount;
  }
  if (caseDoc.lockedTotalAmount == null && caseDoc.totalAmount) {
    caseDoc.lockedTotalAmount = caseDoc.totalAmount;
  }
  caseDoc.paymentStatus = piStatus || caseDoc.paymentStatus || "pending";
  syncPlatformFeeSnapshots(caseDoc);

  if (piStatus === "succeeded" && transferable) {
    caseDoc.fundingIntegrityStatus = "verified";
    caseDoc.fundingIntegrityFailure = "";
    caseDoc.fundingVerifiedAt = new Date();
    caseDoc.escrowStatus = "funded";
    const status = String(caseDoc.status || "").toLowerCase();
    if (hasParalegal && ["awaiting_funding", "assigned", "open"].includes(status)) {
      caseDoc.hiredAt = caseDoc.hiredAt || new Date();
      caseDoc.transitionTo("in progress");
    }
  } else if (!wasFunded) {
    if (!caseDoc.escrowStatus) caseDoc.escrowStatus = "awaiting_funding";
  }

  await caseDoc.save();

  if (!wasFunded && piStatus === "succeeded" && transferable && hasParalegal && notifyOnSuccess) {
    const paralegalId = caseDoc.paralegal?._id || caseDoc.paralegalId || caseDoc.paralegal;
    if (paralegalId) {
      try {
        await notifyUser(paralegalId, "case_work_ready", {
          caseId: caseDoc._id,
          caseTitle: caseDoc.title || "Untitled Matter",
          link: buildCaseLink(caseDoc),
        });
      } catch (err) {
        runtimeLogger.warn("[payments] notifyUser case_work_ready failed", err?.message || err);
      }
    }
  }

  return {
    updated: true,
    fundingVerified: piStatus === "succeeded" && transferable,
    paymentStatus: caseDoc.paymentStatus,
    escrowStatus: caseDoc.escrowStatus,
    status: caseDoc.status,
  };
}

function resolveParalegalDoc(source = {}) {
  const candidate = source.paralegal && typeof source.paralegal === "object" ? source.paralegal : null;
  if (candidate && (candidate.firstName || candidate.lastName)) return candidate;
  const fallback =
    source.chosenParalegal && typeof source.chosenParalegal === "object" ? source.chosenParalegal : null;
  if (fallback && (fallback.firstName || fallback.lastName)) return fallback;
  const profile =
    source.paralegalProfile && typeof source.paralegalProfile === "object" ? source.paralegalProfile : null;
  if (profile && (profile.firstName || profile.lastName)) return profile;
  return null;
}

function resolveParalegalId(source = {}) {
  const entity =
    resolveParalegalDoc(source)?._id || source.paralegalId || source.paralegal || source.acceptedParalegal;
  return entity ? entity.toString() : "";
}

function resolveParalegalName(source = {}) {
  const entity = resolveParalegalDoc(source);
  if (entity) {
    const display = fullName(entity);
    if (display) return display;
  }
  return source.paralegalName || source.paralegalDisplayName || "";
}

function buildPaymentContext(doc = {}) {
  const caseId =
    (doc._id && doc._id.toString()) ||
    (doc.id && doc.id.toString && doc.id.toString()) ||
    (doc.caseId && doc.caseId.toString && doc.caseId.toString()) ||
    String(doc.caseId || "");
  const caseName = resolveCaseName(doc);
  const jobTitle = resolveJobTitle(doc);
  const paralegalName = resolveParalegalName(doc) || "Unassigned Paralegal";
  const paralegalId = resolveParalegalId(doc);
  return {
    metadata: {
      caseId,
      caseName,
      jobTitle,
      paralegalId,
      paralegalName,
    },
    description: `Matter: ${caseName} — Posting: ${jobTitle} — Paralegal: ${paralegalName}`,
  };
}

function extractReceipt(doc = {}) {
  if (doc.receiptUrl) return doc.receiptUrl;
  if (doc.receipt) return doc.receipt;
  if (Array.isArray(doc.downloadUrl) && doc.downloadUrl.length) {
    return doc.downloadUrl[0];
  }
  return "";
}

async function ensureCheckoutUrl(caseDoc, req) {
  const base = caseDoc.lockedTotalAmount ?? caseDoc.totalAmount;
  if (!caseDoc || !cents(base) || !stripe?.checkout?.sessions) return "";
  const context = buildPaymentContext(caseDoc);
  const attorneyPct = resolveAttorneyFeePct(caseDoc);
  const platformFee = Math.max(0, Math.round(cents(base) * (attorneyPct / 100)));
  const paymentMetadata = {
    ...context.metadata,
    attorneyId: req.user?.id ? String(req.user.id) : req.user?._id ? String(req.user._id) : "",
  };
  if (caseDoc.escrowSessionId) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(caseDoc.escrowSessionId);
      if (existing?.status === "open" && existing.url) return existing.url;
    } catch (err) {
      runtimeLogger.warn(`[payments] Unable to reuse checkout session for case ${caseDoc._id}:`, err.message);
    }
  }
  try {
    const successUrl = buildReturnUrl(req, "success", caseDoc._id);
    const cancelUrl = buildReturnUrl(req, "cancel", caseDoc._id);
    const checkoutIdempotencyKey = await resolveFundingIdempotencyKey(
      caseDoc,
      cents(base) + platformFee,
      { mode: "checkout" }
    );
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user?.email || undefined,
      client_reference_id: caseDoc._id.toString(),
      metadata: paymentMetadata,
      line_items: [
        {
          price_data: {
            currency: caseDoc.currency || "usd",
            product_data: {
              name: context.metadata.caseName || caseDoc.title || `Case ${caseDoc._id.toString()}`,
            },
            unit_amount: cents(base),
          },
          quantity: 1,
        },
        ...(platformFee
          ? [
              {
                price_data: {
                  currency: caseDoc.currency || "usd",
                  product_data: { name: `Platform fee (${attorneyPct}%)` },
                  unit_amount: platformFee,
                },
                quantity: 1,
              },
            ]
          : []),
      ],
      payment_intent_data: {
        transfer_group: `case_${caseDoc._id}`,
        metadata: paymentMetadata,
        description: context.description,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    }, { idempotencyKey: checkoutIdempotencyKey });
    caseDoc.escrowSessionId = session.id;
    await caseDoc.save();
    return session.url || "";
  } catch (err) {
    runtimeLogger.warn(`[payments] Unable to create checkout session for case ${caseDoc._id}:`, err.message);
    return "";
  }
}

function shapeHistoryRecord(doc) {
  const jobAmount = cents(doc.lockedTotalAmount ?? doc.totalAmount);
  const platformFee = computePlatformFee(doc);
  const paralegalDoc = resolveParalegalDoc(doc);
  const paralegal = paralegalDoc
    ? {
        id: paralegalDoc._id || paralegalDoc.id,
        firstName: paralegalDoc.firstName || "",
        lastName: paralegalDoc.lastName || "",
        email: paralegalDoc.email || "",
      }
    : null;
  const receiptUrl = extractReceipt(doc) || `/api/payments/receipt/attorney/${doc._id}`;
  const context = buildPaymentContext(doc);
  return {
    id: doc._id,
    caseId: doc._id,
    caseName: context.metadata.caseName,
    caseTitle: context.metadata.caseName,
    jobTitle: context.metadata.jobTitle,
    paralegalName: context.metadata.paralegalName,
    paralegalId: context.metadata.paralegalId,
    paralegal,
    jobAmount,
    amount: jobAmount,
    amountPaid: jobAmount,
    totalAmount: jobAmount,
    platformFee,
    totalCharged: jobAmount + platformFee,
    releaseDate: doc.paidOutAt || doc.completedAt || doc.updatedAt,
    paidOutAt: doc.paidOutAt || null,
    completedAt: doc.completedAt || null,
    description: context.description,
    metadata: context.metadata,
    receiptUrl,
    stripeReceiptUrl: receiptUrl,
    downloadUrl: Array.isArray(doc.downloadUrl) ? doc.downloadUrl : [],
    caseStatus: doc.status,
    createdAt: doc.createdAt,
  };
}

async function fetchCompletedCases(attorneyMatch, limit) {
  return Case.find({
    ...attorneyMatch,
    paymentReleased: true,
  })
    .populate("paralegal", "firstName lastName email role")
    .populate("jobId", "title practiceArea")
    .sort({ paidOutAt: -1, updatedAt: -1 })
    .limit(limit)
    .lean();
}

function summarizeHistory(records) {
  if (!records.length) {
    return { totalSpent: 0, averageJobCost: 0 };
  }
  const totals = records.reduce(
    (acc, rec) => {
      acc.jobs += rec.jobAmount;
      acc.fees += rec.platformFee;
      return acc;
    },
    { jobs: 0, fees: 0 }
  );
  return {
    totalSpent: totals.jobs + totals.fees,
    averageJobCost: Math.round(totals.jobs / records.length),
  };
}

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDollars(centsValue) {
  return (Number(centsValue || 0) / 100).toFixed(2);
}

function formatCurrency(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents) || cents <= 0) return "$0.00";
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function safeReceiptFilename(title, label) {
  const cleaned = String(title || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .trim();
  const base = cleaned || "receipt";
  const suffix = label ? `-${label}` : "";
  return `${base}${suffix}.pdf`.slice(0, 120);
}

async function resolvePaymentMethodLabel(caseDoc) {
  const intentId = caseDoc?.paymentIntentId || caseDoc?.escrowIntentId;
  if (!intentId || !stripe?.paymentIntents?.retrieve) return "Card on file";
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ["latest_charge", "payment_method"],
    });
    const charge = intent?.latest_charge && typeof intent.latest_charge === "object"
      ? intent.latest_charge
      : null;
    const card = charge?.payment_method_details?.card || intent?.payment_method?.card || null;
    if (card?.last4) {
      const brand = card?.brand ? String(card.brand).replace(/_/g, " ") : "Card";
      return `${brand} ending ${card.last4}`;
    }
  } catch (err) {
    runtimeLogger.warn("[payments] payment method lookup failed", err?.message || err);
  }
  return "Card on file";
}

function buildAttorneyReceiptPayload(caseDoc, paymentMethodLabel) {
  const settlement = resolveDisputeSettlement(caseDoc);
  const hasWithdrawalPayout =
    !!caseDoc?.payoutFinalizedAt &&
    !!caseDoc?.payoutFinalizedType &&
    Number.isFinite(Number(caseDoc?.remainingAmount));
  const baseAmount =
    settlement?.grossAmount ??
    Number(hasWithdrawalPayout ? caseDoc.remainingAmount : caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
  const platformFee = settlement?.feeAttorneyAmount ?? computePlatformFee(caseDoc);
  const attorneyPct = settlement?.feeAttorneyPct ?? resolveAttorneyFeePct(caseDoc);
  const attorneyName = fullName(caseDoc.attorney || {}) || caseDoc.attorneyNameSnapshot || "Attorney";
  const issuedAt = caseDoc.completedAt || caseDoc.paidOutAt || caseDoc.updatedAt || new Date();
  return {
    title: "Receipt",
    receiptId: caseDoc.paymentIntentId || caseDoc.escrowIntentId || String(caseDoc._id),
    issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
    partyLabel: "Billed to",
    partyName: attorneyName,
    caseTitle: caseDoc.title || "Untitled Matter",
    lineItems: [
      { label: "Matter amount", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${attorneyPct}%)`, value: formatCurrency(platformFee) },
    ],
    totalLabel: "Total paid",
    totalAmount: formatCurrency(baseAmount + platformFee),
    paymentMethod: paymentMethodLabel || "Card on file",
    paymentStatus: "Paid in full",
  };
}

function shouldRefreshAttorneyReceiptCache(caseDoc) {
  return cents(caseDoc?.feeAttorneyAmount) <= 0 && computePlatformFee(caseDoc) > 0;
}

function shouldRefreshParalegalReceiptCache(caseDoc) {
  return cents(caseDoc?.feeParalegalAmount) <= 0 && computeParalegalFee(caseDoc) > 0;
}

function buildParalegalReceiptPayload(caseDoc, payoutDoc) {
  const settlement = resolveDisputeSettlement(caseDoc);
  const hasWithdrawalPayout =
    !!caseDoc?.payoutFinalizedAt &&
    !!caseDoc?.payoutFinalizedType &&
    Number.isFinite(Number(caseDoc?.remainingAmount));
  const baseAmount =
    settlement?.grossAmount ??
    Number(hasWithdrawalPayout ? caseDoc.remainingAmount : caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
  const platformFee = settlement?.feeParalegalAmount ?? computeParalegalFee(caseDoc);
  const paralegalPct = settlement?.feeParalegalPct ?? resolveParalegalFeePct(caseDoc);
  const computedNet = settlement?.payoutAmount ?? Math.max(0, baseAmount - platformFee);
  const payoutAmount =
    Number.isFinite(payoutDoc?.amountPaid) && payoutDoc.amountPaid >= 0
      ? Math.min(payoutDoc.amountPaid, computedNet)
      : computedNet;
  const attorneyName = fullName(caseDoc.attorney || {}) || caseDoc.attorneyNameSnapshot || "Attorney";
  const paralegalName = fullName(caseDoc.paralegal || {}) || caseDoc.paralegalNameSnapshot || "Paralegal";
  const issuedAt = caseDoc.paidOutAt || caseDoc.completedAt || caseDoc.updatedAt || new Date();
  return {
    title: "Payout Receipt",
    receiptId: payoutDoc?.transferId || caseDoc.payoutTransferId || String(caseDoc._id),
    issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
    partyLabel: "Payee",
    partyName: paralegalName,
    attorneyName,
    caseTitle: caseDoc.title || "Untitled Matter",
    lineItems: [
      { label: "Gross amount", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${paralegalPct}%)`, value: formatCurrency(platformFee) },
    ],
    totalLabel: "Net paid",
    totalAmount: formatCurrency(payoutAmount),
    paymentMethod: "Stripe release",
    paymentStatus: "Paid",
  };
}

function computeParalegalFeeFromGross(grossCents, caseDoc) {
  const gross = Math.max(0, Math.round(Number(grossCents || 0)));
  const pct = resolveParalegalFeePct(caseDoc);
  const fee = Math.max(0, Math.round((gross * (Number(pct) || 0)) / 100));
  const net = Math.max(0, gross - fee);
  return { gross, feePct: pct, feeAmount: fee, net };
}

function computeGrossFromDesiredPayout(desiredNetCents, caseDoc, maxGrossCents) {
  const desiredNet = Math.max(0, Math.round(Number(desiredNetCents || 0)));
  const maxGross = Math.max(desiredNet, Math.round(Number(maxGrossCents || 0)));
  if (!Number.isFinite(desiredNet) || desiredNet <= 0) return null;
  for (let gross = desiredNet; gross <= maxGross; gross += 1) {
    const result = computeParalegalFeeFromGross(gross, caseDoc);
    if (result.net === desiredNet) return result;
  }
  return null;
}


function buildReceiptRow({
  receiptId,
  caseId,
  caseTitle,
  partyLabel,
  receiptType,
  amountCents,
  issuedAt,
}) {
  return {
    receiptId: String(receiptId || ""),
    caseId: String(caseId || ""),
    caseTitle: caseTitle || "Untitled Matter",
    party: partyLabel || "—",
    type: receiptType || "Receipt",
    amountCents: Number(amountCents) || 0,
    issuedAt: issuedAt ? new Date(issuedAt).toISOString() : null,
  };
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

async function tryStreamReceipt(res, key, filename) {
  if (!S3_BUCKET) return false;
  try {
    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    const data = await s3.send(cmd);
    if (!data?.Body) return false;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    data.Body.on("error", (err) => {
      runtimeLogger.error("[payments] receipt stream error", err);
      res.destroy(err);
    });
    data.Body.pipe(res);
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureStripeCustomer(user) {
  if (!user) throw new Error("User not found");
  if (user.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(user.stripeCustomerId);
      if (existing && !existing.deleted) return user.stripeCustomerId;
    } catch (err) {
      const code = err?.code || err?.raw?.code;
      if (code !== "resource_missing") {
        throw err;
      }
      runtimeLogger.warn("[payments] stripe customer missing; recreating", {
        userId: String(user._id || ""),
        stripeCustomerId: user.stripeCustomerId,
      });
    }
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
    { idempotencyKey: stripe.stripeIdempotencyKey("customer", user._id) }
  );
  user.stripeCustomerId = customer.id;
  await user.save();
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

async function fetchDefaultPaymentMethod(customerId) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  const defaultPmId = customer?.invoice_settings?.default_payment_method;
  if (!defaultPmId) return null;
  try {
    const pm = await stripe.paymentMethods.retrieve(defaultPmId);
    return summarizePaymentMethod(pm);
  } catch (err) {
    runtimeLogger.warn(`[payments] unable to retrieve default payment method ${defaultPmId}:`, err?.message || err);
    return null;
  }
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
    const user = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (STRIPE_APPROVAL_BYPASS_EMAILS.has(normalizeEmail(user.email))) {
      return res.json({
        customerId: null,
        hasDefault: true,
        paymentMethod: null,
        devBypass: true,
      });
    }
    if (!user.stripeCustomerId) {
      return res.json({
        customerId: null,
        hasDefault: false,
        paymentMethod: null,
      });
    }

    try {
      const customerId = user.stripeCustomerId;
      const paymentMethod = await fetchDefaultPaymentMethod(customerId);
      return res.json({
        customerId,
        hasDefault: !!paymentMethod,
        paymentMethod,
      });
    } catch (err) {
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
    const user = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      const customerId = await ensureStripeCustomer(user);
      const requestKey = String(req.get("Idempotency-Key") || req.get("X-Idempotency-Key") || "").trim();
      if (!/^[A-Za-z0-9._:-]{16,200}$/.test(requestKey)) {
        return res.status(400).json({
          error: "A valid Idempotency-Key header is required to start card setup.",
          code: "IDEMPOTENCY_KEY_REQUIRED",
        });
      }
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
        idempotencyKey: stripe.stripeIdempotencyKey("setup_intent", user._id, requestKey),
      });

      res.json({ clientSecret: intent.client_secret, intentId: intent.id, customerId });
    } catch (err) {
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
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) {
      return res.status(400).json({ error: "paymentMethodId is required" });
    }

    const user = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      const customerId = await ensureStripeCustomer(user);
      let pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (!pm || pm.type !== "card") {
        return res.status(400).json({ error: "Unsupported payment method type" });
      }

      const pmCustomerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
      if (!pmCustomerId) {
        pm = await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      } else if (pmCustomerId !== customerId) {
        return res.status(403).json({ error: "Payment method does not belong to this customer" });
      }

      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });

      res.json({ ok: true, customerId, paymentMethod: summarizePaymentMethod(pm) });
    } catch (err) {
      runtimeLogger.error("[payments] failed to set default payment method", err?.message || err);
      res.status(502).json({ error: "Unable to save payment method" });
    }
  })
);

/**
 * POST /api/payments/portal
 * Creates a Stripe Billing Portal session for the authenticated attorney.
 */
router.post(
  "/portal",
  requireRole("attorney"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("stripeCustomerId firstName lastName email");
    if (!user) return res.status(404).json({ error: "User not found" });
    let customerId = user.stripeCustomerId;
    try {
      customerId = await ensureStripeCustomer(user);
    } catch (err) {
      runtimeLogger.error("[payments] stripe customer lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to access Stripe customer. Please try again shortly." });
    }
    const returnUrl = `${resolveClientBase(req)}/dashboard-attorney.html#funds`;
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      if (!session?.url) {
        return res.status(502).json({ error: "Unable to create billing portal session." });
      }
      return res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
      runtimeLogger.error("[payments] billing portal create failed", err?.message || err);
      const raw = String(err?.message || "");
      const lowered = raw.toLowerCase();
      let message = "Unable to open the Stripe billing portal right now.";
      if (lowered.includes("portal") && (lowered.includes("enable") || lowered.includes("configuration"))) {
        message = "Stripe billing portal is not enabled for this account yet.";
      } else if (lowered.includes("no such customer") || lowered.includes("resource missing")) {
        message = "Stripe customer could not be found. Please try again shortly.";
      }
      return res.status(502).json({ error: message });
    }
  })
);

/**
 * POST /api/payments/start-escrow
 * Body: { caseId }
 * Ensures the attorney has hired a paralegal and initiates funding
 */
router.post(
  "/start-escrow",
  requireRole("attorney"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.body || {};
    if (!caseId || !isObjId(caseId)) {
      return res.status(400).json({ error: "Valid caseId is required" });
    }

    const selectedCase = await Case.findById(caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("paralegal", "firstName lastName email role")
      .populate("jobId", "title practiceArea");
    if (!selectedCase) return res.status(404).json({ error: "Matter not found" });

    const attorneyId =
      (selectedCase.attorney && selectedCase.attorney._id) ||
      selectedCase.attorneyId ||
      selectedCase.attorney;
    if (String(attorneyId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the Matter attorney can fund Matters" });
    }

    if (!selectedCase.paralegal) {
      return res.status(400).json({ error: "Hire a paralegal before funding the Matter" });
    }
    if (!selectedCase.attorney || !selectedCase.attorney.email) {
      return res.status(400).json({ error: "Attorney email is required to send the payment receipt" });
    }

    const amountToCharge = selectedCase.lockedTotalAmount;
    if (!amountToCharge || amountToCharge < 50) {
      return res.status(400).json({
        error: "Amount is not locked. Invite/accept/hire first.",
      });
    }

    const attorneyPct = resolveAttorneyFeePct(selectedCase);
    const platformFee = Math.max(0, Math.round(amountToCharge * (attorneyPct / 100)));
    const totalCharge = Math.round(amountToCharge + platformFee);
    const context = buildPaymentContext(selectedCase);
    const attorneyMeta =
      selectedCase.attorney && selectedCase.attorney._id
        ? selectedCase.attorney._id
        : selectedCase.attorneyId || selectedCase.attorney;
    const metadata = {
      ...context.metadata,
      attorneyId: attorneyMeta ? String(attorneyMeta) : "",
    };

    let forceNewFundingKey = false;
    if (selectedCase.escrowIntentId) {
      const existing = await stripe.paymentIntents.retrieve(selectedCase.escrowIntentId);
      if (existing?.status === "succeeded") {
        const snapshot = await applyPaymentIntentSnapshot(selectedCase, existing, { notifyOnSuccess: true });
        if (!snapshot.fundingVerified) {
          return res.status(409).json({
            error: "The existing payment does not match this matter's locked funding details.",
            code: "PAYMENT_INTEGRITY_FAILED",
          });
        }
        return res.json({
          clientSecret: existing.client_secret,
          intentId: existing.id,
          alreadyFunded: true,
        });
      }
      if (existing && !["succeeded", "canceled"].includes(existing.status)) {
        const amountMatches = existing.amount === totalCharge;
        const tgMatches = existing.transfer_group && existing.transfer_group === `case_${selectedCase._id.toString()}`;
        if (!amountMatches || !tgMatches) {
          return res.status(400).json({
            error: "Existing payment intent does not match locked amount. Please cancel and retry.",
          });
        }
        return res.json({ clientSecret: existing.client_secret, intentId: existing.id });
      }
      forceNewFundingKey = true;
    }

    const idempotencyKey = await resolveFundingIdempotencyKey(selectedCase, totalCharge, {
      mode: "client-escrow",
      forceNew: forceNewFundingKey,
    });
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: totalCharge,
        currency: selectedCase.currency || "usd",
        automatic_payment_methods: { enabled: true },
        receipt_email: selectedCase.attorney.email,
        transfer_group: `case_${selectedCase._id.toString()}`,
        metadata,
        description: context.description,
      },
      { idempotencyKey }
    );

    selectedCase.paymentIntentId = paymentIntent.id;
    selectedCase.escrowIntentId = paymentIntent.id;
    selectedCase.stripeMode = pickStripeMode(
      stripeModeFromLivemode(paymentIntent?.livemode),
      selectedCase.stripeMode,
      currentStripeMode()
    );
    await selectedCase.save();

    await AuditLog.logFromReq(req, "payment.intent.start", {
      targetType: "payment",
      targetId: paymentIntent.id,
      caseId: selectedCase._id,
      meta: {
        amount: amountToCharge,
        platformFee,
        totalCharge,
        currency: selectedCase.currency || "usd",
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret, intentId: paymentIntent.id });
  })
);

router.post(
  "/connect",
  requireRole("paralegal"),
  csrfProtection,
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
    if (STRIPE_CONNECT_BYPASS_EMAILS.has(normalizeEmail(user.email))) {
      return res.json({
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        connected: true,
        accountId: null,
        bank_name: "",
        bank_last4: "",
        devBypass: true,
      });
    }
    if (!user.stripeAccountId) {
      return res.json({
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        connected: false,
        accountId: null,
        bank_name: "",
        bank_last4: "",
      });
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
      return res.json({
        details_submitted: submitted,
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        connected,
        accountId: user.stripeAccountId,
        bank_name: bankName,
        bank_last4: bankLast4,
      });
    } catch (err) {
      runtimeLogger.error("[connect] status error", err?.message || err);
      return res.json({
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        connected: false,
        accountId: user.stripeAccountId,
        bank_name: "",
        bank_last4: "",
      });
    }
  })
);

/**
 * PATCH /api/payments/:caseId/budget
 * Body: { amountUsd, currency }
 * Attorney-owner or admin only. Validates case budget >= $400.
 */
router.patch(
  "/:caseId/budget",
  requireRole("attorney", "admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === "admin";
    const { caseId } = req.params;
    const { amountUsd, currency } = req.body || {};
    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ msg: "Matter not found" });

    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ msg: "Only the Matter attorney or an administrator can update the budget" });
    }

    if (c.lockedTotalAmount != null) {
      return res.status(403).json({
        error: "Matter amount is locked and cannot be modified.",
      });
    }
    if (!isAdmin) {
      const hasPendingInvites =
        Array.isArray(c.invites) &&
        c.invites.some(
          (invite) =>
            invite?.paralegalId &&
            String(invite.status || "pending").toLowerCase() === "pending"
        );
      if (c.paralegalId || c.pendingParalegalId || hasPendingInvites) {
        return res.status(403).json({
          error: "Matter amount is locked and cannot be modified.",
        });
      }
    }

    const cents = Math.round(Number(amountUsd || 0) * 100);
    if (!Number.isFinite(cents) || cents < MIN_CASE_AMOUNT_CENTS) {
      return res.status(400).json({ msg: MIN_CASE_AMOUNT_MESSAGE });
    }

    const before = c.totalAmount;
    c.totalAmount = cents;
    if (currency) c.currency = String(currency).toLowerCase();
    c.snapshotFees?.(); // compute fee snapshots if model helper exists
    await c.save();

    await AuditLog.logFromReq(req, "payment.budget.update", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: {
        totalAmount: c.totalAmount,
        currency: c.currency,
        ...(isAdmin && before !== c.totalAmount ? { amountOverride: { from: before, to: c.totalAmount }, adminId: req.user.id } : {}),
      },
    });

    res.json({ ok: true, totalAmount: c.totalAmount, currency: c.currency });
  })
);

/**
 * POST /api/payments/intent/:caseId
 * Creates (or reuses) a PaymentIntent to fund this Matter.
 * Attorney (owner) or admin only.
 * Optional header: x-idempotency-key
 */
router.post(
  "/intent/:caseId",
  requireRole("attorney", "admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const c = await Case.findById(caseId)
      .populate("paralegal", "firstName lastName email role")
      .populate("jobId", "title practiceArea");
    if (!c) return res.status(404).json({ error: "Matter not found" });

    // Only the attorney who owns the Matter (or an admin) can fund it.
    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can fund Matters" });
    }

    const baseAmount = c.lockedTotalAmount;
    if (!baseAmount || baseAmount < 50) {
      return res.status(400).json({ error: "Matter amount is not locked. Cannot fund Matter." });
    }
    const attorneyPct = resolveAttorneyFeePct(c);
    const attorneyFee = Math.max(0, Math.round(baseAmount * (attorneyPct / 100)));
    const amountToCharge = Math.round(baseAmount + attorneyFee);

    const transferGroup = `case_${c._id.toString()}`;
    const context = buildPaymentContext(c);
    const attorneyMeta =
      (c.attorney && c.attorney._id) || c.attorneyId || c.attorney;
    const paymentMetadata = {
      ...context.metadata,
      attorneyId: attorneyMeta ? String(attorneyMeta) : "",
    };
    const description = context.description;

    // Reuse existing PI if still active; ensure correct transfer_group/amount if editable
    let forceNewFundingKey = false;
    if (c.escrowIntentId) {
      const existing = await stripe.paymentIntents.retrieve(c.escrowIntentId);
      if (existing?.status === "succeeded") {
        const snapshot = await applyPaymentIntentSnapshot(c, existing, { notifyOnSuccess: true });
        if (!snapshot.fundingVerified) {
          return res.status(409).json({
            error: "The existing payment does not match this matter's locked funding details.",
            code: "PAYMENT_INTEGRITY_FAILED",
          });
        }
        return res.json({
          clientSecret: existing.client_secret,
          intentId: existing.id,
          alreadyFunded: true,
        });
      }
      if (existing && !["succeeded", "canceled"].includes(existing.status)) {
        const amountMatches = existing.amount === amountToCharge;
        const tgMatches = existing.transfer_group && existing.transfer_group === transferGroup;
        if (!amountMatches || !tgMatches) {
          return res.status(400).json({
            error: "Existing payment intent does not match locked amount. Please cancel and retry.",
          });
        }

        await AuditLog.logFromReq(req, "payment.intent.reuse", {
          targetType: "payment",
          targetId: existing.id,
          caseId: c._id,
          meta: { amount: amountToCharge, currency: c.currency || "usd", status: existing.status },
        });

        return res.json({ clientSecret: existing.client_secret, intentId: existing.id });
      }
      forceNewFundingKey = true;
    }

    // Create a fresh PI
    const idempotencyKey = await resolveFundingIdempotencyKey(c, amountToCharge, {
      mode: "client-escrow",
      forceNew: forceNewFundingKey,
    });
    const intent = await stripe.paymentIntents.create(
      {
        amount: amountToCharge, // cents
        currency: c.currency || "usd",
        automatic_payment_methods: { enabled: true },
        transfer_group: transferGroup, // important for later Connect transfer
        metadata: paymentMetadata,
        description,
      },
      { idempotencyKey }
    );

    c.escrowIntentId = intent.id;
    c.stripeMode = pickStripeMode(
      stripeModeFromLivemode(intent?.livemode),
      c.stripeMode,
      currentStripeMode()
    );
    syncPlatformFeeSnapshots(c, { baseAmount });
    await c.save();

    await AuditLog.logFromReq(req, "payment.intent.create", {
      targetType: "payment",
      targetId: intent.id,
      caseId: c._id,
      meta: {
        amount: amountToCharge,
        escrowAmount: baseAmount,
        platformFee: attorneyFee,
        currency: c.currency || "usd",
      },
    });

    res.json({ clientSecret: intent.client_secret, intentId: intent.id });
  })
);

/**
 * POST /api/payments/confirm/:caseId
 * Confirms Matter funding after client-side Stripe confirmation.
 * Sets escrowStatus to funded and transitions case to in progress when eligible.
 */
router.post(
  "/confirm/:caseId",
  requireRole("attorney", "admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid caseId" });
    }

    const c = await Case.findById(caseId)
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role");
    if (!c) return res.status(404).json({ error: "Matter not found" });

    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can confirm payments" });
    }
    if (!c.escrowIntentId) {
      return res.status(400).json({ error: "No payment intent found." });
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(c.escrowIntentId, {
        expand: ["latest_charge.balance_transaction"],
      });
    } catch (err) {
      runtimeLogger.error("[payments] confirm intent lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to verify Matter funding." });
    }
    if (!pi || pi.status !== "succeeded") {
      if (pi) {
        await applyPaymentIntentSnapshot(c, pi);
      }
      return res.status(402).json({
        error: "Payment not completed.",
        status: pi?.status || null,
        paymentIntentId: pi?.id || c.escrowIntentId,
      });
    }

    const snapshot = await applyPaymentIntentSnapshot(c, pi, { notifyOnSuccess: true });
    if (!snapshot.fundingVerified) {
      return res.status(409).json({
        error: "Payment verification failed. The Matter payment was not confirmed.",
        code: "PAYMENT_INTEGRITY_FAILED",
      });
    }

    return res.json({
      ok: true,
      status: c.status,
      escrowStatus: c.escrowStatus,
      paymentIntentId: c.escrowIntentId,
    });
  })
);

/**
 * POST /api/payments/reconcile/:caseId
 * Re-checks Stripe PaymentIntent and updates case funding state.
 */
router.post(
  "/reconcile/:caseId",
  requireRole("attorney", "admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid caseId" });
    }

    const c = await Case.findById(caseId)
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role");
    if (!c) return res.status(404).json({ error: "Matter not found" });

    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can reconcile this Matter" });
    }

    const intentId = c.escrowIntentId || c.paymentIntentId;
    if (!intentId) {
      return res.status(400).json({ error: "No payment intent found for this Matter" });
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(intentId, {
        expand: ["latest_charge.balance_transaction"],
      });
    } catch (err) {
      runtimeLogger.error("[payments] reconcile retrieve failed", err?.message || err);
      return res.status(502).json({ error: "Unable to load payment intent" });
    }

    const snapshot = await applyPaymentIntentSnapshot(c, pi, { notifyOnSuccess: true });

    await AuditLog.logFromReq(req, "payment.intent.reconcile", {
      targetType: "payment",
      targetId: pi.id,
      caseId: c._id,
      meta: {
        status: pi.status,
        amount: pi.amount,
        currency: pi.currency,
      },
    });

    return res.json({
      ok: true,
      status: c.status,
      escrowStatus: c.escrowStatus,
      paymentStatus: c.paymentStatus,
      paymentIntentStatus: pi.status || null,
      paymentIntentId: pi.id,
      fundingVerified: snapshot.fundingVerified,
      integrityFailure: snapshot.fundingVerified ? null : snapshot.reasons,
    });
  })
);

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
      if (claim.inProgress) {
        return res.status(409).json({
          error: "This dispute settlement is already being processed.",
          code: "PAYMENT_OPERATION_IN_PROGRESS",
        });
      }
      if (claim.completed) {
        return res.json({
          ok: true,
          alreadySettled: true,
          stripeObjectId: claim.operation.stripeObjectId || null,
        });
      }
      return null;
    };
    let settlementClaim = null;
    const storedSettlementMatches =
      String(storedSettlement.disputeId || "") === disputeKey &&
      String(storedSettlement.action || "") === String(action) &&
      !!storedSettlement.resolvedAt &&
      (action !== "release_partial" ||
        (Number.isFinite(Number(requestedPayout)) &&
          Number(storedSettlement.payoutAmount) === Math.round(Number(requestedPayout))));
    if (String(targetDispute.status || "open").toLowerCase() !== "open") {
      if (storedSettlementMatches && ["closed", "paused"].includes(String(c.status || "").toLowerCase())) {
        const settledObjectId = storedSettlement.transferId || storedSettlement.refundId || `settled_${c._id}`;
        await PaymentOperation.updateOne(
          { operationKey },
          {
            $set: {
              status: "succeeded",
              stripeObjectId: settledObjectId,
              stripeTransferId: storedSettlement.transferId || "",
              stripeRefundId: storedSettlement.refundId || "",
              lastError: "",
              completedAt: storedSettlement.resolvedAt,
            },
          }
        ).catch(logPromiseFailure(runtimeLogger, "[payments] stored settlement operation evidence repair failed", {
          caseId: c._id,
        }));
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
              },
            };
              if (charge?.id) {
                transferPayload.source_transaction = charge.id;
              }
              transfer = bypassPayouts
                ? { id: `bypass_${c._id}_${disputeKey}` }
                : await stripe.transfers.create(transferPayload, {
                  idempotencyKey: stripe.stripeIdempotencyKey(
                    "withdrawal_admin_payout",
                    c._id,
                    targetDispute.disputeId || targetDispute._id,
                    net,
                    c.escrowIntentId
                  ),
                  });
            } catch (err) {
              await failPaymentOperation(settlementClaim.operation, err).catch(
                logPromiseFailure(runtimeLogger, "[payments] failed withdrawal dispute operation could not be marked", {
                  caseId: c._id,
                })
              );
              runtimeLogger.error("[payments] withdrawal dispute payout transfer failed", err?.message || err);
              const message = stripe.sanitizeStripeError(
                err,
                "We couldn't release the payment right now. Please try again shortly."
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
        if (transferId) {
          const paralegalObjectId = payoutParalegal._id || c.withdrawnParalegalId;
          const attorneyObjectId = c.attorney?._id || c.attorneyId || c.attorney;
          const stripeMode = pickStripeMode(c.stripeMode, currentStripeMode());
          await Promise.all([
            upsertPayoutLedger({
              operationKey,
              caseId: c._id,
              paralegalId: paralegalObjectId,
              amountPaid: net,
              transferId,
              stripeMode,
            }),
            upsertPlatformIncomeLedger({
              operationKey,
              caseId: c._id,
              attorneyId: attorneyObjectId,
              paralegalId: paralegalObjectId,
              feeAmount,
              stripeMode,
            }),
          ]);
        }
        await c.save();
        if (settlementClaim?.operation) {
          await succeedPaymentOperation(
            settlementClaim.operation,
            transferId || `no_transfer_${c._id}_${disputeKey}`
          );
        }
      } catch (err) {
        if (settlementClaim?.operation && transferId) {
          await failPaymentOperation(settlementClaim.operation, err, {
            needsReconciliation: true,
            stripeObjectId: transferId,
          }).catch(logPromiseFailure(runtimeLogger, "[payments] settlement reconciliation operation marker failed", {
            caseId: c._id,
          }));
        }
        await Case.updateOne(
          { _id: c._id },
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
          error: "The financial action was recorded, but settlement records require reconciliation.",
          code: "PAYOUT_RECONCILIATION_REQUIRED",
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

      await AuditLog.logFromReq(req, "dispute.withdrawal.settle", {
        targetType: "payment",
        targetId: c._id,
        caseId: c._id,
        meta: {
          grossAmount: gross,
          netAmount: net,
          feePct,
          feeAmount,
          transferId,
          pending,
        },
      });

      try {
        const caseTitle = c.title || "Untitled Matter";
        const disputeKey = String(targetDispute.disputeId || targetDispute._id || "");
        const payoutLabel = formatCurrency(net);
        const baseMessage =
          gross > 0
            ? `Admin finalized the withdrawal payout for ${caseTitle}. Payout: ${payoutLabel}.`
            : `Admin finalized the withdrawal payout for ${caseTitle}. No payout will be issued.`;
        const receiptNote = "A receipt is available in your dashboard with payout details.";
        const attorneyId = c.attorney?._id || c.attorneyId || c.attorney;
        const paralegalId = payoutParalegal?._id || c.withdrawnParalegalId;
        await Promise.all([
          attorneyId
            ? notifyUser(
                attorneyId,
                "dispute_resolved",
                {
                  caseId: String(c._id),
                  caseTitle,
                  disputeId: disputeKey,
                  resolution: "withdrawal_admin",
                  resolutionLabel: gross > 0 ? "Payout finalized" : "No payout",
                  message: baseMessage,
                  receiptNote,
                  link: "dashboard-attorney.html#funds",
                },
                { actorUserId: req.user.id }
              )
            : Promise.resolve(null),
          paralegalId
            ? notifyUser(
                paralegalId,
                "dispute_resolved",
                {
                  caseId: String(c._id),
                  caseTitle,
                  disputeId: disputeKey,
                  resolution: "withdrawal_admin",
                  resolutionLabel: gross > 0 ? "Payout finalized" : "No payout",
                  message: baseMessage,
                  receiptNote,
                  link: "dashboard-paralegal.html#cases-completed",
                },
                { actorUserId: req.user.id }
              )
            : Promise.resolve(null),
        ]);
      } catch (err) {
        runtimeLogger.warn("[payments] withdrawal dispute notification failed", err?.message || err);
      }

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

      let refund = null;
      if (settlementClaim.operation.stripeRefundId) {
        refund = {
          id: settlementClaim.operation.stripeRefundId,
          amount: Number(settlementClaim.operation.refundAmount || baseAmount),
        };
      } else {
        try {
          refund = await stripe.refunds.create(
            {
              payment_intent: c.escrowIntentId,
              metadata: { caseId: String(c._id), disputeId: disputeKey, action: "refund" },
            },
            { idempotencyKey: stripe.stripeIdempotencyKey("dispute_refund", c._id, disputeKey, baseAmount) }
          );
        } catch (err) {
          if (!isRefundAlreadyProcessed(err)) {
            await failPaymentOperation(settlementClaim.operation, err).catch(
              logPromiseFailure(runtimeLogger, "[payments] failed dispute refund operation could not be marked", {
                caseId: c._id,
              })
            );
            runtimeLogger.error("[payments] dispute refund failed", err?.message || err);
            const message = stripe.sanitizeStripeError(
              err,
              "We couldn't release the payment right now. Please try again shortly."
            );
            return res.status(400).json({ error: message });
          }
          refund = {
            id: settlementClaim.operation.stripeRefundId || `already_refunded_${c.escrowIntentId}`,
            amount: Number(settlementClaim.operation.refundAmount || baseAmount),
          };
        }
      }

      await recordPaymentOperationEvidence(settlementClaim.operation, {
        refundId: refund.id,
        refundAmount: refund?.amount || baseAmount,
      });

      c.paymentReleased = false;
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
        await c.save();
        await succeedPaymentOperation(settlementClaim.operation, refund.id);
      } catch (err) {
        await failPaymentOperation(settlementClaim.operation, err, {
          needsReconciliation: true,
          stripeObjectId: refund.id,
        }).catch(logPromiseFailure(runtimeLogger, "[payments] refund reconciliation operation marker failed", {
          caseId: c._id,
        }));
        await Case.updateOne(
          { _id: c._id },
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

      await AuditLog.logFromReq(req, "dispute.settlement.refund", {
        targetType: "payment",
        targetId: c._id,
        caseId: c._id,
        meta: { refundId: refund.id, disputeId: disputeKey, externalRef: c.escrowIntentId },
      });

      try {
        const attorneyId = c.attorney?._id || c.attorneyId || c.attorney;
        const paralegalId = c.paralegal?._id || c.paralegalId || c.paralegal;
        const { attorneyPayload, paralegalPayload } = buildDisputeReceiptPayloads({
          caseDoc: c,
          disputeId: disputeKey,
          action,
          payoutAmount: 0,
          refundAmount: refund.amount || 0,
        });
        await Promise.all([
          attorneyId
            ? notifyUser(attorneyId, "dispute_resolved", attorneyPayload, { actorUserId: req.user.id })
            : Promise.resolve(null),
          paralegalId
            ? notifyUser(paralegalId, "dispute_resolved", paralegalPayload, { actorUserId: req.user.id })
            : Promise.resolve(null),
        ]);
      } catch (err) {
        runtimeLogger.warn("[payments] dispute resolution notification failed", err?.message || err);
      }

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

    let refund = null;
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
      if (refundAmount > 0 && settlementClaim.operation.stripeRefundId) {
        refund = {
          id: settlementClaim.operation.stripeRefundId,
          amount: Number(settlementClaim.operation.refundAmount || refundAmount),
        };
        effectiveRefunded = Math.max(alreadyRefunded, desiredTotalRefund);
      } else if (refundAmount > 0) {
        try {
          refund = await stripe.refunds.create(
            {
              payment_intent: c.escrowIntentId,
              amount: refundAmount,
              metadata: { caseId: String(c._id), disputeId: disputeKey, action: "release_partial" },
            },
            {
              idempotencyKey: stripe.stripeIdempotencyKey(
                "dispute_partial_refund",
                c._id,
                disputeKey,
                desiredTotalRefund
              ),
            }
          );
          effectiveRefunded = alreadyRefunded + (refund?.amount || refundAmount);
        } catch (err) {
        if (!isRefundAlreadyProcessed(err)) {
            await failPaymentOperation(settlementClaim.operation, err, { needsReconciliation: true }).catch(
              logPromiseFailure(runtimeLogger, "[payments] partial-refund reconciliation marker failed", {
                caseId: c._id,
              })
            );
            runtimeLogger.error("[payments] dispute partial refund failed", err?.message || err);
            const message = stripe.sanitizeStripeError(
              err,
              "We couldn't release the payment right now. Please try again shortly."
            );
            return res.status(400).json({ error: message });
          }
          refund = {
            id: settlementClaim.operation.stripeRefundId || `already_refunded_${c.escrowIntentId}`,
            amount: Number(settlementClaim.operation.refundAmount || refundAmount),
          };
          effectiveRefunded = alreadyRefunded + refundAmount;
        }
        await recordPaymentOperationEvidence(settlementClaim.operation, {
          refundId: refund.id,
          refundAmount: refund?.amount || refundAmount,
        });
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
    } else if (bypassPayouts) {
      transfer = { id: `bypass_${Date.now()}` };
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
          },
        };
        if (charge?.id) {
          transferPayload.source_transaction = charge.id;
        }
        transfer = await stripe.transfers.create(transferPayload, {
          idempotencyKey: stripe.stripeIdempotencyKey(
            "dispute_payout",
            c._id,
            disputeKey,
            action,
            payout,
            c.escrowIntentId
          ),
        });
      } catch (err) {
        await failPaymentOperation(settlementClaim.operation, err, {
          needsReconciliation: Boolean(refund?.id),
        }).catch(logPromiseFailure(runtimeLogger, "[payments] dispute payout reconciliation marker failed", {
          caseId: c._id,
        }));
        runtimeLogger.error("[payments] dispute payout transfer failed", err?.message || err);
        const message = stripe.sanitizeStripeError(
          err,
          "We couldn't release the payment right now. Please try again shortly."
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
      await upsertPayoutLedger({
        operationKey,
        caseId: c._id,
        paralegalId: paralegalObjectId,
        amountPaid: payout,
        transferId: transfer.id,
        stripeMode,
      });
      await upsertPlatformIncomeLedger({
        operationKey,
        caseId: c._id,
        attorneyId: attorneyObjectId,
        paralegalId: paralegalObjectId,
        feeAmount: Math.max(0, attorneyFee + paralegalFee),
        stripeMode,
      });
      await c.save();
      await succeedPaymentOperation(settlementClaim.operation, transfer.id);
    } catch (err) {
      await failPaymentOperation(settlementClaim.operation, err, {
        needsReconciliation: true,
        stripeObjectId: transfer.id,
      }).catch(logPromiseFailure(runtimeLogger, "[payments] final settlement reconciliation operation marker failed", {
        caseId: c._id,
      }));
      await Case.updateOne(
        { _id: c._id },
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

    await AuditLog.logFromReq(req, "dispute.settlement.release", {
      targetType: "payment",
      targetId: c._id,
      caseId: c._id,
      meta: {
        action,
        payout,
        feeA: attorneyFee,
        feeP: paralegalFee,
        refundId: refund?.id || null,
        disputeId: disputeKey,
        externalRef: transfer.id,
      },
    });

    try {
      const attorneyId = c.attorney?._id || c.attorneyId || c.attorney;
      const paralegalId = c.paralegal?._id || c.paralegalId || c.paralegal;
      const { attorneyPayload, paralegalPayload } = buildDisputeReceiptPayloads({
        caseDoc: c,
        disputeId: disputeKey,
        action,
        payoutAmount: payout,
        refundAmount: refund?.amount || 0,
      });
      await Promise.all([
        attorneyId
          ? notifyUser(attorneyId, "dispute_resolved", attorneyPayload, { actorUserId: req.user.id })
          : Promise.resolve(null),
        paralegalId
          ? notifyUser(paralegalId, "dispute_resolved", paralegalPayload, { actorUserId: req.user.id })
          : Promise.resolve(null),
      ]);
    } catch (err) {
      runtimeLogger.warn("[payments] dispute resolution notification failed", err?.message || err);
    }

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
  asyncHandler(async (req, res) => {
    const attorneyMatch = buildAttorneyMatch(req.user.id);
    const [activeCases, pendingCases, completedDocs] = await Promise.all([
      Case.find({
        ...attorneyMatch,
        escrowIntentId: { $nin: [null, ""] },
        paymentReleased: { $ne: true },
      })
        .select("totalAmount lockedTotalAmount")
        .lean(),
      Case.find({
        ...attorneyMatch,
        paymentReleased: { $ne: true },
        $and: [
          { $or: [{ paralegal: { $ne: null } }, { paralegalId: { $ne: null } }] },
          { $or: [{ escrowIntentId: { $exists: false } }, { escrowIntentId: null }, { escrowIntentId: "" }] },
        ],
      })
        .select("totalAmount lockedTotalAmount")
        .lean(),
      Case.find({
        ...attorneyMatch,
        paymentReleased: true,
      })
        .select("totalAmount lockedTotalAmount feeAttorneyAmount feeAttorneyPct")
        .lean(),
    ]);

    const activeEscrow = activeCases.reduce((sum, c) => sum + cents(c.lockedTotalAmount ?? c.totalAmount), 0);
    const pendingCharges = pendingCases.reduce((sum, c) => sum + cents(c.lockedTotalAmount ?? c.totalAmount), 0);
    const completedRecords = completedDocs.map((doc) => ({
      jobAmount: cents(doc.lockedTotalAmount ?? doc.totalAmount),
      platformFee: computePlatformFee(doc),
    }));
    const completedJobsCount = completedRecords.length;
    const totalJob = completedRecords.reduce((sum, rec) => sum + rec.jobAmount, 0);
    const totalFee = completedRecords.reduce((sum, rec) => sum + rec.platformFee, 0);
    const averageJobCost = completedJobsCount ? Math.round(totalJob / completedJobsCount) : 0;

    res.json({
      totalSpent: totalJob + totalFee,
      activeEscrow,
      pendingCharges,
      averageJobCost,
      completedJobsCount,
      pendingJobsCount: pendingCases.length,
    });
  })
);

router.get(
  "/escrow/active",
  requireRole("attorney"),
  asyncHandler(async (req, res) => {
    const attorneyMatch = buildAttorneyMatch(req.user.id);
    const limit = pickLimit(req.query.limit, 200, 500);
    const cases = await Case.find({
      ...attorneyMatch,
      escrowIntentId: { $nin: [null, ""] },
      paymentReleased: { $ne: true },
    })
      .populate("paralegal", "firstName lastName email role")
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    const items = cases.map((doc) => ({
      id: doc._id,
      caseId: doc._id,
      caseName: doc.title || doc.caseTitle || "Untitled Matter",
      paralegalName: doc.paralegal ? fullName(doc.paralegal) : "",
      paralegal: doc.paralegal || null,
      archived: !!doc.archived,
      caseStatus: doc.archived ? "archived" : doc.status || "active",
      amountHeld: cents(doc.lockedTotalAmount ?? doc.totalAmount),
      fundedAt: doc.updatedAt || doc.createdAt || doc.hiredAt || null,
      status: doc.paymentStatus || doc.status || "pending",
    }));
    const total = items.reduce((sum, entry) => sum + entry.amountHeld, 0);
    res.json({ items, total });
  })
);

router.get(
  "/escrow/pending",
  requireRole("attorney"),
  asyncHandler(async (req, res) => {
    const attorneyMatch = buildAttorneyMatch(req.user.id);
    const limit = pickLimit(req.query.limit, 200, 500);
    const cases = await Case.find({
      ...attorneyMatch,
      paymentReleased: { $ne: true },
      $and: [
        { $or: [{ paralegal: { $ne: null } }, { paralegalId: { $ne: null } }] },
        { $or: [{ escrowIntentId: { $exists: false } }, { escrowIntentId: null }, { escrowIntentId: "" }] },
      ],
    })
      .populate("paralegal", "firstName lastName email role")
      .sort({ updatedAt: -1 })
      .limit(limit)
      .exec();

    const items = await Promise.all(
      cases.map(async (doc) => {
        const checkoutUrl = await ensureCheckoutUrl(doc, req);
        return {
          id: doc._id,
          caseId: doc._id,
          caseName: doc.title || doc.caseTitle || "Untitled Matter",
          amountDue: cents(doc.lockedTotalAmount ?? doc.totalAmount),
          checkoutUrl,
          paralegalName: doc.paralegal ? fullName(doc.paralegal) : "",
        };
      })
    );
    const total = items.reduce((sum, entry) => sum + entry.amountDue, 0);
    res.json({ items, total });
  })
);

router.get(
  "/receipt/attorney/:caseId",
  requireRole("attorney"),
  asyncHandler(async (req, res) => {
    const doc = await Case.findById(req.params.caseId)
      .select(
        "title lockedTotalAmount totalAmount feeAttorneyAmount feeAttorneyPct paymentIntentId escrowIntentId payoutTransferId paidOutAt completedAt updatedAt attorney attorneyId attorneyNameSnapshot paralegalNameSnapshot withdrawnParalegalId pausedReason payoutFinalizedAt payoutFinalizedType partialPayoutAmount paymentReleased"
      )
      .populate("attorney", "firstName lastName email role")
      .lean();
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const attorneyId = doc.attorney?._id || doc.attorneyId || doc.attorney;
    if (String(attorneyId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the Matter attorney can access this receipt." });
    }
    const isWithdrawalReceipt =
      doc?.withdrawnParalegalId &&
      doc?.payoutFinalizedAt &&
      !doc?.paymentReleased &&
      ["zero_auto", "partial_attorney", "admin", "expired_zero"].includes(String(doc?.payoutFinalizedType || ""));
    if (isWithdrawalReceipt) {
      const gross = Number(doc.partialPayoutAmount ?? 0);
      const { attorneyPayload } = buildWithdrawalReceiptPayloads(doc, gross);
      const key = getWithdrawalReceiptKey(doc._id, "attorney");
      const filename = safeReceiptFilename(doc.title, "payout-receipt");
      const streamed = await tryStreamReceipt(res, key, filename);
      if (streamed) return;
      const pdfBuffer = await buildReceiptPdfBuffer(attorneyPayload);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
      if (S3_BUCKET) {
        uploadPdfToS3({ key, buffer: pdfBuffer }).catch((err) => {
          runtimeLogger.warn("[payments] withdrawal receipt upload failed", err?.message || err);
        });
      }
      return;
    }

    const paymentMethodLabel = await resolvePaymentMethodLabel(doc);
    const payload = buildAttorneyReceiptPayload(doc, paymentMethodLabel);
    const key = getReceiptKey(doc._id, "attorney");
    const filename = safeReceiptFilename(doc.title, "receipt");
    const streamed = shouldRefreshAttorneyReceiptCache(doc) ? false : await tryStreamReceipt(res, key, filename);
    if (streamed) return;
    const pdfBuffer = await buildReceiptPdfBuffer(payload);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
    if (S3_BUCKET) {
      uploadPdfToS3({ key, buffer: pdfBuffer }).catch((err) => {
        runtimeLogger.warn("[payments] receipt upload failed", err?.message || err);
      });
    }
  })
);

router.get(
  "/receipt/paralegal/:caseId",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const doc = await Case.findById(req.params.caseId)
      .select(
        "title lockedTotalAmount totalAmount feeAttorneyAmount feeAttorneyPct feeParalegalAmount feeParalegalPct payoutTransferId paidOutAt completedAt updatedAt paralegal paralegalId paralegalNameSnapshot attorney attorneyId attorneyNameSnapshot withdrawnParalegalId pausedReason payoutFinalizedAt payoutFinalizedType partialPayoutAmount paymentReleased"
      )
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role")
      .lean();
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const assignedId =
      doc.paralegal?._id ||
      (doc.paralegal && doc.paralegal.id) ||
      doc.paralegalId ||
      doc.paralegal;
    const withdrawnId =
      (doc.withdrawnParalegalId && doc.withdrawnParalegalId._id) ||
      (doc.withdrawnParalegalId && doc.withdrawnParalegalId.id) ||
      doc.withdrawnParalegalId ||
      null;
    const isWithdrawn = withdrawnId && String(withdrawnId) === String(req.user.id);
    if (!isWithdrawn && String(assignedId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the assigned paralegal can access this receipt." });
    }
    if (isWithdrawn) {
      if (!doc.payoutFinalizedAt) {
        return res.status(400).json({ error: "No withdrawal receipt is available yet." });
      }
      const gross = Number(doc.partialPayoutAmount ?? 0);
      const { paralegalPayload } = buildWithdrawalReceiptPayloads(doc, gross);
      const key = getWithdrawalReceiptKey(doc._id, "paralegal", withdrawnId);
      const filename = safeReceiptFilename(doc.title, "payout-receipt");
      const streamed = await tryStreamReceipt(res, key, filename);
      if (streamed) return;
      const pdfBuffer = await buildReceiptPdfBuffer(paralegalPayload);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
      if (S3_BUCKET) {
        uploadPdfToS3({ key, buffer: pdfBuffer }).catch((err) => {
          runtimeLogger.warn("[payments] withdrawal payout receipt upload failed", err?.message || err);
        });
      }
      return;
    }

    const payoutDoc = await Payout.findOne({
      caseId: doc._id,
      paralegalId: req.user._id || req.user.id,
    })
      .select("amountPaid transferId")
      .sort({ createdAt: -1 })
      .lean();
    const payload = buildParalegalReceiptPayload(doc, payoutDoc);
    const key = getReceiptKey(doc._id, "paralegal");
    const filename = safeReceiptFilename(doc.title, "payout-receipt");
    const streamed = shouldRefreshParalegalReceiptCache(doc) ? false : await tryStreamReceipt(res, key, filename);
    if (streamed) return;
    const pdfBuffer = await buildReceiptPdfBuffer(payload);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    res.send(pdfBuffer);
    if (S3_BUCKET) {
      uploadPdfToS3({ key, buffer: pdfBuffer }).catch((err) => {
        runtimeLogger.warn("[payments] payout receipt upload failed", err?.message || err);
      });
    }
  })
);

router.get(
  "/history",
  requireRole("attorney"),
  asyncHandler(async (req, res) => {
    const attorneyMatch = buildAttorneyMatch(req.user.id);
    const limit = pickLimit(req.query.limit, MAX_HISTORY_ROWS, MAX_HISTORY_ROWS);
    const cases = await fetchCompletedCases(attorneyMatch, limit);
    const items = cases.map(shapeHistoryRecord);
    const { totalSpent, averageJobCost } = summarizeHistory(items);
    res.json({
      items,
      totalSpent,
      averageJobCost,
      count: items.length,
    });
  })
);

router.get(
  "/export/csv",
  requireRole("attorney"),
  asyncHandler(async (req, res) => {
    const attorneyMatch = buildAttorneyMatch(req.user.id);
    const limit = pickLimit(req.query.limit, MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
    const cases = await fetchCompletedCases(attorneyMatch, limit);
    const records = cases.map(shapeHistoryRecord);

    const header = [
      "Matter Name",
      "Paralegal",
      "Matter Amount (USD)",
      "Platform Fee (USD)",
      "Total Charged (USD)",
      "Release Date",
      "Receipt URL",
    ];
    const rows = [header.join(",")];
    records.forEach((rec) => {
      rows.push(
        [
          csvEscape(rec.caseName || ""),
          csvEscape(rec.paralegalName || ""),
          csvEscape(formatDollars(rec.jobAmount)),
          csvEscape(formatDollars(rec.platformFee)),
          csvEscape(formatDollars(rec.totalCharged)),
          csvEscape(rec.releaseDate ? new Date(rec.releaseDate).toISOString() : ""),
          csvEscape(rec.receiptUrl || ""),
        ].join(",")
      );
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"billing-history.csv\"");
    res.send(rows.join("\n"));
  })
);

// ----------------------------------------
// Admin Receipts Index
// ----------------------------------------
router.get(
  "/receipts",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const query = String(req.query.q || req.query.query || "").trim().toLowerCase();

    const cases = await Case.find({
      $or: [
        { escrowIntentId: { $exists: true, $ne: null } },
        { paymentIntentId: { $exists: true, $ne: null } },
        { payoutTransferId: { $exists: true, $ne: null } },
        { payoutFinalizedAt: { $ne: null }, payoutFinalizedType: { $ne: null } },
      ],
    })
      .select(
        "title escrowIntentId paymentIntentId payoutTransferId payoutFinalizedAt payoutFinalizedType partialPayoutAmount lockedTotalAmount totalAmount remainingAmount feeAttorneyPct feeAttorneyAmount feeParalegalPct feeParalegalAmount currency attorney attorneyId paralegal paralegalId withdrawnParalegalId paidOutAt completedAt updatedAt createdAt"
      )
      .populate("attorney", "firstName lastName email")
      .populate("paralegal", "firstName lastName email")
      .populate("withdrawnParalegalId", "firstName lastName email")
      .lean();

    const caseIds = cases.map((c) => c._id);
    const payouts = caseIds.length
      ? await Payout.find({ caseId: { $in: caseIds } })
          .select("caseId transferId amountPaid createdAt paralegalId")
          .lean()
      : [];
    const payoutsByCase = new Map();
    payouts.forEach((p) => {
      const key = String(p.caseId || "");
      if (!key) return;
      const bucket = payoutsByCase.get(key) || [];
      bucket.push(p);
      payoutsByCase.set(key, bucket);
    });

    const rows = [];
    cases.forEach((doc) => {
      const caseId = String(doc._id || "");
      const caseTitle = doc.title || "Untitled Matter";
      const attorneyName = fullName(doc.attorney || {}) || doc.attorneyNameSnapshot || "Attorney";
      const paralegalName = fullName(doc.paralegal || {}) || doc.paralegalNameSnapshot || "Paralegal";
      const withdrawnName =
        fullName(doc.withdrawnParalegalId || {}) || doc.paralegalNameSnapshot || "Paralegal";

      const baseAmount = Number(doc.lockedTotalAmount ?? doc.totalAmount ?? 0);
      const attorneyFee = computePlatformFee(doc);
      const fundingReceiptId = doc.paymentIntentId || doc.escrowIntentId || "";
      if (fundingReceiptId) {
        rows.push(
          buildReceiptRow({
            receiptId: fundingReceiptId,
            caseId,
            caseTitle,
            partyLabel: attorneyName,
            receiptType: "Funding",
            amountCents: Math.max(0, baseAmount + attorneyFee),
            issuedAt: doc.createdAt || doc.updatedAt,
          })
        );
      }

      const casePayouts = payoutsByCase.get(caseId) || [];
      const activeParalegalId = String(doc.paralegal?._id || doc.paralegalId || "");
      const payoutDoc =
        casePayouts.find((p) => String(p.paralegalId || "") === activeParalegalId) ||
        casePayouts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ||
        null;
      const payoutReceiptId = payoutDoc?.transferId || doc.payoutTransferId || "";
      if (payoutReceiptId) {
        const payoutAmount = Number.isFinite(Number(payoutDoc?.amountPaid))
          ? Number(payoutDoc.amountPaid)
          : Math.max(0, baseAmount - computeParalegalFee(doc));
        rows.push(
          buildReceiptRow({
            receiptId: payoutReceiptId,
            caseId,
            caseTitle,
            partyLabel: paralegalName,
            receiptType: "Payout",
            amountCents: payoutAmount,
            issuedAt: payoutDoc?.createdAt || doc.paidOutAt || doc.completedAt || doc.updatedAt,
          })
        );
      }

      if (doc.payoutFinalizedAt && doc.payoutFinalizedType) {
        const issuedAt = doc.payoutFinalizedAt;
        const receiptId = `${caseId}-withdrawal-${new Date(issuedAt).getTime()}`;
        const gross = Number(doc.partialPayoutAmount ?? 0);
        const { net } = computeParalegalFeeFromGross(gross, doc);
        rows.push(
          buildReceiptRow({
            receiptId,
            caseId,
            caseTitle,
            partyLabel: attorneyName,
            receiptType: "Withdrawal",
            amountCents: gross,
            issuedAt,
          })
        );
        rows.push(
          buildReceiptRow({
            receiptId,
            caseId,
            caseTitle,
            partyLabel: withdrawnName,
            receiptType: "Withdrawal",
            amountCents: net,
            issuedAt,
          })
        );
      }
    });

    let filtered = rows;
    if (query) {
      filtered = rows.filter((row) => {
        return (
          String(row.receiptId || "").toLowerCase().includes(query) ||
          String(row.caseTitle || "").toLowerCase().includes(query) ||
          String(row.party || "").toLowerCase().includes(query) ||
          String(row.type || "").toLowerCase().includes(query)
        );
      });
    }
    filtered.sort((a, b) => new Date(b.issuedAt || 0) - new Date(a.issuedAt || 0));

    const total = filtered.length;
    const items = filtered.slice(skip, skip + limit);

    res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items,
    });
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  runtimeLogger.error(err);
  res.status(500).json({ error: "Server error" });
});

module.exports = router;
