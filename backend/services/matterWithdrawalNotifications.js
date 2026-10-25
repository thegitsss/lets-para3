const mongoose = require("mongoose");
const Notice = require("../models/MatterWithdrawalNotification");
const User = require("../models/User"), Case = require("../models/Case");
const Job = require("../models/Job");
const { caseNotificationAccess } = require("./notificationPresentation");
const id = value => String(value?._id || value || "");
const same = (a, b) => Boolean(id(a) && id(a) === id(b));
const approved = (user, role) => user?.role === role && user.status === "approved" && !user.deleted && !user.disabled && !user.suspended;
const sameDate = (a, b) => Boolean(a && b && Number.isFinite(new Date(a).getTime()) && new Date(a).getTime() === new Date(b).getTime());
const decisionKinds = new Set(["partial", "reject", "relist", "expired"]);
const { decisions: finalizedTypes } = require("./attorneyReceiptHistory");

function withdrawalSummary(outcome, role) {
  if (outcome === "review_window") return role === "attorney"
    ? "Release was declined. The paralegal's payment-review window is open; its deadline is shown in the Matter."
    : "Release was declined. You can request payment review before the deadline shown in Matter history.";
  if (outcome === "zero_recorded") return "No payout was recorded for this withdrawal.";
  if (outcome === "partial_recorded") return role === "attorney"
    ? "Review the payout and remaining balance in Matter Financials."
    : "Review the payment details in Matter history.";
  if (outcome === "relisted") return role === "attorney"
    ? "The remaining work is open for replacement applications."
    : "This Matter was reopened for a replacement paralegal. Your withdrawal decision remains in Matter history.";
  if (outcome === "expired_zero") return "The payment-review window ended without a review request. No payout was issued for this withdrawal.";
  if (outcome === "zero_auto") return role === "attorney"
    ? "The paralegal withdrew before completing any tasks. No payout is due, and the Matter is open for another paralegal."
    : "You withdrew before completing any tasks. No payout is due.";
  return role === "attorney"
    ? "The paralegal withdrew. Review the completed work and choose a partial payout or close without release."
    : "You withdrew from this Matter. The attorney's payout decision is pending.";
}

function withdrawalEventSummary(outcome) {
  if (outcome === "review_window") return "Release was declined and a payment-review window was opened.";
  if (outcome === "relisted") return "The remaining work was reopened for replacement applications.";
  if (outcome === "partial_recorded") return "A withdrawal payout decision was recorded.";
  return withdrawalSummary(outcome);
}

function currentWithdrawal(matter, notice) {
  if (!matter || matter.status !== "paused" || matter.pausedReason !== "paralegal_withdrew"
    || matter.paralegal || matter.paralegalId || matter.archived || matter.purgedAt || matter.paymentReleased
    || matter.withdrawalClaimStatus || matter.withdrawalClaimToken || matter.hiringClaimToken
    || !same(matter.attorney || matter.attorneyId, notice.attorneyId)
    || matter.attorney && matter.attorneyId && !same(matter.attorney, matter.attorneyId)
    || !same(matter.withdrawnParalegalId, notice.paralegalId)
    || !sameDate(matter.pausedAt, notice.withdrawnAt)) return false;
  const kind = notice.kind || "request";
  if (kind !== "request") {
    if (!decisionKinds.has(kind) || matter.readOnly || matter.hiringClaimStatus || matter.completionClaimStatus || matter.completionClaimToken
      || (matter.disputes || []).some(item => String(item.status || "open").toLowerCase() === "open")) return false;
    if (kind === "reject") return notice.outcome === "review_window" && !matter.payoutFinalizedAt
      && sameDate(matter.disputeDeadlineAt, notice.eventAt) && new Date(matter.disputeDeadlineAt).getTime() > Date.now();
    if (!matter.payoutFinalizedAt || !finalizedTypes.has(matter.payoutFinalizedType) || matter.disputeDeadlineAt) return false;
    if (kind === "relist") return notice.outcome === "relisted" && sameDate(matter.relistRequestedAt, notice.eventAt)
      && Number.isSafeInteger(matter.remainingAmount) && matter.remainingAmount > 0 && matter.postingSyncStatus === "synced";
    if (!sameDate(matter.payoutFinalizedAt, notice.eventAt)) return false;
    if (kind === "expired") return notice.outcome === "expired_zero" && matter.payoutFinalizedType === "expired_zero" && matter.partialPayoutAmount === 0;
    return ["partial_attorney", "admin"].includes(matter.payoutFinalizedType)
      && (notice.outcome === "zero_recorded" ? matter.partialPayoutAmount === 0 : notice.outcome === "partial_recorded" && Number.isSafeInteger(matter.partialPayoutAmount) && matter.partialPayoutAmount > 0);
  }
  if (notice.outcome === "zero_auto") return matter.payoutFinalizedType === "zero_auto" && matter.partialPayoutAmount === 0 && Boolean(matter.relistRequestedAt) && matter.postingSyncStatus === "synced";
  return notice.outcome === "awaiting_attorney_decision" && !matter.payoutFinalizedAt && !matter.disputeDeadlineAt
    && !(matter.disputes || []).some(item => item.status === "open");
}

async function ready() {
  const indexes = await Notice.collection.indexes();
  if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 }))) throw new Error("Withdrawal notification delivery indexes are unavailable.");
}

function sourceNotice(matter, { caseId, userId, kind = "request" }) {
  const outcome = kind === "request" ? matter?.payoutFinalizedType === "zero_auto" ? "zero_auto" : "awaiting_attorney_decision"
    : kind === "reject" ? "review_window" : kind === "relist" ? "relisted" : kind === "expired" ? "expired_zero"
    : matter?.partialPayoutAmount === 0 ? "zero_recorded" : "partial_recorded";
  const eventAt = kind === "request" ? matter?.pausedAt : kind === "reject" ? matter?.disputeDeadlineAt : kind === "relist" ? matter?.relistRequestedAt : matter?.payoutFinalizedAt;
  return { caseId, userId, attorneyId: matter?.attorney || matter?.attorneyId, paralegalId: matter?.withdrawnParalegalId, withdrawnAt: matter?.pausedAt, kind, eventAt, outcome };
}

async function stage({ caseId, userId, kind = "request" }, session) {
  if (!session?.inTransaction()) throw new Error("Withdrawal email requires the withdrawal transaction.");
  await ready();
  const matter = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(id(caseId)) }, { session });
  const values = sourceNotice(matter, { caseId, userId, kind });
  if (!currentWithdrawal(matter, values) || ![id(values.attorneyId), id(values.paralegalId)].includes(id(userId))) throw new Error("Withdrawal notification source could not be verified.");
  await Notice.create([values], { session });
}

async function stageDecision(matter, kind, session, actorUserId = null) {
  if (!decisionKinds.has(kind)) throw new Error("Withdrawal notification decision is unavailable.");
  const dispatches = [];
  const { notifyUser } = require("../utils/notifyUser");
  for (const userId of [matter.attorney || matter.attorneyId, matter.withdrawnParalegalId]) {
    const values = sourceNotice(matter, { caseId: matter._id, userId, kind });
    if (!userId || !currentWithdrawal(matter, values)) throw new Error("Withdrawal notification recipient or decision could not be verified.");
    const dispatch = await notifyUser(userId, "case_update", {
      caseId: id(matter._id), caseTitle: matter.title || "Untitled Matter", outcome: "withdrawal_decision_recorded",
      summary: withdrawalEventSummary(values.outcome),
    }, { session, deferDispatch: true, withdrawalDecision: kind, actorUserId });
    if (typeof dispatch !== "function") throw new Error("Withdrawal notification recipient is unavailable.");
    dispatches.push(dispatch);
  }
  return dispatches;
}

async function prepare(notice) {
  const [matter, user] = await Promise.all([
    Case.collection.findOne({ _id: notice.caseId }),
    User.findById(notice.userId).select("email role status deleted disabled suspended notificationPrefs").lean(),
  ]);
  const role = same(notice.userId, notice.attorneyId) ? "attorney" : "paralegal";
  const { shouldSendEmailForType } = require("../utils/notifyUser");
  if (!approved(user, role) || !currentWithdrawal(matter, notice)
    || role === "paralegal" && !same(notice.userId, notice.paralegalId)
    || !caseNotificationAccess(matter, user, "case_update", new Set(), { type: "case_update", createdAt: notice.withdrawnAt }).allowed
    || !shouldSendEmailForType(user, "case_update")) return null;
  if (["zero_auto", "relisted"].includes(notice.outcome)) {
    if ((matter.jobId || matter.job) && !/^[a-f0-9]{24}$/i.test(id(matter.jobId || matter.job))) return null;
    const jobs = await Job.collection.find({ $or: [{ caseId: { $in: [matter._id, id(matter._id)] } }, ...(matter.jobId || matter.job ? [{ _id: new mongoose.Types.ObjectId(id(matter.jobId || matter.job)) }] : [])] }).limit(2).toArray();
    if (matter.job && matter.jobId && !same(matter.job, matter.jobId) || jobs.length !== 1
      || jobs[0].status !== "open" || !same(jobs[0].attorneyId, notice.attorneyId)
      || jobs[0].caseId && !same(jobs[0].caseId, matter._id)) return null;
  }
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(user.email || "")) throw new Error("Recipient email unavailable.");
  const templates = require("../email/templates"), template = (notice.kind || "request") === "request" ? templates.withdrawalRequest : templates.withdrawalDecision;
  return { to: user.email, ...template({ caseId: id(matter._id), caseTitle: matter.title || "Untitled Matter", role, outcome: notice.outcome, summary: withdrawalSummary(notice.outcome, role) }) };
}

const { processNotices, noticeStatus } = require("./emailNoticeDelivery").createEmailNoticeDelivery({ Notice, prepare, prefix: "withdrawal" });
module.exports = { ready, stage, stageDecision, processNotices, noticeStatus, withdrawalSummary };
