// backend/routes/payments.js
const router = require("express").Router();
const mongoose = require("mongoose");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const stripe = require("../utils/stripe");
const Case = require("../models/Case");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog"); // match your filename
const Notification = require("../models/Notification");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const sendEmail = require("../utils/email");
const { buildReceiptPdfBuffer, uploadPdfToS3, getReceiptKey } = require("../services/caseLifecycle");
const { notifyUser } = require("../utils/notifyUser");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const STRIPE_APPROVAL_BYPASS_EMAILS = new Set([
  "samanthasider+11@gmail.com",
  "samanthasider+56@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);
const STRIPE_PAYOUT_BYPASS_EMAILS = new Set([
  "samanthasider+11@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);

// CSRF (enabled in production or when ENABLE_CSRF=true)
const noop = (_req, _res, next) => next();
const csrf = require("csurf");
const csrfMiddleware = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
const csrfProtection = (req, res, next) => {
  const requireCsrf =
    process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
  if (!requireCsrf) return noop(req, res, next);
  return csrfMiddleware(req, res, next);
};

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

function buildDisputeResolutionMessage(caseTitle, action) {
  const title = caseTitle || "the case";
  switch (String(action || "")) {
    case "refund":
      return `The dispute for ${title} was resolved. Funds were refunded to the attorney.`;
    case "release_partial":
      return `The dispute for ${title} was resolved. A partial payment was released.`;
    case "release_full":
      return `The dispute for ${title} was resolved. Funds were released to the paralegal.`;
    default:
      return `The dispute for ${title} was resolved.`;
  }
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

function buildDisputeReceiptPayloads({
  caseDoc,
  disputeId,
  action,
  payoutAmount = 0,
  refundAmount = 0,
}) {
  const caseTitle = caseDoc?.title || "Case";
  const resolutionLabel =
    action === "refund" ? "Refund" : action === "release_partial" ? "Partial release" : "Full release";
  const basePayload = {
    title: "Dispute resolved",
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
      ? `The dispute for ${caseTitle} was resolved with a refund issued to you.`
      : action === "release_partial"
      ? `The dispute for ${caseTitle} was resolved with a partial release.`
      : `The dispute for ${caseTitle} was resolved with funds released to the paralegal.`;

  const paralegalMessage =
    action === "refund"
      ? `The dispute for ${caseTitle} was resolved. No payout was released.`
      : action === "release_partial"
      ? `The dispute for ${caseTitle} was resolved with a partial payout.`
      : `The dispute for ${caseTitle} was resolved and your payout was released.`;

  const attorneyReceiptNote =
    "A receipt is available in your dashboard with refund and platform fee details.";
  const paralegalReceiptNote =
    "A receipt is available in your dashboard with payout, refund, and platform fee details.";

  return {
    attorneyPayload: {
      ...basePayload,
      message: attorneyMessage,
      receiptNote: attorneyReceiptNote,
      link: "dashboard-attorney.html#billing",
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

const PLATFORM_FEE_ATTORNEY_PERCENT = Number(
  process.env.PLATFORM_FEE_ATTORNEY_PERCENT || process.env.PLATFORM_FEE_PERCENT || 22
);
const PLATFORM_FEE_PARALEGAL_PERCENT = Number(
  process.env.PLATFORM_FEE_PARALEGAL_PERCENT || 18
);
const MAX_HISTORY_ROWS = Number(process.env.BILLING_HISTORY_LIMIT || 500);
const MAX_EXPORT_ROWS = Number(process.env.BILLING_EXPORT_LIMIT || 2000);

const CLIENT_BASE_URL = trimSlash(process.env.CLIENT_BASE_URL || process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL);
const CHECKOUT_SUCCESS_URL = (process.env.STRIPE_CHECKOUT_SUCCESS_URL || "").trim();
const CHECKOUT_CANCEL_URL = (process.env.STRIPE_CHECKOUT_CANCEL_URL || "").trim();

const S3_BUCKET = process.env.S3_BUCKET || "";
const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials:
    process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY,
        }
      : undefined,
});

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

function computePlatformFee(doc = {}) {
  const snap = cents(doc.feeAttorneyAmount);
  if (snap > 0) return snap;
  const pct = resolveAttorneyFeePct(doc);
  const base = doc.lockedTotalAmount ?? doc.totalAmount;
  return Math.max(0, Math.round(cents(base) * (pct / 100)));
}

function computeParalegalFee(doc = {}) {
  const snap = cents(doc.feeParalegalAmount);
  if (snap > 0) return snap;
  const pct = resolveParalegalFeePct(doc);
  const base = doc.lockedTotalAmount ?? doc.totalAmount;
  return Math.max(0, Math.round(cents(base) * (pct / 100)));
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
  const feeAttorneyAmount = Number.isFinite(settlement.feeAttorneyAmount)
    ? cents(settlement.feeAttorneyAmount)
    : Math.max(0, Math.round(grossAmount * (feeAttorneyPct / 100)));
  const feeParalegalAmount = Number.isFinite(settlement.feeParalegalAmount)
    ? cents(settlement.feeParalegalAmount)
    : Math.max(0, Math.round(grossAmount * (feeParalegalPct / 100)));
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

function isFinalCaseDoc(doc) {
  if (!doc) return false;
  if (doc.paymentReleased === true) return true;
  return String(doc.status || "").toLowerCase() === "completed";
}

async function hasCaseNotification(userId, type, caseDoc, payload = {}) {
  if (!userId || !caseDoc?._id) return false;
  const query = {
    userId,
    type,
    "payload.caseId": caseDoc._id,
  };
  if (payload.summary) {
    query["payload.summary"] = payload.summary;
  }
  if (payload.amount) {
    query["payload.amount"] = payload.amount;
  }
  const existing = await Notification.findOne(query).select("_id").lean();
  return !!existing;
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
    console.warn("[payments] stripe onboarding status check failed", err?.message || err);
  }
  return false;
}

async function ensureConnectAccount(user) {
  if (!user) throw new Error("User not found");
  if (!user.email) throw new Error("Email is required for Stripe onboarding");
  if (user.stripeAccountId) return user.stripeAccountId;
  const account = await stripe.accounts.create({
    type: "express",
    country: CONNECT_COUNTRY,
    email: user.email,
    business_type: "individual",
    capabilities: {
      transfers: { requested: true },
    },
  });
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
  const origin = req?.headers?.origin || req?.get?.("origin");
  if (origin) return trimSlash(origin);
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
  if (specific) {
    const connector = specific.includes("?") ? "&" : "?";
    return `${specific}${connector}caseId=${caseId}`;
  }
  const base = `${resolveClientBase(req)}/dashboard-attorney.html`;
  const connector = base.includes("?") ? "&" : "?";
  const flag = type === "success" ? "payment=success" : "payment=cancel";
  return `${base}${connector}${flag}&caseId=${caseId}`;
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
    `Case ${doc._id || doc.caseId || ""}`.trim() ||
    "Case"
  );
}

function resolveJobTitle(doc = {}) {
  return (
    doc.jobTitle ||
    (doc.jobId && typeof doc.jobId === "object" && doc.jobId.title) ||
    doc.title ||
    doc.caseTitle ||
    "Job"
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
  const { transferable } = stripe.isTransferablePaymentIntent(paymentIntent, { caseId: caseDoc._id });

  if (!caseDoc.paymentIntentId) caseDoc.paymentIntentId = paymentIntent.id;
  if (!caseDoc.escrowIntentId) caseDoc.escrowIntentId = paymentIntent.id;
  if (!caseDoc.currency) caseDoc.currency = paymentIntent.currency || caseDoc.currency || "usd";
  if (caseDoc.lockedTotalAmount == null && (!caseDoc.totalAmount || caseDoc.totalAmount <= 0) && Number.isFinite(paymentIntent.amount)) {
    caseDoc.totalAmount = paymentIntent.amount;
  }
  if (caseDoc.lockedTotalAmount == null && caseDoc.totalAmount) {
    caseDoc.lockedTotalAmount = caseDoc.totalAmount;
  }
  caseDoc.paymentStatus = piStatus || caseDoc.paymentStatus || "pending";

  if (piStatus === "succeeded" && transferable) {
    caseDoc.escrowStatus = "funded";
    const status = String(caseDoc.status || "").toLowerCase();
    if (hasParalegal && ["awaiting_funding", "assigned", "open"].includes(status)) {
      if (typeof caseDoc.canTransitionTo === "function" && caseDoc.canTransitionTo("in progress")) {
        caseDoc.transitionTo("in progress");
      } else {
        caseDoc.status = "in progress";
      }
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
          caseTitle: caseDoc.title || "Case",
          link: buildCaseLink(caseDoc),
        });
      } catch (err) {
        console.warn("[payments] notifyUser case_work_ready failed", err?.message || err);
      }
    }
  }

  return { updated: true, paymentStatus: caseDoc.paymentStatus, escrowStatus: caseDoc.escrowStatus, status: caseDoc.status };
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
    description: `Case: ${caseName} — Job: ${jobTitle} — Paralegal: ${paralegalName}`,
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
      console.warn(`[payments] Unable to reuse checkout session for case ${caseDoc._id}:`, err.message);
    }
  }
  try {
    const successUrl = buildReturnUrl(req, "success", caseDoc._id);
    const cancelUrl = buildReturnUrl(req, "cancel", caseDoc._id);
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
    });
    caseDoc.escrowSessionId = session.id;
    await caseDoc.save();
    return session.url || "";
  } catch (err) {
    console.warn(`[payments] Unable to create checkout session for case ${caseDoc._id}:`, err.message);
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
      expand: ["charges.data.payment_method_details", "payment_method"],
    });
    const charge = intent?.charges?.data?.[0];
    const card = charge?.payment_method_details?.card || intent?.payment_method?.card || null;
    if (card?.last4) {
      const brand = card?.brand ? String(card.brand).replace(/_/g, " ") : "Card";
      return `${brand} ending ${card.last4}`;
    }
  } catch (err) {
    console.warn("[payments] payment method lookup failed", err?.message || err);
  }
  return "Card on file";
}

function buildAttorneyReceiptPayload(caseDoc, paymentMethodLabel) {
  const settlement = resolveDisputeSettlement(caseDoc);
  const baseAmount = settlement?.grossAmount ?? Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
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
    caseTitle: caseDoc.title || "Case",
    lineItems: [
      { label: "Case fee", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${attorneyPct}%)`, value: formatCurrency(platformFee) },
    ],
    totalLabel: "Total paid",
    totalAmount: formatCurrency(baseAmount + platformFee),
    paymentMethod: paymentMethodLabel || "Card on file",
    paymentStatus: "Paid in full",
  };
}

function buildParalegalReceiptPayload(caseDoc, payoutDoc) {
  const settlement = resolveDisputeSettlement(caseDoc);
  const baseAmount = settlement?.grossAmount ?? Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
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
    caseTitle: caseDoc.title || "Case",
    lineItems: [
      { label: "Gross amount", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${paralegalPct}%)`, value: formatCurrency(platformFee) },
    ],
    totalLabel: "Net paid",
    totalAmount: formatCurrency(payoutAmount),
    paymentMethod: "Escrow release",
    paymentStatus: "Paid",
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
      console.error("[payments] receipt stream error", err);
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
      console.warn("[payments] stripe customer missing; recreating", {
        userId: String(user._id || ""),
        stripeCustomerId: user.stripeCustomerId,
      });
    }
  }
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: fullName(user) || undefined,
    metadata: {
      userId: user._id ? String(user._id) : "",
      role: user.role || "",
    },
  });
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
    console.warn(`[payments] unable to retrieve default payment method ${defaultPmId}:`, err?.message || err);
    return null;
  }
}

// ----------------------------------------
// PUBLIC: Stripe publishable key for Stripe.js
// GET /api/payments/config
// ----------------------------------------
router.get('/config', (req, res) => {
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

    try {
      const customerId = await ensureStripeCustomer(user);
      const paymentMethod = await fetchDefaultPaymentMethod(customerId);
      return res.json({
        customerId,
        hasDefault: !!paymentMethod,
        paymentMethod,
      });
    } catch (err) {
      console.error("[payments] default payment method lookup failed", err?.message || err);
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
      const intent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          userId: user._id ? String(user._id) : "",
          role: user.role || "",
          email: user.email || "",
        },
      });

      res.json({ clientSecret: intent.client_secret, intentId: intent.id, customerId });
    } catch (err) {
      console.error("[payments] setup_intent creation failed", err?.message || err);
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
      console.error("[payments] failed to set default payment method", err?.message || err);
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
    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: "Stripe billing portal is not enabled for this account yet." });
    }
    const returnUrl = `${resolveClientBase(req)}/dashboard-attorney.html`;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });
    if (!session?.url) {
      return res.status(502).json({ error: "Unable to create billing portal session." });
    }
    res.json({ url: session.url, sessionId: session.id });
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
    if (!selectedCase) return res.status(404).json({ error: "Case not found" });

    const attorneyId =
      (selectedCase.attorney && selectedCase.attorney._id) ||
      selectedCase.attorneyId ||
      selectedCase.attorney;
    if (String(attorneyId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the case attorney can fund escrow" });
    }

    if (!selectedCase.paralegal) {
      return res.status(400).json({ error: "Hire a paralegal before funding escrow" });
    }
    if (!selectedCase.attorney || !selectedCase.attorney.email) {
      return res.status(400).json({ error: "Attorney email is required to send the payment receipt" });
    }

    const amountToCharge = selectedCase.lockedTotalAmount;
    if (!amountToCharge || amountToCharge < 50) {
      return res.status(400).json({
        error: "Escrow amount is not locked. Invite/accept/hire first.",
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

    if (selectedCase.escrowIntentId) {
      const existing = await stripe.paymentIntents.retrieve(selectedCase.escrowIntentId);
      if (existing && !["succeeded", "canceled"].includes(existing.status)) {
        const amountMatches = existing.amount === totalCharge;
        const tgMatches = existing.transfer_group && existing.transfer_group === `case_${selectedCase._id.toString()}`;
        if (!amountMatches || !tgMatches) {
          return res.status(400).json({
            error: "Existing escrow intent does not match locked amount. Please cancel and retry.",
          });
        }
        return res.json({ clientSecret: existing.client_secret, intentId: existing.id });
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCharge,
      currency: selectedCase.currency || "usd",
      automatic_payment_methods: { enabled: true },
      receipt_email: selectedCase.attorney.email,
      transfer_group: `case_${selectedCase._id.toString()}`,
      metadata,
      description: context.description,
    });

    selectedCase.paymentIntentId = paymentIntent.id;
    selectedCase.escrowIntentId = paymentIntent.id;
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

/**
 * POST /api/payments/release
 * Body: { caseId }
 * Marks a case complete and transfers funds to the paralegal's connected account.
 */
router.post(
  "/release",
  requireRole("attorney", "admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Funds are released only via case completion." });
    }
    const { caseId } = req.body || {};
    if (!caseId || !isObjId(caseId)) {
      return res.status(400).json({ error: "Valid caseId is required" });
    }

    const c = await Case.findById(caseId)
      .populate(
        "paralegal",
        "stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled firstName lastName email role"
      )
      .populate("attorney", "firstName lastName email role");
    if (!c) return res.status(404).json({ error: "Case not found" });
    if (c.status === "completed" || c.paymentReleased) {
      return res.json({ ok: true, alreadyReleased: true });
    }
    const existingPayout = await Payout.findOne({ caseId: c._id })
      .select("amountPaid transferId")
      .lean();
    if (existingPayout) {
      return res.json({
        ok: true,
        alreadyReleased: true,
        payout: existingPayout.amountPaid,
        transferId: existingPayout.transferId,
      });
    }
    if (c.payoutTransferId) {
      return res.json({
        ok: true,
        alreadyReleased: true,
        transferId: c.payoutTransferId,
      });
    }
    if (c.payoutTransferId) {
      return res.json({
        ok: true,
        alreadyReleased: true,
        transferId: c.payoutTransferId,
      });
    }
    return res.status(400).json({ error: "Funds are released only via case completion." });

    const attorneyRef =
      (c.attorney && c.attorney._id) || c.attorneyId || c.attorney;
    if (String(attorneyRef) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the case attorney can release funds" });
    }

    const intentId = c.paymentIntentId || c.escrowIntentId;
    if (!intentId) {
      return res.status(400).json({ error: "Case has no funded payment intent" });
    }
    if (!c.paralegal || !c.paralegal.stripeAccountId) {
      return res.status(400).json({ error: "Paralegal is not onboarded for payouts" });
    }
    if (!c.paralegal.stripeOnboarded || !c.paralegal.stripePayoutsEnabled) {
      const refreshed = await ensureStripeOnboarded(c.paralegal);
      if (!refreshed) {
        return res.status(400).json({ error: "Paralegal must complete Stripe Connect onboarding before payouts" });
      }
    }
    if (!c.paralegal.stripeOnboarded || !c.paralegal.stripePayoutsEnabled) {
      return res.status(400).json({ error: "Paralegal must complete Stripe Connect onboarding before payouts" });
    }

    const budgetCents = Number((c.lockedTotalAmount ?? c.totalAmount) || 0);
    if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
      return res.status(400).json({ error: "Case budget is missing or invalid" });
    }
    const attorneyFee =
      Number.isFinite(c.feeAttorneyAmount) && c.feeAttorneyAmount >= 0
        ? c.feeAttorneyAmount
        : Math.max(0, Math.round(budgetCents * (resolveAttorneyFeePct(c) / 100)));
    const paralegalFee =
      Number.isFinite(c.feeParalegalAmount) && c.feeParalegalAmount >= 0
        ? c.feeParalegalAmount
        : Math.max(0, Math.round(budgetCents * (resolveParalegalFeePct(c) / 100)));
    const payout = Math.max(0, budgetCents - paralegalFee);
    if (payout <= 0) {
      return res.status(400).json({ error: "Calculated payout must be positive" });
    }

    const attorneyMetaId =
      c.attorney && c.attorney._id
        ? c.attorney._id.toString()
        : c.attorneyId
        ? String(c.attorneyId)
        : "";
    const paralegalMetaId =
      c.paralegal && c.paralegal._id
        ? c.paralegal._id.toString()
        : c.paralegalId
        ? String(c.paralegalId)
        : "";

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(intentId, {
        expand: ["charges.data.balance_transaction"],
      });
    } catch (err) {
      console.error("[payments] release intent lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to verify escrow funding." });
    }

    const { transferable, charge } = stripe.isTransferablePaymentIntent(paymentIntent, { caseId: c._id });
    if (!transferable) {
      return res.status(400).json({ error: "Escrow payment is not ready to release yet." });
    }

    const transferPayload = {
      amount: payout,
      currency: c.currency || "usd",
      destination: c.paralegal.stripeAccountId,
      transfer_group: `case_${c._id.toString()}`,
      metadata: {
        caseId: c._id.toString(),
        attorneyId: attorneyMetaId,
        paralegalId: paralegalMetaId,
        description: "LPC Escrow Release",
      },
    };
    if (charge?.id) {
      transferPayload.source_transaction = charge.id;
    }

    let transfer;
    try {
      transfer = await stripe.transfers.create(transferPayload);
    } catch (err) {
      console.error("[payments] release transfer failed", err?.message || err);
      const message = stripe.sanitizeStripeError(
        err,
        "We couldn't release funds right now. Please try again shortly."
      );
      return res.status(400).json({ error: message });
    }

    const completedAt = c.completedAt || new Date();
    const paralegalName = `${c.paralegal?.firstName || ""} ${c.paralegal?.lastName || ""}`.trim() || "Paralegal";
    const downloadPaths = (c.files || [])
      .map((file) => {
        if (file.key) return file.key.startsWith("/") ? file.key : `/${file.key}`;
        if (file.filename) return `/uploads/${file.filename}`;
        return null;
      })
      .filter(Boolean);

    c.status = "completed";
    c.completedAt = c.completedAt || completedAt;
    c.briefSummary = `${c.title} – ${paralegalName} – completed ${completedAt.toISOString().split("T")[0]}`;
    c.archived = true;
    c.paymentReleased = true;
    c.payoutTransferId = transfer.id;
    c.paidOutAt = completedAt;
    c.downloadUrl = downloadPaths;
    if (!Number.isFinite(c.feeAttorneyPct)) c.feeAttorneyPct = resolveAttorneyFeePct(c);
    if (!Number.isFinite(c.feeAttorneyAmount)) c.feeAttorneyAmount = attorneyFee;
    if (!Number.isFinite(c.feeParalegalPct)) c.feeParalegalPct = resolveParalegalFeePct(c);
    if (!Number.isFinite(c.feeParalegalAmount)) c.feeParalegalAmount = paralegalFee;
    if (Array.isArray(c.applicants)) c.applicants = [];
    if (Array.isArray(c.updates)) c.updates = [];
    await c.save();

    const attorneyObjectId = c.attorney?._id || c.attorneyId || c.attorney;
    const paralegalObjectId = c.paralegal?._id || c.paralegalId || c.paralegal;

    const existingIncome = await PlatformIncome.findOne({ caseId: c._id })
      .select("_id")
      .lean();
    await Promise.all([
      Payout.updateOne(
        { caseId: c._id },
        {
          $setOnInsert: {
            paralegalId: paralegalObjectId,
            caseId: c._id,
            amountPaid: payout,
            transferId: transfer.id,
          },
        },
        { upsert: true }
      ).catch((err) => {
        if (err?.code === 11000) return null;
        throw err;
      }),
      existingIncome
        ? Promise.resolve(null)
        : PlatformIncome.create({
            caseId: c._id,
            attorneyId: attorneyObjectId,
            paralegalId: paralegalObjectId,
            feeAmount: Math.max(0, (c.feeAttorneyAmount || attorneyFee || 0) + (paralegalFee || 0)),
          }).catch((err) => {
            if (err?.code === 11000) return null;
            throw err;
          }),
    ]);

    await AuditLog.logFromReq(req, "payment.release.transfer", {
      targetType: "payment",
      targetId: c._id,
      caseId: c._id,
      meta: {
        payout,
        feeAmount: paralegalFee,
        currency: c.currency || "usd",
        destination: c.paralegal.stripeAccountId,
        externalRef: transfer.id,
      },
    });

    const completedDateStr = completedAt.toLocaleDateString("en-US");
    const payoutDisplay = `$${(payout / 100).toFixed(2)}`;
    const feeDisplay = `$${(paralegalFee / 100).toFixed(2)}`;
    const totalDisplay = `$${(budgetCents / 100).toFixed(2)}`;
    try {
      const link = `case-detail.html?caseId=${encodeURIComponent(c._id)}`;
      const payload = {
        caseId: c._id,
        caseTitle: c.title || "Case",
        amount: payoutDisplay,
        link,
      };
      const alreadySent = await hasCaseNotification(paralegalObjectId, "payout_released", c, payload);
      if (!alreadySent) {
        await notifyUser(paralegalObjectId, "payout_released", payload, { actorUserId: req.user.id });
      }
    } catch (err) {
      console.warn("[payments] payout notification failed", err?.message || err);
    }

    if (c.attorney?.email) {
      const attorneyName = `${c.attorney.firstName || ""} ${c.attorney.lastName || ""}`.trim() || "there";
      await sendEmail(
        c.attorney.email,
        "Your LPC job is officially complete",
        `<p>Hi ${attorneyName},</p>
         <p>Your case \"<strong>${c.title}</strong>\" was completed on <strong>${completedDateStr}</strong>.</p>
         <p>Deliverables are available for download in your dashboard.</p>
         <p>Thanks for using Let’s-ParaConnect.</p>`
      ).catch(() => {});
    }

    if (c.paralegal?.email) {
      const paraName = `${c.paralegal.firstName || ""} ${c.paralegal.lastName || ""}`.trim() || "there";
      await sendEmail(
        c.paralegal.email,
        "Your LPC payout is complete",
        `<p>Hi ${paraName},</p>
         <p>Your payout for \"<strong>${c.title}</strong>\" is complete.</p>
         <p>Job amount (escrow): ${totalDisplay}<br/>Platform fee (${resolveParalegalFeePct(c)}%) deducted: ${feeDisplay}<br/>Payout: <strong>${payoutDisplay}</strong></p>
         <p>Funds have been transferred to your connected Stripe account.</p>`
      ).catch(() => {});
    }

    res.json({ ok: true, payout, transferId: transfer.id });
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
      res.status(400).json({ error: err?.message || "Unable to start Stripe onboarding" });
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
      res.status(400).json({ error: err?.message || "Unable to prepare Stripe account" });
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
      "stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled"
    );
    if (!user) return res.status(404).json({ error: "User not found" });
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
      console.error("[connect] status error", err?.message || err);
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
 * Attorney-owner or admin only. Validates cents >= $0.50.
 */
router.patch(
  "/:caseId/budget",
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === "admin";
    const { caseId } = req.params;
    const { amountUsd, currency } = req.body || {};
    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ msg: "Case not found" });

    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ msg: "Only the case attorney or admin can update budget" });
    }

    if (c.lockedTotalAmount != null) {
      return res.status(403).json({
        error: "Escrow amount is locked and cannot be modified.",
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
          error: "Escrow amount is locked and cannot be modified.",
        });
      }
    }

    const cents = Math.round(Number(amountUsd || 0) * 100);
    if (!Number.isFinite(cents) || cents < 40000) {
      return res.status(400).json({ msg: "Amount must be at least $400." });
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
 * Creates (or reuses) a PaymentIntent to fund escrow for this case.
 * Attorney (owner) or admin only.
 * Optional header: x-idempotency-key
 */
router.post(
  "/intent/:caseId",
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const idem = req.headers["x-idempotency-key"];
    const c = await Case.findById(caseId)
      .populate("paralegal", "firstName lastName email role")
      .populate("jobId", "title practiceArea");
    if (!c) return res.status(404).json({ error: "Case not found" });

    // Only the attorney who owns the case (or admin) can fund escrow
    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can fund escrow" });
    }

    const baseAmount = c.lockedTotalAmount;
    if (!baseAmount || baseAmount < 50) {
      return res.status(400).json({ error: "Escrow amount is not locked. Cannot fund escrow." });
    }
    const attorneyPct = resolveAttorneyFeePct(c);
    const paralegalPct = resolveParalegalFeePct(c);
    const attorneyFee = Math.max(0, Math.round(baseAmount * (attorneyPct / 100)));
    const paralegalFee = Math.max(0, Math.round(baseAmount * (paralegalPct / 100)));
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
    if (c.escrowIntentId) {
      const existing = await stripe.paymentIntents.retrieve(c.escrowIntentId);
      if (existing && !["succeeded", "canceled"].includes(existing.status)) {
        const amountMatches = existing.amount === amountToCharge;
        const tgMatches = existing.transfer_group && existing.transfer_group === transferGroup;
        if (!amountMatches || !tgMatches) {
          return res.status(400).json({
            error: "Existing escrow intent does not match locked amount. Please cancel and retry.",
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
    }

    // Create a fresh PI
    const intent = await stripe.paymentIntents.create(
      {
        amount: amountToCharge, // cents
        currency: c.currency || "usd",
        automatic_payment_methods: { enabled: true },
        transfer_group: transferGroup, // important for later Connect transfer
        metadata: paymentMetadata,
        description,
      },
      idem ? { idempotencyKey: idem } : undefined
    );

    c.escrowIntentId = intent.id;
    if (!Number.isFinite(c.feeAttorneyPct)) c.feeAttorneyPct = attorneyPct;
    if (!Number.isFinite(c.feeAttorneyAmount)) c.feeAttorneyAmount = attorneyFee;
    if (!Number.isFinite(c.feeParalegalPct)) c.feeParalegalPct = paralegalPct;
    if (!Number.isFinite(c.feeParalegalAmount)) c.feeParalegalAmount = paralegalFee;
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
 * Confirms escrow funding after client-side Stripe confirmation.
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
    if (!c) return res.status(404).json({ error: "Case not found" });

    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can confirm escrow" });
    }
    if (!c.escrowIntentId) {
      return res.status(400).json({ error: "No escrow payment intent found." });
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(c.escrowIntentId, {
        expand: ["charges.data.balance_transaction"],
      });
    } catch (err) {
      console.error("[payments] confirm intent lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to verify escrow funding." });
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

    await applyPaymentIntentSnapshot(c, pi, { notifyOnSuccess: true });

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
    if (!c) return res.status(404).json({ error: "Case not found" });

    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can reconcile this case" });
    }

    const intentId = c.escrowIntentId || c.paymentIntentId;
    if (!intentId) {
      return res.status(400).json({ error: "No payment intent found for this case" });
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(intentId, {
        expand: ["charges.data.balance_transaction"],
      });
    } catch (err) {
      console.error("[payments] reconcile retrieve failed", err?.message || err);
      return res.status(502).json({ error: "Unable to load payment intent" });
    }

    await applyPaymentIntentSnapshot(c, pi, { notifyOnSuccess: true });

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
    });
  })
);

/**
 * POST /api/payments/release/:caseId
 * Marks funds as released (accounting snapshot). To actually move money to a paralegal,
 * use the /payout route (Stripe Connect transfer).
 */
router.post(
  "/release/:caseId",
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Funds are released only via case completion." });
    }
    const c = await Case.findById(req.params.caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });
    const existingPayout = await Payout.findOne({ caseId: c._id })
      .select("amountPaid transferId")
      .lean();
    if (c.paymentReleased || existingPayout || c.payoutTransferId) {
      return res.json({
        ok: true,
        alreadyReleased: true,
        payout: existingPayout?.amountPaid,
        transferId: existingPayout?.transferId || c.payoutTransferId || null,
      });
    }
    return res.status(400).json({ error: "Funds are released only via case completion." });
    const finalCase = isFinalCaseDoc(c);
    if (finalCase && !(req.user.role === "admin" && hasActiveDispute(c))) {
      return res.status(400).json({ error: "Completed cases cannot be released outside dispute resolution." });
    }

    const attorneyRef = resolveAttorneyId(c);
    if (attorneyRef && String(attorneyRef) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can release funds" });
    }
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });
    if (c.paymentReleased) return res.status(400).json({ error: "Already released" });

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    } catch (err) {
      console.error("[payments] release lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to verify escrow funding." });
    }
    if (pi.status !== "succeeded") return res.status(400).json({ error: "Escrow not captured yet" });

    const base = c.lockedTotalAmount ?? c.totalAmount;
    const attorneyFee = Math.max(0, Math.round((base * resolveAttorneyFeePct(c)) / 100));
    const paralegalFee = Math.max(0, Math.round((base * resolveParalegalFeePct(c)) / 100));
    if (!Number.isFinite(c.feeAttorneyPct)) c.feeAttorneyPct = resolveAttorneyFeePct(c);
    if (!Number.isFinite(c.feeAttorneyAmount)) c.feeAttorneyAmount = attorneyFee;
    if (!Number.isFinite(c.feeParalegalPct)) c.feeParalegalPct = resolveParalegalFeePct(c);
    if (!Number.isFinite(c.feeParalegalAmount)) c.feeParalegalAmount = paralegalFee;
    const payout = Math.max(0, base - paralegalFee);

    c.paymentReleased = true;
    if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed") && c.status === "completed") {
      c.transitionTo?.("closed");
    } else if (c.status === "completed") {
      c.status = "closed";
    }
    await c.save();

    await AuditLog.logFromReq(req, "payment.release", {
      targetType: "payment",
      targetId: c.escrowIntentId,
      caseId: c._id,
      meta: { payout, feeA: c.feeAttorneyAmount, feeP: c.feeParalegalAmount },
    });

    res.json({ ok: true, msg: "Funds marked released", payout, feeA: c.feeAttorneyAmount, feeP: c.feeParalegalAmount });
  })
);

/**
 * POST /api/payments/payout/:caseId
 * Optional: Create a Stripe Connect transfer to the paralegal's connected account.
 * Requires: paralegal with stripeAccountId, succeeded PI, and release step completed.
 * Admin-only for now (relax later if desired).
 */
router.post(
  "/payout/:caseId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const c = await Case.findById(req.params.caseId).populate(
      "paralegal",
      "stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled firstName lastName email role"
    );
    if (!c) return res.status(404).json({ error: "Case not found" });
    const existingPayout = await Payout.findOne({ caseId: c._id })
      .select("amountPaid transferId")
      .lean();
    if (c.paymentReleased || existingPayout || c.payoutTransferId) {
      return res.json({
        ok: true,
        alreadyReleased: true,
        payout: existingPayout?.amountPaid,
        transferId: existingPayout?.transferId || c.payoutTransferId || null,
      });
    }
    return res.status(400).json({ error: "Payouts are handled via case completion only." });
    const finalCase = isFinalCaseDoc(c);
    if (finalCase && !hasActiveDispute(c)) {
      return res.status(400).json({ error: "Completed cases cannot be released outside dispute resolution." });
    }
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    } catch (err) {
      console.error("[payments] payout intent lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to verify escrow funding." });
    }
    if (pi.status !== "succeeded") return res.status(400).json({ error: "Escrow not captured yet" });

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
          return res.status(400).json({ error: "Paralegal must complete Stripe Connect onboarding before payouts" });
        }
      }
    }

    const base = c.lockedTotalAmount ?? c.totalAmount;
    const feeP = Math.max(0, Math.round((base * resolveParalegalFeePct(c)) / 100));
    const feeA = Math.max(0, Math.round((base * resolveAttorneyFeePct(c)) / 100));
    if (!Number.isFinite(c.feeAttorneyPct)) c.feeAttorneyPct = resolveAttorneyFeePct(c);
    if (!Number.isFinite(c.feeAttorneyAmount)) c.feeAttorneyAmount = feeA;
    if (!Number.isFinite(c.feeParalegalPct)) c.feeParalegalPct = resolveParalegalFeePct(c);
    if (!Number.isFinite(c.feeParalegalAmount)) c.feeParalegalAmount = feeP;
    const payout = Math.max(0, base - feeP);

    let transfer;
    try {
      transfer = await stripe.transfers.create({
        amount: payout,
        currency: c.currency || "usd",
        destination: c.paralegal.stripeAccountId,
        transfer_group: `case_${c._id.toString()}`,
        metadata: { caseId: c._id.toString(), paralegalId: c.paralegal._id.toString() },
      });
    } catch (err) {
      console.error("[payments] payout transfer failed", err?.message || err);
      const message = stripe.sanitizeStripeError(
        err,
        "We couldn't release funds right now. Please try again shortly."
      );
      return res.status(400).json({ error: message });
    }

    c.payoutTransferId = transfer.id;
    c.paidOutAt = new Date();
    await c.save();

    await Payout.updateOne(
      { caseId: c._id },
      {
        $setOnInsert: {
          paralegalId: c.paralegal._id || c.paralegalId,
          caseId: c._id,
          amountPaid: payout,
          transferId: transfer.id,
        },
      },
      { upsert: true }
    ).catch((err) => {
      if (err?.code === 11000) return null;
      throw err;
    });

    await AuditLog.logFromReq(req, "payment.payout.transfer", {
      targetType: "payment",
      targetId: transfer.id,
      caseId: c._id,
      meta: { payout, feeA, feeP, destination: c.paralegal.stripeAccountId },
    });

    try {
      const payoutDisplay = `$${(payout / 100).toFixed(2)}`;
      const link = `case-detail.html?caseId=${encodeURIComponent(c._id)}`;
      const paralegalId = c.paralegal?._id || c.paralegalId || c.paralegal;
      const payload = {
        caseId: c._id,
        caseTitle: c.title || "Case",
        amount: payoutDisplay,
        link,
      };
      const alreadySent = await hasCaseNotification(paralegalId, "payout_released", c, payload);
      if (!alreadySent) {
        await notifyUser(paralegalId, "payout_released", payload, { actorUserId: req.user.id });
      }
    } catch (err) {
      console.warn("[payments] payout notification failed", err?.message || err);
    }

    res.json({ ok: true, msg: "Payout transfer created", transferId: transfer.id, payout });
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
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const { action, disputeId, grossAmountCents } = req.body || {};
    const allowed = new Set(["refund", "release_full", "release_partial"]);
    if (!allowed.has(String(action || ""))) {
      return res.status(400).json({ error: "Invalid dispute action." });
    }

    const c = await Case.findById(caseId).populate(
      "paralegal",
      "stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled firstName lastName email role"
    );
    if (!c) return res.status(404).json({ error: "Case not found" });

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
      return res.status(400).json({ error: "No dispute found for this case." });
    }

    if (!hasActiveDispute(c) && !hasResolvedDispute(c)) {
      return res.status(400).json({ error: "Case does not have an active dispute." });
    }

    const existingPayout = await Payout.findOne({ caseId: c._id })
      .select("amountPaid transferId")
      .lean();
    if (existingPayout || c.payoutTransferId) {
      return res.status(400).json({ error: "Payout already exists for this case." });
    }

    const baseAmount = Number(c.lockedTotalAmount ?? c.totalAmount ?? 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return res.status(400).json({ error: "Case amount is invalid." });
    }

    const disputeKey = String(targetDispute.disputeId || targetDispute._id || "");
    const resolvedAt = new Date();

    if (action === "refund") {
      if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

      let refund = null;
      try {
        refund = await stripe.refunds.create({ payment_intent: c.escrowIntentId });
      } catch (err) {
        if (!isRefundAlreadyProcessed(err)) {
          console.error("[payments] dispute refund failed", err?.message || err);
          const message = stripe.sanitizeStripeError(
            err,
            "We couldn't release funds right now. Please try again shortly."
          );
          return res.status(400).json({ error: message });
        }
        refund = { id: `already_refunded_${Date.now()}`, amount: baseAmount };
      }

      c.paymentReleased = false;
      if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed")) {
        c.transitionTo?.("closed");
      } else {
        c.status = "closed";
      }
      targetDispute.status = "resolved";
      if (c.terminationDisputeId && String(c.terminationDisputeId) === disputeKey) {
        c.terminationStatus = "resolved";
      }
      c.disputeSettlement = {
        action,
        refundAmount: refund?.amount || 0,
        resolvedAt,
        disputeId: disputeKey,
      };
      await c.save();

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
        console.warn("[payments] dispute resolution notification failed", err?.message || err);
      }

      return res.json({ ok: true, refundId: refund.id, refundAmount: refund.amount || 0 });
    }

    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    } catch (err) {
      console.error("[payments] dispute intent lookup failed", err?.message || err);
      return res.status(502).json({ error: "Unable to verify escrow funding." });
    }
    if (pi.status !== "succeeded") {
      return res.status(400).json({ error: "Escrow payment is not ready to release yet." });
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
          return res.status(400).json({ error: "Paralegal must complete Stripe Connect onboarding before payouts" });
        }
      }
    }

    const settlementBase =
      action === "release_partial" ? Number(grossAmountCents) : baseAmount;
    if (!Number.isFinite(settlementBase) || settlementBase <= 0) {
      return res.status(400).json({ error: "Settlement amount is invalid." });
    }
    if (settlementBase > baseAmount) {
      return res.status(400).json({ error: "Settlement amount exceeds escrow." });
    }

    const feeParalegalPct = resolveParalegalFeePct(c);
    const feeAttorneyPct = resolveAttorneyFeePct(c);
    const paralegalFee = Math.max(0, Math.round((settlementBase * feeParalegalPct) / 100));
    const attorneyFee = Math.max(0, Math.round((settlementBase * feeAttorneyPct) / 100));
    const payout = Math.max(0, settlementBase - paralegalFee);
    if (payout <= 0) {
      return res.status(400).json({ error: "Calculated payout must be positive." });
    }

    let refund = null;
    if (action === "release_partial") {
      const originalAttorneyFee = Math.max(0, Math.round((baseAmount * feeAttorneyPct) / 100));
      const refundAmount = Math.max(
        0,
        Math.round((baseAmount + originalAttorneyFee) - (settlementBase + attorneyFee))
      );
      if (refundAmount > 0) {
        try {
          refund = await stripe.refunds.create({
            payment_intent: c.escrowIntentId,
            amount: refundAmount,
          });
        } catch (err) {
          if (!isRefundAlreadyProcessed(err)) {
            console.error("[payments] dispute partial refund failed", err?.message || err);
            const message = stripe.sanitizeStripeError(
              err,
              "We couldn't release funds right now. Please try again shortly."
            );
            return res.status(400).json({ error: message });
          }
          refund = { id: `already_refunded_${Date.now()}`, amount: refundAmount };
        }
      }
    }

    let transfer;
    if (bypassPayouts) {
      transfer = { id: `bypass_${Date.now()}` };
    } else {
      try {
        transfer = await stripe.transfers.create({
          amount: payout,
          currency: c.currency || "usd",
          destination: c.paralegal.stripeAccountId,
          transfer_group: `case_${c._id.toString()}`,
          metadata: {
            caseId: c._id.toString(),
            disputeId: disputeKey,
            action,
          },
        });
      } catch (err) {
        console.error("[payments] dispute payout transfer failed", err?.message || err);
        const message = stripe.sanitizeStripeError(
          err,
          "We couldn't release funds right now. Please try again shortly."
        );
        return res.status(400).json({ error: message });
      }
    }

    c.paymentReleased = true;
    c.payoutTransferId = transfer.id;
    c.paidOutAt = resolvedAt;
    c.completedAt = c.completedAt || resolvedAt;
    targetDispute.status = "resolved";
    if (c.terminationDisputeId && String(c.terminationDisputeId) === disputeKey) {
      c.terminationStatus = "resolved";
    }
    if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed")) {
      c.transitionTo?.("closed");
    } else {
      c.status = "closed";
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
      resolvedAt,
      disputeId: disputeKey,
    };
    await c.save();

    await Payout.updateOne(
      { caseId: c._id },
      {
        $setOnInsert: {
          paralegalId: c.paralegal._id || c.paralegalId,
          caseId: c._id,
          amountPaid: payout,
          transferId: transfer.id,
        },
      },
      { upsert: true }
    ).catch((err) => {
      if (err?.code === 11000) return null;
      throw err;
    });

    const existingIncome = await PlatformIncome.findOne({ caseId: c._id }).select("_id").lean();
    if (!existingIncome) {
      const attorneyObjectId = c.attorney?._id || c.attorneyId || c.attorney;
      const paralegalObjectId = c.paralegal?._id || c.paralegalId || c.paralegal;
      if (attorneyObjectId && paralegalObjectId) {
        await PlatformIncome.create({
          caseId: c._id,
          attorneyId: attorneyObjectId,
          paralegalId: paralegalObjectId,
          feeAmount: Math.max(0, attorneyFee + paralegalFee),
        }).catch((err) => {
          if (err?.code === 11000) return null;
          throw err;
        });
      }
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
      console.warn("[payments] dispute resolution notification failed", err?.message || err);
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

/**
 * POST /api/payments/refund/:caseId
 * Issues a full refund (admin only).
 */
router.post(
  "/refund/:caseId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const c = await Case.findById(req.params.caseId).select(
      "status paymentReleased escrowIntentId terminationStatus disputes"
    );
    if (!c) return res.status(404).json({ error: "Case not found" });
    if (!hasResolvedDispute(c)) {
      return res.status(400).json({ error: "Refunds require admin-approved dispute resolution." });
    }
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

    const refund = await stripe.refunds.create({ payment_intent: c.escrowIntentId });

    c.paymentReleased = false;
    if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed")) {
      c.transitionTo?.("closed");
    } else {
      c.status = "closed";
    }
    await c.save();

    await AuditLog.logFromReq(req, "payment.refund", {
      targetType: "payment",
      targetId: c._id,
      caseId: c._id,
      meta: { refundId: refund.id, externalRef: c.escrowIntentId },
    });

    res.json({ ok: true, msg: "Refund issued", refundId: refund.id });
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
      caseName: doc.title || doc.caseTitle || "Case",
      paralegalName: doc.paralegal ? fullName(doc.paralegal) : "",
      paralegal: doc.paralegal || null,
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
          caseName: doc.title || doc.caseTitle || "Case",
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
        "title lockedTotalAmount totalAmount feeAttorneyAmount feeAttorneyPct paymentIntentId escrowIntentId payoutTransferId paidOutAt completedAt updatedAt attorney attorneyId attorneyNameSnapshot"
      )
      .populate("attorney", "firstName lastName email role")
      .lean();
    if (!doc) return res.status(404).json({ error: "Case not found" });
    const attorneyId = doc.attorney?._id || doc.attorneyId || doc.attorney;
    if (String(attorneyId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the case attorney can access this receipt." });
    }
    const forceRegen = ["1", "true", "yes"].includes(String(req.query?.regen || "").toLowerCase());
    const paymentMethodLabel = await resolvePaymentMethodLabel(doc);
    const payload = buildAttorneyReceiptPayload(doc, paymentMethodLabel);
    const key = getReceiptKey(doc._id, "attorney");
    const filename = safeReceiptFilename(doc.title, "receipt");
    if (!forceRegen) {
      const streamed = await tryStreamReceipt(res, key, filename);
      if (streamed) return;
    }
    const pdfBuffer = await buildReceiptPdfBuffer(payload);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
    if (S3_BUCKET) {
      uploadPdfToS3({ key, buffer: pdfBuffer }).catch((err) => {
        console.warn("[payments] receipt upload failed", err?.message || err);
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
        "title lockedTotalAmount totalAmount feeAttorneyAmount feeAttorneyPct payoutTransferId paidOutAt completedAt updatedAt paralegal paralegalId paralegalNameSnapshot attorney attorneyId attorneyNameSnapshot"
      )
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role")
      .lean();
    if (!doc) return res.status(404).json({ error: "Case not found" });
    const paralegalId = doc.paralegal?._id || doc.paralegalId || doc.paralegal;
    if (String(paralegalId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the assigned paralegal can access this receipt." });
    }
    const forceRegen = ["1", "true", "yes"].includes(String(req.query?.regen || "").toLowerCase());
    const payoutDoc = await Payout.findOne({ caseId: doc._id }).select("amountPaid transferId").lean();
    const payload = buildParalegalReceiptPayload(doc, payoutDoc);
    const key = getReceiptKey(doc._id, "paralegal");
    const filename = safeReceiptFilename(doc.title, "payout-receipt");
    if (!forceRegen) {
      const streamed = await tryStreamReceipt(res, key, filename);
      if (streamed) return;
    }
    const pdfBuffer = await buildReceiptPdfBuffer(payload);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
    if (S3_BUCKET) {
      uploadPdfToS3({ key, buffer: pdfBuffer }).catch((err) => {
        console.warn("[payments] payout receipt upload failed", err?.message || err);
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
      "Case Name",
      "Paralegal",
      "Job Amount (USD)",
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
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
