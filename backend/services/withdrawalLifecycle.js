"use strict";

const Case = require("../models/Case");
const Job = require("../models/Job");
const User = require("../models/User");
const { buildReceiptPdfBuffer, uploadPdfToS3 } = require("./caseLifecycle");
const { DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT } = require("./platformFeePolicy");
const { notifyUser } = require("../utils/notifyUser");
const { createLogger, logPromiseFailure } = require("../utils/logger");

const logger = createLogger("services:withdrawalLifecycle");
const DEFAULT_BATCH_LIMIT = 100;

function normalizeBatchLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_LIMIT;
  return Math.min(parsed, DEFAULT_BATCH_LIMIT);
}

function resolveCaseJobId(caseDoc) {
  const raw = caseDoc?.jobId || caseDoc?.job || null;
  if (!raw) return null;
  return typeof raw === "object" ? raw._id || raw.id || raw : raw;
}

function resolveRemainingAmount(caseDoc) {
  if (!caseDoc) return null;
  if (Number.isFinite(caseDoc.remainingAmount)) return caseDoc.remainingAmount;
  const base = Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
  if (!Number.isFinite(base) || base <= 0) return null;
  const paid = Number(caseDoc.partialPayoutAmount ?? 0);
  if (!Number.isFinite(paid) || paid <= 0) return base;
  return Math.max(0, Math.round(base - paid));
}

function formatCurrency(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents) || cents <= 0) return "$0.00";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildPersonDisplay(user, fallback) {
  const name = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  return name || fallback || "";
}

function computeParalegalFeeFromGross(grossCents, caseDoc) {
  const gross = Math.max(0, Math.round(Number(grossCents || 0)));
  const feePct = Number.isFinite(caseDoc?.feeParalegalPct)
    ? caseDoc.feeParalegalPct
    : DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;
  const feeAmount = Math.max(0, Math.round((gross * (Number(feePct) || 0)) / 100));
  return { gross, feePct, feeAmount, net: Math.max(0, gross - feeAmount) };
}

function getWithdrawalReceiptKey(caseId, kind, paralegalId) {
  const safeKind = kind === "paralegal" ? "paralegal" : "attorney";
  const suffix = safeKind === "paralegal" && paralegalId
    ? `paralegal-${String(paralegalId)}`
    : safeKind;
  return `cases/${caseId}/receipt-withdrawal-${suffix}.pdf`;
}

async function generateWithdrawalReceipts(caseDoc, { grossAmount } = {}) {
  if (!caseDoc?._id) return;
  const { gross, feePct, feeAmount, net } = computeParalegalFeeFromGross(grossAmount, caseDoc);
  const issuedAt = caseDoc.payoutFinalizedAt || new Date();
  const attorneyName =
    caseDoc.attorneyNameSnapshot ||
    buildPersonDisplay(caseDoc.attorney, "") ||
    buildPersonDisplay(caseDoc.attorneyId, "Attorney") ||
    "Attorney";
  const paralegalName =
    caseDoc.paralegalNameSnapshot ||
    buildPersonDisplay(caseDoc.paralegal, "") ||
    buildPersonDisplay(caseDoc.paralegalId, "Paralegal") ||
    "Paralegal";

  const receiptId = `${caseDoc._id}-withdrawal-${new Date(issuedAt).getTime()}`;
  const attorneyPayload = {
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
  };
  const paralegalPayload = {
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
  };

  const paralegalId = caseDoc.withdrawnParalegalId || caseDoc.paralegalId || caseDoc.paralegal || "";
  const attorneyKey = getWithdrawalReceiptKey(caseDoc._id, "attorney");
  const paralegalKey = getWithdrawalReceiptKey(caseDoc._id, "paralegal", paralegalId);
  const [attorneyPdf, paralegalPdf] = await Promise.all([
    buildReceiptPdfBuffer(attorneyPayload),
    buildReceiptPdfBuffer(paralegalPayload),
  ]);
  await Promise.all([
    uploadPdfToS3({ key: attorneyKey, buffer: attorneyPdf }),
    uploadPdfToS3({ key: paralegalKey, buffer: paralegalPdf }),
  ]);
}

async function markPostingReconciliation(caseDoc, error) {
  await Case.updateOne(
    { _id: caseDoc._id },
    {
      $set: {
        postingSyncStatus: "needs_reconciliation",
        postingSyncedAt: null,
        postingSyncError: String(error?.message || error).slice(0, 1000),
      },
    }
  ).catch(logPromiseFailure(logger, "Withdrawal posting reconciliation marker failed.", {
    caseId: caseDoc?._id,
  }));
}

async function markPostingSynced(caseDoc, jobId) {
  const values = {
    postingSyncStatus: "synced",
    postingSyncedAt: new Date(),
    postingSyncError: "",
  };
  if (jobId) values.jobId = jobId;
  await Case.updateOne({ _id: caseDoc._id }, { $set: values });
}

async function ensureCaseJobOpen(caseDoc) {
  if (!caseDoc) return null;
  const jobId = resolveCaseJobId(caseDoc);
  if (jobId) {
    const reopened = await Job.findByIdAndUpdate(jobId, { status: "open" });
    if (!reopened) {
      const error = new Error(`Unable to reopen missing Matter posting ${String(jobId)}`);
      await markPostingReconciliation(caseDoc, error);
      throw error;
    }
    await markPostingSynced(caseDoc);
    return jobId;
  }

  const existing = await Job.findOne({ caseId: caseDoc._id });
  if (existing) {
    existing.status = "open";
    await existing.save();
    caseDoc.jobId = existing._id;
    await markPostingSynced(caseDoc, existing._id);
    return existing._id;
  }

  const attorneyId = caseDoc.attorneyId || caseDoc.attorney;
  const attorneyProfile = attorneyId ? await User.findById(attorneyId).select("state") : null;
  const attorneyState = String(attorneyProfile?.state || "").trim().toUpperCase();
  const budgetCents = resolveRemainingAmount(caseDoc) ?? caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0;
  const budgetDollars = Math.max(1, Math.round(Number(budgetCents || 0) / 100));
  let job = null;
  try {
    job = await Job.create({
      caseId: caseDoc._id,
      attorneyId,
      title: caseDoc.title || "Untitled Matter",
      practiceArea: caseDoc.practiceArea || "",
      description: caseDoc.details || caseDoc.briefSummary || "Matter details",
      budget: budgetDollars,
      status: "open",
      state: attorneyState,
      locationState: attorneyState,
    });
  } catch (error) {
    if (error?.code !== 11000) {
      await markPostingReconciliation(caseDoc, error);
      throw error;
    }
    job = await Job.findOne({ caseId: caseDoc._id });
    if (job) {
      job.status = "open";
      await job.save();
    }
  }
  if (!job) {
    const error = new Error(`Unable to create or recover Matter posting for Matter ${String(caseDoc._id)}`);
    await markPostingReconciliation(caseDoc, error);
    throw error;
  }
  caseDoc.jobId = job._id;
  await markPostingSynced(caseDoc, job._id);
  return job._id;
}

function buildExpiredWithdrawalState(caseDoc, now) {
  const remainingAmount = resolveRemainingAmount(caseDoc) ?? caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0;
  return {
    partialPayoutAmount: 0,
    payoutFinalizedType: "expired_zero",
    payoutFinalizedAt: now,
    disputeDeadlineAt: null,
    adminDisputeDeadlineAt: null,
    adminDisputeOverdueNotifiedAt: null,
    relistRequestedAt: caseDoc.relistRequestedAt || now,
    relistPending: false,
    remainingAmount: Math.max(0, Math.round(Number(remainingAmount) || 0)),
    pausedReason: "paralegal_withdrew",
    status: "paused",
  };
}

function isExpiredWithdrawalEligible(caseDoc, now) {
  if (!caseDoc?.disputeDeadlineAt || caseDoc.payoutFinalizedAt) return false;
  if (now.getTime() < new Date(caseDoc.disputeDeadlineAt).getTime()) return false;
  if (String(caseDoc.status || "").toLowerCase() === "disputed") return false;
  return !(Array.isArray(caseDoc.disputes) && caseDoc.disputes.some(
    (dispute) => String(dispute?.status || "").toLowerCase() === "open"
  ));
}

async function completeExpiredWithdrawalSideEffects(caseDoc) {
  await ensureCaseJobOpen(caseDoc);
  try {
    await generateWithdrawalReceipts(caseDoc, { grossAmount: 0 });
  } catch (error) {
    logger.warn("Withdrawal receipt generation failed.", error?.message || error);
  }
}

async function finalizeExpiredDisputeWindow(caseDoc, { now = new Date() } = {}) {
  if (!isExpiredWithdrawalEligible(caseDoc, now)) return false;
  Object.assign(caseDoc, buildExpiredWithdrawalState(caseDoc, now));
  if (typeof caseDoc.ensureLifecycleStatus === "function") caseDoc.ensureLifecycleStatus("paused");
  await completeExpiredWithdrawalSideEffects(caseDoc);
  return true;
}

async function processExpiredWithdrawalWindows({ now = new Date(), limit = DEFAULT_BATCH_LIMIT } = {}) {
  const candidates = await Case.find({
    pausedReason: "paralegal_withdrew",
    disputeDeadlineAt: { $lte: now },
    payoutFinalizedAt: null,
    status: { $ne: "disputed" },
    disputes: { $not: { $elemMatch: { status: "open" } } },
  })
    .sort({ disputeDeadlineAt: 1, _id: 1 })
    .limit(normalizeBatchLimit(limit))
    .select(
      "title practiceArea details briefSummary attorney attorneyId withdrawnParalegalId pausedReason status disputeDeadlineAt payoutFinalizedAt payoutFinalizedType partialPayoutAmount remainingAmount lockedTotalAmount totalAmount currency jobId job escrowStatus feeParalegalPct feeAttorneyPct paralegalNameSnapshot attorneyNameSnapshot paralegal paralegalId disputes relistRequestedAt"
    );

  const summary = { scanned: candidates.length, finalized: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const state = buildExpiredWithdrawalState(candidate, now);
      const claimed = await Case.findOneAndUpdate(
        {
          _id: candidate._id,
          pausedReason: "paralegal_withdrew",
          disputeDeadlineAt: { $lte: now },
          payoutFinalizedAt: null,
          status: { $ne: "disputed" },
          disputes: { $not: { $elemMatch: { status: "open" } } },
        },
        { $set: state },
        { returnDocument: "after", runValidators: true }
      );
      if (!claimed) continue;
      await completeExpiredWithdrawalSideEffects(claimed);
      summary.finalized += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error("Withdrawal expiry finalization failed.", error?.message || error);
    }
  }
  return summary;
}

async function notifyAdminReviewOverdue(caseDoc) {
  const basePayload = {
    caseId: caseDoc._id,
    caseTitle: caseDoc.title || "Untitled Matter",
    message: "Our team is still reviewing this request and will follow up when the review is complete.",
  };
  const attorneyId = caseDoc.attorney?._id || caseDoc.attorneyId || caseDoc.attorney || null;
  const withdrawnId = caseDoc.withdrawnParalegalId && typeof caseDoc.withdrawnParalegalId === "object"
    ? caseDoc.withdrawnParalegalId._id
    : caseDoc.withdrawnParalegalId || null;
  if (attorneyId) {
    await notifyUser(attorneyId, "admin_review_overdue", {
      ...basePayload,
      link: "dashboard-attorney.html#cases",
    });
  }
  if (withdrawnId) {
    await notifyUser(withdrawnId, "admin_review_overdue", {
      ...basePayload,
      link: "dashboard-paralegal.html#cases",
    });
  }
}

async function processAdminOverdueDisputes({ now = new Date(), limit = DEFAULT_BATCH_LIMIT } = {}) {
  const candidates = await Case.find({
    adminDisputeDeadlineAt: { $lte: now },
    adminDisputeOverdueNotifiedAt: null,
    status: "disputed",
    pausedReason: "dispute",
  })
    .sort({ adminDisputeDeadlineAt: 1, _id: 1 })
    .limit(normalizeBatchLimit(limit))
    .select("title attorney attorneyId withdrawnParalegalId adminDisputeDeadlineAt adminDisputeOverdueNotifiedAt");

  const summary = { scanned: candidates.length, notified: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const claimed = await Case.findOneAndUpdate(
        {
          _id: candidate._id,
          adminDisputeDeadlineAt: { $lte: now },
          adminDisputeOverdueNotifiedAt: null,
          status: "disputed",
          pausedReason: "dispute",
        },
        { $set: { adminDisputeOverdueNotifiedAt: now } },
        { returnDocument: "after" }
      );
      if (!claimed) continue;
      try {
        await notifyAdminReviewOverdue(claimed);
      } catch (error) {
        await Case.updateOne(
          { _id: claimed._id, adminDisputeOverdueNotifiedAt: now },
          { $set: { adminDisputeOverdueNotifiedAt: null } }
        ).catch(logPromiseFailure(logger, "Admin dispute notification claim rollback failed.", {
          caseId: claimed._id,
        }));
        throw error;
      }
      summary.notified += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error("Admin overdue notification failed.", error?.message || error);
    }
  }
  return summary;
}

module.exports = {
  ensureCaseJobOpen,
  finalizeExpiredDisputeWindow,
  generateWithdrawalReceipts,
  processAdminOverdueDisputes,
  processExpiredWithdrawalWindows,
};
