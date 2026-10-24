const mongoose = require("mongoose");
const Notice = require("../models/MatterPaymentNotification");
const User = require("../models/User"), Case = require("../models/Case");
const Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout");
const { mayActivateFunding } = require("./attorneyFunding");
const same = (a, b) => Boolean(a && b && String(a) === String(b));
const statuses = new Set(["requires_action", "requires_payment_method", "canceled"]);
const id = value => String(value?._id || value || "");
const date = value => value != null && Number.isFinite(new Date(value).getTime()) && new Date(value).getTime() > 0;
const completionSummary = "Matter completed and archived.";
const paymentActionSummary = status => status === "requires_action" ? "Payment requires your attention." : "Payment has not completed.";
function owned(matter, userId) {
  return matter && same(matter.attorney || matter.attorneyId, userId)
    && (!matter.attorney || !matter.attorneyId || same(matter.attorney, matter.attorneyId));
}
async function ready() {
  const indexes = await Notice.collection.indexes();
  if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 }))) throw new Error("Payment notification delivery indexes are unavailable.");
}
async function stage({ caseId, userId, paymentIntentId, paymentStatus }, session) {
  if (!session?.inTransaction()) throw new Error("Payment email requires the funding event transaction.");
  await ready();
  const matter = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(String(caseId)) }, { session });
  if (!owned(matter, userId) || !statuses.has(paymentStatus) || matter.paymentStatus !== paymentStatus) throw new Error("Payment notification source could not be verified.");
  await Notice.create([{ userId, caseId, paymentIntentId, paymentStatus }], { session });
}
async function completedSource(caseId, session) {
  const matter = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(id(caseId)) }, { session });
  if (!matter || matter.status !== "completed" || !matter.archived || !matter.readOnly || matter.purgedAt || !date(matter.completedAt) || !date(matter.paralegalAccessRevokedAt)) return null;
  const evidence = await require("./completionPayoutEvidence").inspect(matter, { session });
  return evidence.state === "recorded" ? { matter, payout: evidence.payout } : null;
}
async function stageCompletionEmail({ caseId, userId }, session) {
  if (!session?.inTransaction()) throw new Error("Completion email requires the completed-Matter transaction.");
  await ready();
  const source = await completedSource(caseId, session);
  if (!source || ![id(source.matter.attorney || source.matter.attorneyId), id(source.payout.paralegalId)].includes(id(userId))) throw new Error("Completion notification source could not be verified.");
  await Notice.create([{ kind: "completion", caseId, userId, payoutId: source.payout._id, transferId: source.payout.transferId, completedAt: source.matter.completedAt }], { session });
}
async function stageCompletion(matter, session, actorUserId) {
  if (!session?.inTransaction()) throw new Error("Completion notices require the completed-Matter transaction.");
  const source = await completedSource(matter._id, session);
  if (!source) throw new Error("Completion notification source could not be verified.");
  const { notifyUser } = require("../utils/notifyUser"), { buildObjectDeepLink } = require("./objectDeepLinks");
  const dispatches = [];
  for (const role of ["attorney", "paralegal"]) {
    const userId = role === "attorney" ? id(source.matter.attorney || source.matter.attorneyId) : id(source.payout.paralegalId);
    const simulated = source.payout.transferId.startsWith("bypass_");
    const type = role === "paralegal" && !simulated ? "payout_released" : "case_update";
    const link = buildObjectDeepLink({ type: role === "attorney" ? "matter" : "completed_matter", caseId: id(matter._id), role, tab: "financials" });
    const dispatch = await notifyUser(userId, type, { caseId: id(matter._id), caseTitle: source.matter.title || "Untitled Matter", outcome: "matter_completion_recorded", summary: completionSummary, link }, { session, deferDispatch: true, completionNotice: true, actorUserId });
    if (typeof dispatch !== "function") throw new Error("Completion notification recipient is unavailable.");
    dispatches.push(dispatch);
  }
  return dispatches;
}
async function prepareCompletion(notice) {
  const [source, user] = await Promise.all([
    completedSource(notice.caseId),
    User.findById(notice.userId).select("email role status deleted disabled suspended notificationPrefs").lean(),
  ]);
  if (!source || !user || user.status !== "approved" || user.deleted || user.disabled || user.suspended) return null;
  const { matter, payout } = source;
  const role = same(matter.attorney || matter.attorneyId, notice.userId) ? "attorney" : same(payout.paralegalId, notice.userId) ? "paralegal" : "";
  if (!role || user.role !== role || id(payout._id) !== id(notice.payoutId) || payout.transferId !== notice.transferId || !date(notice.completedAt) || new Date(matter.completedAt).getTime() !== new Date(notice.completedAt).getTime() || !payout.transferId.startsWith("tr_")) return null;
  const { shouldSendEmailForType } = require("../utils/notifyUser");
  if (!shouldSendEmailForType(user, "case_update")) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(user.email || "")) throw new Error("Recipient email unavailable.");
  return { to: user.email, ...require("../email/templates").completionNotice({ caseId: id(matter._id), caseTitle: matter.title || "Untitled Matter", role }) };
}
async function prepare(notice) {
  if (notice.kind === "completion") return prepareCompletion(notice);
  if (notice.kind && notice.kind !== "action") return null;
  const caseIds = [notice.caseId, String(notice.caseId)];
  const [matter, user, laterOperation, payout] = await Promise.all([
    Case.collection.findOne({ _id: notice.caseId }),
    User.findById(notice.userId).select("email role status deleted disabled suspended notificationPrefs").lean(),
    Operation.collection.findOne({ caseId: { $in: caseIds }, kind: { $ne: "funding" } }, { projection: { _id: 1 } }),
    Payout.collection.findOne({ caseId: { $in: caseIds } }, { projection: { _id: 1 } }),
  ]);
  const { shouldSendEmailForType } = require("../utils/notifyUser");
  const refs = [...new Set([matter?.paymentIntentId, matter?.escrowIntentId].filter(Boolean))];
  if (!user || user.role !== "attorney" || user.status !== "approved" || user.deleted || user.disabled || user.suspended
    || !owned(matter, notice.userId) || !mayActivateFunding(matter) || laterOperation || payout
    || matter.escrowStatus === "funded" || matter.fundingIntegrityStatus === "verified"
    || refs.length !== 1 || refs[0] !== notice.paymentIntentId || matter.paymentStatus !== notice.paymentStatus
    || !shouldSendEmailForType(user, "case_update")) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(user.email || "")) throw new Error("Recipient email unavailable.");
  return { to: user.email, ...require("../email/templates").paymentAction({ caseId: String(matter._id), caseTitle: matter.title || "Untitled Matter", summary: paymentActionSummary(notice.paymentStatus) }) };
}
const { processNotices, noticeStatus } = require("./emailNoticeDelivery").createEmailNoticeDelivery({ Notice, prepare, prefix: "payment" });
module.exports = { ready, stage, stageCompletion, stageCompletionEmail, processNotices, noticeStatus, paymentActionSummary };
