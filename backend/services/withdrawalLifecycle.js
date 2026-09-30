"use strict";

const Case = require("../models/Case");
const mongoose = require("mongoose");
const Job = require("../models/Job");
const User = require("../models/User");
const { buildReceiptPdfBuffer, uploadPdfToS3 } = require("./caseLifecycle");
const { DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT } = require("./platformFeePolicy");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
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
  const retainedId = paralegalId?._id || paralegalId;
  const suffix = safeKind === "paralegal" && retainedId
    ? `paralegal-${String(retainedId)}`
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

async function markPostingSynced(caseDoc, jobId, session = null) {
  const values = {
    postingSyncStatus: "synced",
    postingSyncedAt: new Date(),
    postingSyncError: "",
  };
  if (jobId) values.jobId = jobId;
  await Case.updateOne({ _id: caseDoc._id }, { $set: values }, { session });
}

async function ensureCaseJobOpen(caseDoc, { session = null } = {}) {
  if (!caseDoc) return null;
  if (session && !session.inTransaction()) throw new Error("Posting synchronization requires an active transaction.");
  const postingSource = session ? await Case.collection.findOne({ _id: caseDoc._id }, { session }) : caseDoc;
  if (!postingSource) throw new Error("The Matter posting source is unavailable.");
  let jobId = resolveCaseJobId(postingSource);
  if (session) {
    const id = value => String(value?._id || value || "");
    const ownerId = id(postingSource.attorneyId || postingSource.attorney);
    const postingId = id(jobId);
    if (postingId && !mongoose.isObjectIdOrHexString(postingId)) throw Object.assign(new Error("The Matter posting could not be verified. Refresh before withdrawing."), { status: 409, code: "WITHDRAWAL_POSTING_CONFLICT" });
    const related = await Job.collection.find({ $or: [{ caseId: { $in: [caseDoc._id, String(caseDoc._id)] } }, ...(postingId ? [{ _id: new mongoose.Types.ObjectId(postingId) }] : [])] }, { session }).limit(3).toArray();
    if (postingSource.job && postingSource.jobId && id(postingSource.job) !== id(postingSource.jobId)
      || postingSource.attorney && postingSource.attorneyId && id(postingSource.attorney) !== id(postingSource.attorneyId)
      || related.length > 1 || jobId && !related.length
      || related.some(job => id(job.attorneyId) !== ownerId || job.caseId && id(job.caseId) !== id(caseDoc._id))) {
      throw Object.assign(new Error("The Matter posting changed. Refresh before withdrawing."), { status: 409, code: "WITHDRAWAL_POSTING_CONFLICT" });
    }
    if (!jobId && related.length === 1) jobId = related[0]._id;
  }
  if (jobId) {
    const reopened = await Job.findByIdAndUpdate(jobId, { status: "open" }, { session });
    if (!reopened) {
      const error = new Error(`Unable to reopen missing Matter posting ${String(jobId)}`);
      if (!session) await markPostingReconciliation(caseDoc, error);
      throw error;
    }
    await markPostingSynced(caseDoc, session ? jobId : null, session);
    return jobId;
  }

  const existingQuery = Job.findOne({ caseId: caseDoc._id });
  const existing = await (session ? existingQuery.session(session) : existingQuery);
  if (existing) {
    existing.status = "open";
    await existing.save({ session });
    caseDoc.jobId = existing._id;
    await markPostingSynced(caseDoc, existing._id, session);
    return existing._id;
  }

  const attorneyId = caseDoc.attorneyId || caseDoc.attorney;
  const attorneyQuery = attorneyId ? User.findById(attorneyId).select("state") : null;
  const attorneyProfile = await (session && attorneyQuery ? attorneyQuery.session(session) : attorneyQuery);
  const attorneyState = String(attorneyProfile?.state || "").trim().toUpperCase();
  const budgetCents = resolveRemainingAmount(caseDoc) ?? caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0;
  const budgetDollars = Math.max(1, Math.round(Number(budgetCents || 0) / 100));
  let job = null;
  try {
    const values = {
      caseId: caseDoc._id,
      attorneyId,
      title: caseDoc.title || "Untitled Matter",
      practiceArea: caseDoc.practiceArea || "",
      description: caseDoc.details || caseDoc.briefSummary || "Matter details",
      budget: budgetDollars,
      status: "open",
      state: attorneyState,
      locationState: attorneyState,
    };
    job = session ? (await Job.create([values], { session }))[0] : await Job.create(values);
  } catch (error) {
    if (session) throw error;
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
    if (!session) await markPostingReconciliation(caseDoc, error);
    throw error;
  }
  caseDoc.jobId = job._id;
  await markPostingSynced(caseDoc, job._id, session);
  return job._id;
}

function isExpiredWithdrawalEligible(caseDoc, now) {
  if (!caseDoc?.disputeDeadlineAt || caseDoc.payoutFinalizedAt || caseDoc.withdrawalClaimStatus || caseDoc.withdrawalClaimToken) return false;
  if (now.getTime() < new Date(caseDoc.disputeDeadlineAt).getTime()) return false;
  if (String(caseDoc.status || "").toLowerCase() === "disputed") return false;
  return !(Array.isArray(caseDoc.disputes) && caseDoc.disputes.some(
    (dispute) => String(dispute?.status || "").toLowerCase() === "open"
  ));
}

async function completeExpiredWithdrawalSideEffects(caseDoc) {
  try {
    await generateWithdrawalReceipts(caseDoc, { grossAmount: 0 });
  } catch (error) {
    logger.warn("Withdrawal receipt generation failed.", error?.message || error);
  }
}

async function finalizeExpiredDisputeWindow(caseDoc, { now = new Date() } = {}) {
  if (!isExpiredWithdrawalEligible(caseDoc, now)) return false;
  const result = await require("./attorneyWithdrawal").expire(caseDoc._id, { now });
  if (result.changed && !result.recovered) {
    await completeExpiredWithdrawalSideEffects(result.doc);
    publishCaseProjectionRefresh(result.doc, "matter_withdrawal_expired_refresh", { additionalUserIds: [result.doc.withdrawnParalegalId], discovery: true });
  }
  // Callers refresh their projection; they must not save their earlier document.
  return true;
}

async function processExpiredWithdrawalWindows({ now = new Date(), limit = DEFAULT_BATCH_LIMIT } = {}) {
  const candidates = await Case.find({
    pausedReason: "paralegal_withdrew",
    disputeDeadlineAt: { $lte: now },
    payoutFinalizedAt: null,
    withdrawalClaimStatus: { $nin: ["claimed", "needs_reconciliation"] },
    withdrawalClaimToken: { $in: [null, ""] },
    status: "paused",
    archived: { $ne: true }, readOnly: { $ne: true }, purgedAt: null, paymentReleased: { $ne: true },
    paralegal: null, paralegalId: null, partialPayoutAmount: { $in: [null, 0] },
    hiringClaimStatus: { $in: [null, ""] }, hiringClaimToken: { $in: [null, ""] },
    completionClaimStatus: { $in: [null, ""] }, completionClaimToken: { $in: [null, ""] },
    payoutStatus: { $nin: ["failed", "reversed", "needs_reconciliation"] },
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
      const result = await require("./attorneyWithdrawal").expire(candidate._id, { now });
      if (!result.changed) continue;
      if (!result.recovered) {
        await completeExpiredWithdrawalSideEffects(result.doc);
        publishCaseProjectionRefresh(result.doc, "matter_withdrawal_expired_refresh", { additionalUserIds: [result.doc.withdrawnParalegalId], discovery: true });
      }
      summary.finalized += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error("Withdrawal expiry finalization failed.", error?.message || error);
    }
  }
  return summary;
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
      const result = await require("./matterReviewNotifications").remindOverdue(candidate._id, { now });
      if (!result.changed) continue;
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
