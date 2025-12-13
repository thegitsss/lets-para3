// backend/routes/payments.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const stripe = require("../utils/stripe");
const Case = require("../models/Case");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog"); // match your filename
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const sendEmail = require("../utils/email");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);

const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

const CONNECT_RETURN_URL = process.env.STRIPE_CONNECT_RETURN_URL || "https://yourdomain.com/paralegal/settings?onboarding=success";
const CONNECT_REFRESH_URL = process.env.STRIPE_CONNECT_REFRESH_URL || "https://yourdomain.com/paralegal/settings?onboarding=refresh";
const CONNECT_COUNTRY = process.env.STRIPE_CONNECT_COUNTRY || "US";
const { Types } = mongoose;

const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 15);
const MAX_HISTORY_ROWS = Number(process.env.BILLING_HISTORY_LIMIT || 500);
const MAX_EXPORT_ROWS = Number(process.env.BILLING_EXPORT_LIMIT || 2000);

function trimSlash(value) {
  if (!value) return "";
  return String(value).replace(/\/$/, "");
}

const CLIENT_BASE_URL = trimSlash(process.env.CLIENT_BASE_URL || process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL);
const CHECKOUT_SUCCESS_URL = (process.env.STRIPE_CHECKOUT_SUCCESS_URL || "").trim();
const CHECKOUT_CANCEL_URL = (process.env.STRIPE_CHECKOUT_CANCEL_URL || "").trim();

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

function computePlatformFee(doc = {}) {
  const snap = cents(doc.feeAttorneyAmount);
  if (snap > 0) return snap;
  const pct =
    typeof doc.feeAttorneyPct === "number" && Number.isFinite(doc.feeAttorneyPct)
      ? doc.feeAttorneyPct
      : PLATFORM_FEE_PERCENT;
  return Math.max(0, Math.round(cents(doc.totalAmount) * (pct / 100)));
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
  if (!caseDoc || !cents(caseDoc.totalAmount) || !stripe?.checkout?.sessions) return "";
  const context = buildPaymentContext(caseDoc);
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
            unit_amount: cents(caseDoc.totalAmount),
          },
          quantity: 1,
        },
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
  const jobAmount = cents(doc.totalAmount);
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
  const receiptUrl = extractReceipt(doc);
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

// ----------------------------------------
// PUBLIC: Stripe publishable key for Stripe.js
// GET /api/payments/config
// ----------------------------------------
router.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// Temporary stub for Stripe Connect onboarding
router.get('/connect', (_req, res) => {
  res.json({ ok: true });
});

// All routes below require auth
router.use(verifyToken);
router.param("caseId", ensureCaseParticipant("caseId"));

/**
 * POST /api/payments/portal
 * Creates a Stripe Billing Portal session for the authenticated attorney.
 */
router.post(
  "/portal",
  requireRole(["attorney"]),
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
  requireRole(["attorney"]),
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

    const budgetCents = Number(
      typeof selectedCase.budget === "number" ? selectedCase.budget : selectedCase.totalAmount
    );
    if (!Number.isFinite(budgetCents) || budgetCents < 50) {
      return res.status(400).json({ error: "Case budget must be at least $0.50" });
    }

    const applicationFee = Math.max(0, Math.round(budgetCents * 0.15));
    const context = buildPaymentContext(selectedCase);
    const attorneyMeta =
      selectedCase.attorney && selectedCase.attorney._id
        ? selectedCase.attorney._id
        : selectedCase.attorneyId || selectedCase.attorney;
    const metadata = {
      ...context.metadata,
      attorneyId: attorneyMeta ? String(attorneyMeta) : "",
    };
    const paymentIntent = await stripe.paymentIntents.create({
      amount: budgetCents,
      currency: selectedCase.currency || "usd",
      automatic_payment_methods: { enabled: true },
      application_fee_amount: applicationFee,
      receipt_email: selectedCase.attorney.email,
      metadata,
      description: context.description,
    });

    selectedCase.paymentIntentId = paymentIntent.id;
    if (!selectedCase.escrowIntentId) {
      selectedCase.escrowIntentId = paymentIntent.id;
    }
    await selectedCase.save();

    await AuditLog.logFromReq(req, "payment.intent.start", {
      targetType: "payment",
      targetId: paymentIntent.id,
      caseId: selectedCase._id,
      meta: {
        amount: budgetCents,
        applicationFee,
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
  requireRole(["attorney"]),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.body || {};
    if (!caseId || !isObjId(caseId)) {
      return res.status(400).json({ error: "Valid caseId is required" });
    }

    const c = await Case.findById(caseId)
      .populate("paralegal", "stripeAccountId stripeOnboarded firstName lastName email role")
      .populate("attorney", "firstName lastName email role");
    if (!c) return res.status(404).json({ error: "Case not found" });

    const attorneyRef =
      (c.attorney && c.attorney._id) || c.attorneyId || c.attorney;
    if (String(attorneyRef) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the case attorney can release funds" });
    }

    if (!c.paymentIntentId) {
      return res.status(400).json({ error: "Case has no funded payment intent" });
    }
    if (!c.paralegal || !c.paralegal.stripeAccountId) {
      return res.status(400).json({ error: "Paralegal is not onboarded for payouts" });
    }
    if (!c.paralegal.stripeOnboarded) {
      return res.status(400).json({ error: "Paralegal must complete Stripe Connect onboarding before payouts" });
    }

    const budgetCents = Number(c.totalAmount || 0);
    if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
      return res.status(400).json({ error: "Case budget is missing or invalid" });
    }
    const feeAmount = Math.max(0, Math.round(budgetCents * 0.15));
    const payout = Math.max(0, budgetCents - feeAmount);
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

    const transfer = await stripe.transfers.create({
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
    });

    const completedAt = new Date();
    const paralegalName = `${c.paralegal?.firstName || ""} ${c.paralegal?.lastName || ""}`.trim() || "Paralegal";
    const downloadPaths = (c.files || [])
      .map((file) => {
        if (file.key) return file.key.startsWith("/") ? file.key : `/${file.key}`;
        if (file.filename) return `/uploads/${file.filename}`;
        return null;
      })
      .filter(Boolean);

    c.status = "completed";
    c.completedAt = completedAt;
    c.briefSummary = `${c.title} – ${paralegalName} – completed ${completedAt.toISOString().split("T")[0]}`;
    c.archived = true;
    c.paymentReleased = true;
    c.payoutTransferId = transfer.id;
    c.paidOutAt = completedAt;
    c.downloadUrl = downloadPaths;
    if (Array.isArray(c.applicants)) c.applicants = [];
    if (Array.isArray(c.updates)) c.updates = [];
    await c.save();

    const attorneyObjectId = c.attorney?._id || c.attorneyId || c.attorney;
    const paralegalObjectId = c.paralegal?._id || c.paralegalId || c.paralegal;

    await Promise.all([
      Payout.create({
        paralegalId: paralegalObjectId,
        caseId: c._id,
        amountPaid: payout,
        transferId: transfer.id,
      }),
      PlatformIncome.create({
        caseId: c._id,
        attorneyId: attorneyObjectId,
        paralegalId: paralegalObjectId,
        feeAmount,
      }),
    ]);

    await AuditLog.logFromReq(req, "payment.release.transfer", {
      targetType: "payment",
      targetId: transfer.id,
      caseId: c._id,
      meta: {
        payout,
        feeAmount,
        currency: c.currency || "usd",
        destination: c.paralegal.stripeAccountId,
      },
    });

    const completedDateStr = completedAt.toLocaleDateString("en-US");
    const payoutDisplay = `$${(payout / 100).toFixed(2)}`;
    const feeDisplay = `$${(feeAmount / 100).toFixed(2)}`;
    const totalDisplay = `$${(budgetCents / 100).toFixed(2)}`;

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
         <p>Job amount: ${totalDisplay}<br/>Service fee (15%): ${feeDisplay}<br/>Final payout: <strong>${payoutDisplay}</strong></p>
         <p>Funds have been transferred to your connected Stripe account.</p>`
      ).catch(() => {});
    }

    res.json({ ok: true, payout, transferId: transfer.id });
  })
);

router.post(
  "/connect/create-account",
  requireRole(["paralegal"]),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("email stripeAccountId stripeOnboarded");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.email) return res.status(400).json({ error: "Email is required for Stripe onboarding" });

    if (user.stripeAccountId) {
      return res.json({ ok: true, accountId: user.stripeAccountId });
    }

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
    await user.save();

    res.json({ ok: true, accountId: account.id });
  })
);

router.post(
  "/connect/onboard-link",
  requireRole(["paralegal"]),
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

    const link = await stripe.accountLinks.create({
      account: targetAccount,
      refresh_url: CONNECT_REFRESH_URL,
      return_url: CONNECT_RETURN_URL,
      type: "account_onboarding",
    });

    res.json({ url: link.url });
  })
);

router.get(
  "/connect/status",
  requireRole(["paralegal"]),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("stripeAccountId stripeOnboarded");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.stripeAccountId) {
      return res.json({ details_submitted: false, connected: false, accountId: null });
    }

    try {
      const account = await stripe.accounts.retrieve(user.stripeAccountId);
      const submitted = !!account?.details_submitted;
      if (submitted && !user.stripeOnboarded) {
        user.stripeOnboarded = true;
        await user.save();
      }
      return res.json({ details_submitted: submitted, connected: submitted, accountId: user.stripeAccountId });
    } catch (err) {
      console.error("[connect] status error", err?.message || err);
      return res.json({ details_submitted: false, connected: false, accountId: user.stripeAccountId });
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
    const { caseId } = req.params;
    const { amountUsd, currency } = req.body || {};
    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ msg: "Case not found" });

    if (String(c.attorney) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ msg: "Only the case attorney or admin can update budget" });
    }

    const cents = Math.round(Number(amountUsd || 0) * 100);
    if (!Number.isFinite(cents) || cents < 50) {
      return res.status(400).json({ msg: "Amount must be at least $0.50" });
    }

    c.totalAmount = cents;
    if (currency) c.currency = String(currency).toLowerCase();
    c.snapshotFees?.(); // compute fee snapshots if model helper exists
    await c.save();

    await AuditLog.logFromReq(req, "payment.budget.update", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { totalAmount: c.totalAmount, currency: c.currency },
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
    if (String(c.attorney) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can fund escrow" });
    }

    if (!c.totalAmount || c.totalAmount < 50) {
      return res.status(400).json({ error: "totalAmount (>= $0.50) required on case" });
    }

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
        let pi = existing;
        const canUpdate = ["requires_payment_method", "requires_confirmation"].includes(pi.status);
        const needsTG = !pi.transfer_group || pi.transfer_group !== transferGroup;
        const needsAmt = pi.amount !== c.totalAmount;
        if (canUpdate) {
          pi = await stripe.paymentIntents.update(pi.id, {
            ...(needsTG ? { transfer_group: transferGroup } : {}),
            ...(needsAmt ? { amount: c.totalAmount } : {}),
            metadata: paymentMetadata,
            description,
          });
        }

        await AuditLog.logFromReq(req, "payment.intent.reuse", {
          targetType: "payment",
          targetId: pi.id,
          caseId: c._id,
          meta: { amount: c.totalAmount, currency: c.currency || "usd", status: pi.status },
        });

        return res.json({ clientSecret: pi.client_secret, intentId: pi.id });
      }
    }

    // Create a fresh PI
    const intent = await stripe.paymentIntents.create(
      {
        amount: c.totalAmount, // cents
        currency: c.currency || "usd",
        automatic_payment_methods: { enabled: true },
        transfer_group: transferGroup, // important for later Connect transfer
        metadata: paymentMetadata,
        description,
      },
      idem ? { idempotencyKey: idem } : undefined
    );

    c.escrowIntentId = intent.id;
    await c.save();

    await AuditLog.logFromReq(req, "payment.intent.create", {
      targetType: "payment",
      targetId: intent.id,
      caseId: c._id,
      meta: { amount: c.totalAmount, currency: c.currency || "usd" },
    });

    res.json({ clientSecret: intent.client_secret, intentId: intent.id });
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
    const c = await Case.findById(req.params.caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    if (String(c.attorney) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can release funds" });
    }
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });
    if (c.paymentReleased) return res.status(400).json({ error: "Already released" });

    const pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    if (pi.status !== "succeeded") return res.status(400).json({ error: "Escrow not captured yet" });

    // Compute/snapshot fees
    c.snapshotFees?.();
    if (!c.feeAttorneyAmount || !c.feeParalegalAmount) {
      c.feeAttorneyAmount = Math.round((c.totalAmount * (c.feeAttorneyPct || 15)) / 100);
      c.feeParalegalAmount = Math.round((c.totalAmount * (c.feeParalegalPct || 15)) / 100);
    }
    const payout = Math.max(0, c.totalAmount - c.feeAttorneyAmount - c.feeParalegalAmount);

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
      "stripeAccountId firstName lastName email role"
    );
    if (!c) return res.status(404).json({ error: "Case not found" });
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

    const pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    if (pi.status !== "succeeded") return res.status(400).json({ error: "Escrow not captured yet" });

    if (!c.paralegal || !c.paralegal.stripeAccountId) {
      return res.status(400).json({ error: "Paralegal not onboarded for payouts" });
    }

    // Ensure fees/payout are known
    c.snapshotFees?.();
    const feeA = c.feeAttorneyAmount ?? Math.round((c.totalAmount * (c.feeAttorneyPct || 15)) / 100);
    const feeP = c.feeParalegalAmount ?? Math.round((c.totalAmount * (c.feeParalegalPct || 15)) / 100);
    const payout = Math.max(0, c.totalAmount - feeA - feeP);

    const transfer = await stripe.transfers.create({
      amount: payout,
      currency: c.currency || "usd",
      destination: c.paralegal.stripeAccountId,
      transfer_group: `case_${c._id.toString()}`,
      metadata: { caseId: c._id.toString(), paralegalId: c.paralegal._id.toString() },
    });

    c.payoutTransferId = transfer.id;
    c.paidOutAt = new Date();
    await c.save();

    await AuditLog.logFromReq(req, "payment.payout.transfer", {
      targetType: "payment",
      targetId: transfer.id,
      caseId: c._id,
      meta: { payout, feeA, feeP, destination: c.paralegal.stripeAccountId },
    });

    res.json({ ok: true, msg: "Payout transfer created", transferId: transfer.id, payout });
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
    const c = await Case.findById(req.params.caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });
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
      targetId: c.escrowIntentId,
      caseId: c._id,
      meta: { refundId: refund.id },
    });

    res.json({ ok: true, msg: "Refund issued", refundId: refund.id });
  })
);

router.get(
  "/summary",
  requireRole(["attorney"]),
  asyncHandler(async (req, res) => {
    const attorneyMatch = buildAttorneyMatch(req.user.id);
    const [activeCases, pendingCases, completedDocs] = await Promise.all([
      Case.find({
        ...attorneyMatch,
        escrowIntentId: { $nin: [null, ""] },
        paymentReleased: { $ne: true },
      })
        .select("totalAmount")
        .lean(),
      Case.find({
        ...attorneyMatch,
        paymentReleased: { $ne: true },
        $and: [
          { $or: [{ paralegal: { $ne: null } }, { paralegalId: { $ne: null } }] },
          { $or: [{ escrowIntentId: { $exists: false } }, { escrowIntentId: null }, { escrowIntentId: "" }] },
        ],
      })
        .select("totalAmount")
        .lean(),
      Case.find({
        ...attorneyMatch,
        paymentReleased: true,
      })
        .select("totalAmount feeAttorneyAmount feeAttorneyPct")
        .lean(),
    ]);

    const activeEscrow = activeCases.reduce((sum, c) => sum + cents(c.totalAmount), 0);
    const pendingCharges = pendingCases.reduce((sum, c) => sum + cents(c.totalAmount), 0);
    const completedRecords = completedDocs.map((doc) => ({
      jobAmount: cents(doc.totalAmount),
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
  requireRole(["attorney"]),
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
      amountHeld: cents(doc.totalAmount),
      fundedAt: doc.updatedAt || doc.createdAt || doc.hiredAt || null,
      status: doc.paymentStatus || doc.status || "pending",
    }));
    const total = items.reduce((sum, entry) => sum + entry.amountHeld, 0);
    res.json({ items, total });
  })
);

router.get(
  "/escrow/pending",
  requireRole(["attorney"]),
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
          amountDue: cents(doc.totalAmount),
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
  "/history",
  requireRole(["attorney"]),
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
  requireRole(["attorney"]),
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
