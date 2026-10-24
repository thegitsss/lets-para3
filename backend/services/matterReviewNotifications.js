const mongoose = require("mongoose");
const { reportOperationalFailure } = require("../utils/operationalFailure");
const Notice = require("../models/MatterReviewNotification");
const Case = require("../models/Case"), User = require("../models/User"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout");
const { caseNotificationAccess } = require("./notificationPresentation");
const id = value => String(value?._id || value || "");
const same = (a, b) => Boolean(id(a) && id(a) === id(b));
const sameDate = (a, b) => Boolean(a && b && Number.isFinite(new Date(a).getTime()) && new Date(a).getTime() === new Date(b).getTime());

function currentReview(matter, notice) {
  if (!matter || matter.status !== "disputed" || matter.pausedReason !== "dispute" || matter.purgedAt
    || matter.attorney && matter.attorneyId && !same(matter.attorney, matter.attorneyId)
    || matter.paralegal && matter.paralegalId && !same(matter.paralegal, matter.paralegalId)) return false;
  const matches = (matter.disputes || []).filter(value => id(value.disputeId || value._id) === notice.disputeId);
  return matches.length === 1 && String(matches[0].status || "open").toLowerCase() === "open" && sameDate(matches[0].createdAt, notice.openedAt);
}
function currentOverdue(matter, notice) {
  return currentReview(matter, notice)
    && sameDate(matter.adminDisputeDeadlineAt, notice.deadlineAt)
    && sameDate(matter.adminDisputeOverdueNotifiedAt, notice.remindedAt)
    && new Date(notice.deadlineAt).getTime() <= new Date(notice.remindedAt).getTime()
    && new Date(notice.deadlineAt).getTime() <= Date.now();
}
function currentTermination(matter, notice) {
  return notice.kind === "opened" && notice.userRole === "paralegal" && currentReview(matter, notice)
    && (matter.disputes || []).filter(review => String(review.status || "open").toLowerCase() === "open").length === 1
    && same(notice.userId, matter.paralegal || matter.paralegalId)
    && matter.terminationStatus === "disputed" && matter.terminationDisputeId === notice.disputeId
    && sameDate(matter.terminationRequestedAt, notice.terminationRequestedAt)
    && sameDate(matter.paralegalAccessRevokedAt, notice.accessRevokedAt);
}
function overdueRecipient(matter, userId, role) {
  return role === "attorney" && same(userId, matter.attorney || matter.attorneyId)
    || role === "paralegal" && same(userId, matter.withdrawnParalegalId);
}
function recipient(matter, userId, role) {
  if (role === "admin") return true;
  if (role === "attorney") return same(userId, matter.attorney || matter.attorneyId);
  return role === "paralegal" && [matter.paralegal || matter.paralegalId, matter.withdrawnParalegalId].some(value => same(userId, value));
}
async function ready() {
  const indexes = await Notice.collection.indexes();
  const has = (key, unique = false) => indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) && (!unique || index.unique));
  if (!has({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 }) || !has({ caseId: 1, disputeId: 1, userId: 1, kind: 1 }, true) || has({ caseId: 1, disputeId: 1, userId: 1 }, true)) throw new Error("Review notification delivery indexes are unavailable.");
}
function currentResolution(matter, notice) {
  if (!matter || !["closed", "paused"].includes(matter.status) || matter.purgedAt
    || ["failed", "reversed", "needs_reconciliation"].includes(matter.payoutStatus)
    || matter.status === "paused" && (matter.pausedReason !== "paralegal_withdrew" || matter.paralegal || matter.paralegalId || !matter.withdrawnParalegalId)
    || matter.attorney && matter.attorneyId && !same(matter.attorney, matter.attorneyId)
    || matter.paralegal && matter.paralegalId && !same(matter.paralegal, matter.paralegalId)) return false;
  const matches = (matter.disputes || []).filter(value => id(value.disputeId || value._id) === notice.disputeId);
  const decision = matter.disputeSettlement;
  return matches.length === 1 && matches[0].status === "resolved" && decision?.disputeId === notice.disputeId
    && ["refund", "release_full", "release_partial"].includes(notice.action) && decision.action === notice.action && sameDate(decision.resolvedAt, notice.resolvedAt);
}
async function resolutionOperation(matter, disputeId, session = null, operationId = null) {
  const operation = await Operation.collection.findOne({
    ...(operationId ? { _id: new mongoose.Types.ObjectId(id(operationId)) } : {}),
    caseId: matter._id, kind: "dispute_settlement", operationKey: `dispute_settlement:${id(matter._id)}:${disputeId}`,
    status: "succeeded", evidenceStatus: { $nin: ["quarantined", "needs_reconciliation"] },
  }, { session });
  const decision = matter.disputeSettlement;
  if (!operation || !decision || id(operation.stripeTransferId) !== id(decision.transferId)
    || id(operation.stripeRefundId) !== id(decision.refundId)) return null;
  if (decision.refundId && (operation.refundStatus !== "succeeded" || operation.refundEvidenceStatus !== "verified"
    || !operation.refundVerifiedAt || Number(operation.refundAmount) !== Number(decision.refundAmount))) return null;
  if (decision.transferId) {
    if (Number(operation.transferAmount) !== Number(decision.payoutAmount)) return null;
    const payee = matter.paralegal || matter.paralegalId || matter.withdrawnParalegalId;
    const payout = await Payout.collection.findOne({ caseId: matter._id, operationKey: operation.operationKey,
      transferId: decision.transferId, paralegalId: payee, amountPaid: Number(decision.payoutAmount), status: "paid",
    }, { session });
    if (!payout || payout.reversedAt || payout.failureReason) return null;
  } else if (Number(decision.payoutAmount) > 0) return null;
  return operation;
}
async function stage({ caseId, userId, userRole, disputeId, kind = "opened" }, session) {
  if (!session?.inTransaction()) throw new Error("Review email requires its decision transaction.");
  await ready();
  const matter = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(id(caseId)) }, { session });
  const review = matter?.disputes?.find(value => id(value.disputeId || value._id) === disputeId);
  const values = { caseId, userId, userRole, disputeId, kind, openedAt: review?.createdAt };
  if (kind === "opened" && matter?.terminationDisputeId === disputeId) {
    Object.assign(values, { reviewContext: "termination", terminationRequestedAt: matter.terminationRequestedAt, accessRevokedAt: matter.paralegalAccessRevokedAt });
    if (!currentTermination(matter, values)) throw new Error("Termination review source or recipient could not be verified.");
  }
  if (kind === "resolved") {
    Object.assign(values, { resolvedAt: matter?.disputeSettlement?.resolvedAt, action: matter?.disputeSettlement?.action });
    if (!currentResolution(matter, values) || !["attorney", "paralegal"].includes(userRole)) throw new Error("Review decision source could not be verified.");
    const operation = await resolutionOperation(matter, disputeId, session);
    if (!operation) throw new Error("Review settlement operation could not be verified.");
    values.operationId = operation._id;
  } else if (kind === "overdue") {
    Object.assign(values, { deadlineAt: matter?.adminDisputeDeadlineAt, remindedAt: matter?.adminDisputeOverdueNotifiedAt });
    if (!currentOverdue(matter, values) || !overdueRecipient(matter, userId, userRole)) throw new Error("Overdue review source or recipient could not be verified.");
  } else if (kind !== "opened" || !currentReview(matter, values)) throw new Error("Review notification source could not be verified.");
  if (!recipient(matter, userId, userRole)) throw new Error("Review notification recipient could not be verified.");
  await Notice.create([values], { session });
}
async function remindOverdue(caseId, { now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Review reminder date is unavailable.");
  await ready();
  const session = await mongoose.startSession();
  let changed = false, dispatches = [];
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    const matter = await Case.findOneAndUpdate({ _id: caseId, adminDisputeDeadlineAt: { $lte: now }, adminDisputeOverdueNotifiedAt: null, status: "disputed", pausedReason: "dispute" }, { $set: { adminDisputeOverdueNotifiedAt: now } }, { returnDocument: "after", session });
    if (matter) {
      const reviews = (matter.disputes || []).filter(review => String(review.status || "open").toLowerCase() === "open");
      if (reviews.length !== 1) throw new Error("The current overdue review could not be verified.");
      const recipients = new Set([matter.attorney || matter.attorneyId, matter.withdrawnParalegalId].filter(Boolean).map(id));
      if (!recipients.size) throw new Error("The overdue review recipients are unavailable.");
      const { notifyUser } = require("../utils/notifyUser");
      for (const userId of recipients) {
        const dispatch = await notifyUser(userId, "admin_review_overdue", {
          caseId: id(matter._id), caseTitle: matter.title || "Untitled Matter", disputeId: id(reviews[0].disputeId || reviews[0]._id),
          message: "The LPC review remains open. No decision is recorded.",
        }, { session, deferDispatch: true, reviewOverdue: true });
        if (typeof dispatch !== "function") throw new Error("An overdue review recipient is unavailable.");
        dispatches.push(dispatch);
      }
      changed = true;
    }
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.matterReviewNotifications.reminder_abort"));
    throw error;
  } finally { await session.endSession(); }
  for (const dispatch of dispatches) await dispatch().catch(reportOperationalFailure("services.matterReviewNotifications.reminder_refresh"));
  return { changed };
}
async function stageResolution(matter, disputeId, session, actorUserId) {
  if (!session?.inTransaction()) throw new Error("Review decision notices require the settlement transaction.");
  const { notifyUser } = require("../utils/notifyUser");
  const dispatches = [];
  for (const userId of [matter.attorney || matter.attorneyId, matter.paralegal || matter.paralegalId || matter.withdrawnParalegalId]) {
    if (!userId) throw new Error("Review decision recipient is unavailable.");
    const dispatch = await notifyUser(id(userId), "dispute_resolved", {
      caseId: id(matter._id), caseTitle: matter.title || "Untitled Matter", disputeId,
      resolution: matter.disputeSettlement?.action, resolutionLabel: "Decision recorded",
      message: `LPC recorded a review decision for ${matter.title || "this Matter"}.`,
    }, { session, deferDispatch: true, reviewResolved: true, actorUserId });
    if (typeof dispatch !== "function") throw new Error("Review decision recipient is unavailable.");
    dispatches.push(dispatch);
  }
  return dispatches;
}
async function stageOpening(matter, review, session, actorUserId) {
  if (!session?.inTransaction()) throw new Error("Review notices require the review-opening transaction.");
  const recipients = new Set([matter.attorney || matter.attorneyId, matter.paralegal || matter.paralegalId, matter.withdrawnParalegalId].filter(Boolean).map(id));
  const admins = await User.find({ role: "admin", status: "approved" }).select("_id").session(session).lean();
  admins.forEach(user => recipients.add(id(user._id)));
  const dispatches = [], disputeId = id(review?.disputeId || review?._id);
  const { notifyUser } = require("../utils/notifyUser");
  for (const userId of recipients) {
    const dispatch = await notifyUser(userId, "dispute_opened", {
      title: "Review opened", message: `A review was opened for ${matter.title || "this Matter"}.`,
      caseId: id(matter._id), caseTitle: matter.title || "Untitled Matter", disputeId,
    }, { session, deferDispatch: true, reviewOpened: true, actorUserId });
    if (typeof dispatch !== "function") throw new Error("Review notification recipient is unavailable.");
    dispatches.push(dispatch);
  }
  return dispatches;
}
async function prepare(notice) {
  const [matter, user] = await Promise.all([
    Case.collection.findOne({ _id: notice.caseId }), User.collection.findOne({ _id: notice.userId }),
  ]);
  const resolved = notice.kind === "resolved", overdue = notice.kind === "overdue", type = resolved ? "dispute_resolved" : overdue ? "admin_review_overdue" : "dispute_opened";
  const { shouldSendEmailForType } = require("../utils/notifyUser");
  if (!user || user.role !== notice.userRole || user.status !== "approved" || user.deleted || user.disabled || user.suspended
    || !["opened", "resolved", "overdue"].includes(notice.kind || "opened")
    || notice.reviewContext && (notice.reviewContext !== "termination" || !currentTermination(matter, notice))
    || !(resolved ? currentResolution(matter, notice) : overdue ? currentOverdue(matter, notice) : currentReview(matter, notice)) || !recipient(matter, user._id, user.role)
    || overdue && !overdueRecipient(matter, user._id, user.role)
    || resolved && (!notice.operationId || !["attorney", "paralegal"].includes(user.role) || !await resolutionOperation(matter, notice.disputeId, null, notice.operationId))
    || !shouldSendEmailForType(user, type)) return null;
  const access = caseNotificationAccess(matter, user, type);
  if (!access.allowed) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(user.email || "")) throw new Error("Recipient email unavailable.");
  const templates = require("../email/templates"), template = resolved ? templates.reviewDecision : overdue ? templates.reviewOverdue : templates.reviewOpened;
  return { to: user.email, ...template({
    caseId: id(matter._id), disputeId: notice.disputeId, caseTitle: matter.title || "Untitled Matter", role: user.role,
    retained: access.relationship === "withdrawn" || resolved && user.role === "paralegal" && matter.status === "closed",
  }) };
}
const { processNotices, noticeStatus } = require("./emailNoticeDelivery").createEmailNoticeDelivery({ Notice, prepare, prefix: "review" });
module.exports = { ready, stage, stageOpening, stageResolution, remindOverdue, processNotices, noticeStatus };
