const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose"), crypto = require("crypto");
const Case = require("../models/Case"), User = require("../models/User"), Job = require("../models/Job"), AuditLog = require("../models/AuditLog"), Payout = require("../models/Payout"), PaymentOperation = require("../models/PaymentOperation"), PlatformIncome = require("../models/PlatformIncome");
const account = require("./attorneyAccountBoundary"), { findActiveSession } = require("./authSessionService"), { fingerprint } = require("./matterDraftRevision"), { normalizeCaseStatus } = require("../utils/caseState");
const history = require("./attorneyReceiptHistory"), { currentAssignmentScopeProgress } = require("./paralegalWorkflowPolicy"), { DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT } = require("./platformFeePolicy");
const { upsertPayoutLedger, upsertPlatformIncomeLedger } = require("./paymentLedgerService"), { succeedPaymentOperation } = require("./paymentOperationService");
const { getPayoutHold } = require("./payoutHoldService");
const id = value => String(value?._id || value || ""), validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value), money = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value), hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fields = "title details briefSummary practiceArea state locationState attorney attorneyId paralegal paralegalId paralegalNameSnapshot withdrawnParalegalId status tasks assignmentCompletedTaskIndexes taskRevision __v archived readOnly purgedAt hiredAt pausedReason pausedAt disputeDeadlineAt adminDisputeDeadlineAt disputes disputeSettlement payoutFinalizedAt payoutFinalizedType partialPayoutAmount remainingAmount lockedTotalAmount totalAmount currency stripeMode feeParalegalPct feeAttorneyPct feeAttorneyAmount feeParalegalAmount paymentIntentId escrowIntentId escrowStatus paymentReleased payoutStatus payoutTransferId payoutFailureReason paidOutAt fundingIntegrityStatus fundingIntegrityFailure fundingVerifiedAt paymentStatus withdrawalHistory relistRequestedAt relistPending job jobId postingSyncStatus completionClaimStatus completionClaimToken hiringClaimStatus hiringClaimToken withdrawalClaimStatus withdrawalClaimToken withdrawalClaimedAt withdrawalClaimTransferId withdrawalClaimAmount".split(" ");
const projection = Object.fromEntries(fields.map(key => [key, 1])), exact = raw => ({ _id: raw._id, ...Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : { $eq: raw[key] }])) });
const personFields = { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1, stripeAccountId: 1, stripeOnboarded: 1, stripePayoutsEnabled: 1 };
const fail = (status, suffix) => { throw Object.assign(new Error("The withdrawal decision could not be verified. Review the current Matter before continuing."), { status, publicCode: `WORKSPACE_WITHDRAWAL_${suffix}` }); };
const expected = req => req.method === "GET" ? req.query?.expectedOwnerId : req.body?.expectedOwnerId;
async function actor(req, allowAdmin = false) {
  if (req.user?.role === "attorney") { try { return await account.read(req, expected(req)); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; } }
  const actorId = id(req.user?.id);
  if (!allowAdmin || req.user?.role !== "admin" || expected(req) !== actorId || !validId(actorId)) fail(403, "ACCOUNT_CHANGED");
  const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(actorId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!user || user.role !== "admin" || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, actorId)) fail(403, "ACCOUNT_CHANGED"); return user;
}
async function matter(req, allowAdmin, session) {
  await actor(req, allowAdmin); if (!validId(req.params.caseId)) fail(400, "INVALID");
  const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) }, { projection, session }); if (!raw) fail(404, "NOT_FOUND");
  if (raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId) || !validId(id(raw.attorney || raw.attorneyId))) fail(409, "OWNERSHIP_CHANGED");
  if (req.user.role !== "admin" && id(raw.attorney || raw.attorneyId) !== expected(req)) fail(403, "RESTRICTED");
  if (raw.paralegal && raw.paralegalId && id(raw.paralegal) !== id(raw.paralegalId)) fail(409, "CHANGED");
  if (!Array.isArray(raw.tasks) || raw.assignmentCompletedTaskIndexes != null && !Array.isArray(raw.assignmentCompletedTaskIndexes)) fail(409, "WORK_UNAVAILABLE"); return raw;
}
const eventKey = raw => `partial_payout:${id(raw._id)}:${id(raw.withdrawnParalegalId)}:${fingerprint([iso(raw.pausedAt), id(raw.withdrawnParalegalId)]).slice(0, 24)}`;
const logId = (req, requestId, kind) => new mongoose.Types.ObjectId(fingerprint(["withdrawal_decision", expected(req), requestId, kind]).slice(0, 24));
async function log(req, requestId, kind, session) {
  const saved = await AuditLog.collection.findOne({ _id: logId(req, requestId, kind) }, { session, ...(session ? {} : { readConcern: { level: "majority" } }) });
  if (saved && (id(saved.actor) !== expected(req) || id(saved.case) !== id(req.params.caseId) || saved.actorRole !== req.user.role || saved.meta?.kind !== "withdrawal_decision" || saved.action !== `case.withdrawal.${kind}`)) fail(409, "REQUEST_CHANGED"); return saved;
}
const entry = (req, requestId, kind, meta) => ({ _id: logId(req, requestId, kind), actor: expected(req), actorRole: req.user.role, case: req.params.caseId, targetType: "case", targetId: req.params.caseId, action: `case.withdrawal.${kind}`, method: req.method, path: req.originalUrl?.split("?")[0], meta: { kind: "withdrawal_decision", ...meta } });
async function result(req, requestId, raw) {
  if (!requestId) return null;
  const [began, recorded, stopped] = await Promise.all([log(req, requestId, "started"), log(req, requestId, "recorded"), log(req, requestId, "not_sent")]);
  if (recorded) return { requestId, status: "recorded", action: recorded.meta.action, amountCents: recorded.meta.amountCents, at: iso(recorded.createdAt) };
  if (stopped) return { requestId, status: "not_sent", action: stopped.meta.action, amountCents: stopped.meta.amountCents, at: iso(stopped.createdAt) };
  if (!began) return { requestId, status: "not_found", action: null, amountCents: null, at: null };
  return { requestId, status: raw.withdrawalClaimToken === requestId && raw.withdrawalClaimStatus === "claimed" && iso(raw.withdrawalClaimedAt) && Date.now() - new Date(raw.withdrawalClaimedAt).getTime() < 600000 ? "processing" : "needs_review", action: began.meta.action, amountCents: began.meta.amountCents, at: iso(began.createdAt) };
}
function amountFacts(raw) {
  const original = raw.lockedTotalAmount ?? raw.totalAmount, entries = history.inventory(raw).filter(item => item.record?.payoutFinalizedAt), paid = entries.reduce((sum, item) => sum + (money(item.record.partialPayoutAmount) ? item.record.partialPayoutAmount : NaN), 0);
  const valid = money(original) && original > 0 && money(paid) && paid <= original && entries.every(item => !item.conflict && iso(item.record.payoutFinalizedAt) && history.decisions.has(item.record.payoutFinalizedType));
  const computed = valid ? original - paid : null, remaining = raw.remainingAmount == null ? computed : money(raw.remainingAmount) ? raw.remainingAmount : null;
  const feePct = raw.feeParalegalPct ?? DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;
  const feeValid = typeof feePct === "number" && Number.isFinite(feePct) && feePct >= 0 && feePct < 100;
  const code = typeof raw.currency === "string" ? raw.currency.toUpperCase() : "USD"; let currency = null; try { if (Intl.supportedValuesOf("currency").includes(code) && new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits === 2) currency = code; } catch { /* No invented minor unit. */ }
  return { original: money(original) ? original : null, remaining, balanceVerified: valid && remaining === computed, feePct: feeValid ? feePct : null, currency };
}
async function postingSources(raw, session) {
  const jobId = id(raw.jobId || raw.job);
  return Job.collection.find({ $or: [{ caseId: { $in: [raw._id, id(raw._id)] } }, ...(validId(jobId) ? [{ _id: new mongoose.Types.ObjectId(jobId) }] : [])] }, { session }).sort({ _id: 1 }).limit(3).toArray();
}
async function postingReady(raw, jobs) {
  const jobId = id(raw.jobId || raw.job), ownerId = id(raw.attorney || raw.attorneyId);
  if (raw.job && raw.jobId && id(raw.job) !== id(raw.jobId) || jobs.length > 1) return false;
  if (jobs.length) return id(jobs[0].attorneyId) === ownerId && (!jobs[0].caseId || id(jobs[0].caseId) === id(raw._id)) && (!jobId || jobId === id(jobs[0]._id));
  if (jobId) return false;
  try { await new Job({ caseId: raw._id, attorneyId: ownerId, title: raw.title, practiceArea: raw.practiceArea, description: raw.details || raw.briefSummary, budget: (raw.lockedTotalAmount ?? raw.totalAmount) / 100, state: raw.state || raw.locationState || "", locationState: raw.locationState || raw.state || "" }).validate(); return true; } catch (error) { if (error.name !== "ValidationError") throw error; return false; }
}
function settledWithdrawalOperation(raw, operation, payout, expectedNet) {
  const decision = raw.disputeSettlement;
  const reviews = (raw.disputes || []).filter(review => id(review.disputeId || review._id) === decision?.disputeId);
  return operation.kind === "dispute_settlement" && raw.payoutFinalizedType === "admin"
    && ["release_full", "release_partial"].includes(decision?.action)
    && reviews.length === 1 && reviews[0].status === "resolved"
    && iso(decision.resolvedAt) && iso(decision.resolvedAt) === iso(raw.payoutFinalizedAt)
    && operation.operationKey === `dispute_settlement:${id(raw._id)}:${decision.disputeId}`
    && !["quarantined", "needs_reconciliation"].includes(operation.evidenceStatus)
    && operation.transferAmount === expectedNet && decision.payoutAmount === expectedNet
    && decision.grossAmount === raw.partialPayoutAmount
    && decision.feeParalegalAmount === raw.partialPayoutAmount - expectedNet
    && decision.transferId === payout.transferId && !payout.failureReason
    && !operation.stripeRefundId && !decision.refundId && decision.refundAmount === 0;
}
async function snapshot(req, requestId, allowAdmin = false) {
  const user = await actor(req, allowAdmin), raw = await matter(req, allowAdmin), paraId = id(raw.withdrawnParalegalId), caseRefs = [raw._id, id(raw._id)];
  const [person, operations, payouts, hold, jobs] = await Promise.all([
    validId(paraId) ? User.collection.findOne({ _id: new mongoose.Types.ObjectId(paraId) }, { projection: personFields }) : null,
    PaymentOperation.collection.find({ caseId: { $in: caseRefs }, kind: { $in: ["partial_payout", "case_payout", "dispute_settlement"] } }, { projection: { operationKey: 1, kind: 1, status: 1, amount: 1, currency: 1, stripeObjectId: 1, stripeTransferId: 1, stripeMode: 1, createdAt: 1, transferAmount: 1, stripeRefundId: 1, evidenceStatus: 1 } }).sort({ _id: 1 }).limit(4001).toArray(),
    Payout.collection.find({ caseId: { $in: caseRefs } }, { projection: { paralegalId: 1, amountPaid: 1, status: 1, transferId: 1, operationKey: 1, reversedAt: 1, stripeMode: 1, createdAt: 1, failureReason: 1 } }).sort({ _id: 1 }).limit(4001).toArray(),
    getPayoutHold(raw._id),
    postingSources(raw),
  ]);
  if (operations.length > 4000 || payouts.length > 4000) fail(413, "TOO_LARGE");
  const amounts = amountFacts(raw), work = currentAssignmentScopeProgress(raw), applicable = Boolean(!raw.paralegal && !raw.paralegalId && (raw.withdrawnParalegalId || raw.pausedReason === "paralegal_withdrew")), finalized = Boolean(raw.payoutFinalizedAt), status = normalizeCaseStatus(raw.status);
  const previousTransfers = new Set((raw.withdrawalHistory || []).map(item => item.payoutTransferId).filter(Boolean));
  const currentPointer = raw.payoutTransferId && (finalized || !previousTransfers.has(raw.payoutTransferId)) ? raw.payoutTransferId : null;
  const currentPayouts = payouts.filter(item => id(item.paralegalId) === paraId && (currentPointer ? item.transferId === currentPointer : !previousTransfers.has(item.transferId) && (!iso(item.createdAt) || !iso(raw.pausedAt) || new Date(item.createdAt) >= new Date(raw.pausedAt))));
  const currentOperations = operations.filter(item => item.operationKey === eventKey(raw) || item.operationKey === `partial_payout:${id(raw._id)}:${paraId}` && !previousTransfers.has(item.stripeTransferId || item.stripeObjectId) || ["pending", "needs_reconciliation"].includes(item.status));
  const blockers = [];
  if (!applicable || status !== "paused" || raw.pausedReason !== "paralegal_withdrew" || raw.paralegal || raw.paralegalId) blockers.push("withdrawal_required");
  if (raw.archived || raw.readOnly || raw.purgedAt || raw.paymentReleased) blockers.push("matter_closed");
  if (raw.disputes?.some(item => String(item.status || "open").toLowerCase() === "open") || status === "disputed") blockers.push("dispute_open");
  if (raw.hiringClaimStatus || raw.hiringClaimToken || raw.completionClaimStatus || raw.completionClaimToken || raw.withdrawalClaimStatus || raw.withdrawalClaimToken) blockers.push("decision_processing");
  if (!amounts.balanceVerified || !amounts.currency || amounts.feePct === null) blockers.push("amount_needs_review");
  if (!iso(raw.pausedAt) || !validId(paraId)) blockers.push("withdrawal_needs_review");
  if (hold.held) blockers.push("payment_review");
  if (!await postingReady(raw, jobs)) blockers.push("posting_needs_review");
  if (!finalized && (currentPayouts.length || currentOperations.length) || ["failed", "reversed", "needs_reconciliation"].includes(raw.payoutStatus)) blockers.push("payout_needs_review");
  const payout = currentPayouts.length === 1 ? currentPayouts[0] : null;
  const expectedNet = money(raw.partialPayoutAmount) && amounts.feePct !== null ? raw.partialPayoutAmount - Math.round(raw.partialPayoutAmount * amounts.feePct / 100) : null;
  const payoutOperations = payout ? operations.filter(item => item.operationKey === payout.operationKey || item.stripeTransferId === payout.transferId || item.stripeObjectId === payout.transferId) : [];
  const modeConflict = value => ["test", "live"].includes(raw.stripeMode) && ["test", "live"].includes(value) && raw.stripeMode !== value;
  const operationVerified = payoutOperations.length === 1 && payoutOperations.every(item => (item.kind === "partial_payout" && item.amount === expectedNet || settledWithdrawalOperation(raw, item, payout, expectedNet)) && item.status === "succeeded" && item.currency?.toUpperCase() === amounts.currency && !modeConflict(item.stripeMode) && (!payout.operationKey || item.operationKey === payout.operationKey) && [item.stripeObjectId, item.stripeTransferId].filter(Boolean).every(value => value === payout.transferId));
  const payoutVerified = payout?.status === "paid" && !payout.reversedAt && !modeConflict(payout.stripeMode) && !previousTransfers.has(payout.transferId) && !["failed", "reversed", "needs_reconciliation"].includes(raw.payoutStatus) && payout.amountPaid === expectedNet && /^tr_[A-Za-z0-9_]+$/.test(payout.transferId || "") && !currentOperations.some(item => item.status !== "succeeded") && (operationVerified || !payout.operationKey && !payoutOperations.length && !currentOperations.length);
  const payoutState = !finalized ? "not_finalized" : raw.payoutStatus === "reversed" || payout?.status === "reversed" || payout?.reversedAt ? "reversed" : raw.partialPayoutAmount === 0 && !currentPayouts.length && !currentOperations.length ? "none" : payoutVerified ? "recorded" : "needs_review";
  if (finalized && !["none", "recorded"].includes(payoutState)) blockers.push("payout_needs_review");
  const deadline = iso(raw.disputeDeadlineAt), windowActive = deadline && new Date(deadline).getTime() > Date.now() && !finalized;
  const canDecide = !blockers.length && !finalized && (!raw.disputeDeadlineAt || req.user.role === "admin" && !windowActive);
  const fundingReady = raw.escrowStatus === "funded" && Boolean(raw.paymentIntentId || raw.escrowIntentId) && !(raw.paymentIntentId && raw.escrowIntentId && raw.paymentIntentId !== raw.escrowIntentId) && raw.fundingIntegrityStatus !== "failed";
  const payoutSetupReady = Boolean(person?.role === "paralegal" && person.status === "approved" && !person.disabled && !person.deleted && person.stripeAccountId && person.stripeOnboarded && person.stripePayoutsEnabled);
  const maxCents = amounts.balanceVerified ? Math.min(amounts.remaining, req.user.role === "admin" ? amounts.original : Math.round(amounts.original * 70 / 100)) : null;
  const canRelist = !blockers.length && finalized && amounts.remaining > 0 && !windowActive && !raw.relistRequestedAt;
  const operation = await result(req, requestId, raw), state = !applicable ? "not_applicable" : raw.withdrawalClaimStatus || raw.withdrawalClaimToken ? raw.withdrawalClaimStatus === "needs_reconciliation" || !iso(raw.withdrawalClaimedAt) || Date.now() - new Date(raw.withdrawalClaimedAt).getTime() >= 600000 ? "needs_review" : "processing" : status === "disputed" ? "admin_review" : finalized ? "finalized" : windowActive ? "review_window" : raw.disputeDeadlineAt ? "review_overdue" : canDecide ? "decision_required" : "needs_review";
  const revision = fingerprint([user, raw, person, operations, payouts, jobs, hold.operation?.toObject()]);
  const dto = { ownerId: expected(req), caseId: id(raw._id), caseTitle: typeof raw.title === "string" && raw.title || "Untitled Matter", revision, applicable, state, blockers: [...new Set(blockers)], paralegalId: validId(paraId) ? paraId : null, paralegalName: [person?.firstName, person?.lastName].filter(value => typeof value === "string").join(" ") || (typeof raw.paralegalNameSnapshot === "string" && raw.paralegalNameSnapshot) || "Paralegal name not recorded", withdrawnAt: iso(raw.pausedAt), originalCents: amounts.original, remainingCents: amounts.remaining, balanceVerified: amounts.balanceVerified, currency: amounts.currency, feePct: amounts.feePct, maximumPayoutCents: maxCents, work: { complete: work.completedTaskCount, total: work.totalTaskCount }, canDecide, canPay: canDecide && fundingReady && payoutSetupReady && maxCents > 0, canRelist, fundingReady, payoutSetupReady, reviewDeadline: deadline, adminDeadline: iso(raw.adminDisputeDeadlineAt), decision: finalized ? { type: history.decisions.has(raw.payoutFinalizedType) ? raw.payoutFinalizedType : "unknown", amountCents: money(raw.partialPayoutAmount) ? raw.partialPayoutAmount : null, at: iso(raw.payoutFinalizedAt), payoutState, netCents: payoutState === "recorded" ? payout.amountPaid : null } : null, relistedAt: iso(raw.relistRequestedAt), operation };
  return { raw, user, person, operations, payouts, jobs, dto };
}
async function reviewed(req, requestId, allowAdmin) { const first = await snapshot(req, requestId, allowAdmin), latest = await snapshot(req, requestId, allowAdmin); if (first.dto.revision !== latest.dto.revision) fail(409, "CHANGED"); await actor(req, allowAdmin); return latest; }
async function read(req) { if (Object.keys(req.query).some(key => !["expectedOwnerId", "requestId"].includes(key)) || req.query.requestId !== undefined && !uuid(req.query.requestId)) fail(400, "INVALID"); return (await reviewed(req, req.query.requestId, false)).dto; }
const requestHash = body => fingerprint([body.action, body.amountCents ?? null, body.reviewedRevision]);
function validate(body) {
  if (!body || Object.keys(body).some(key => !["expectedOwnerId", "requestId", "reviewedRevision", "action", "amountCents"].includes(key)) || !uuid(body.requestId) || !hash(body.reviewedRevision) || !["partial", "reject", "relist"].includes(body.action) || (body.action === "partial" ? !money(body.amountCents) : body.amountCents !== undefined)) fail(400, "INVALID");
}
async function transaction(work) {
  let timer; try { await Promise.race([Promise.all([AuditLog.init(), Case.init(), Job.init(), Payout.init(), PlatformIncome.init(), PaymentOperation.init()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Withdrawal initialization incomplete")), 8000); })]); } finally { clearTimeout(timer); } const session = await mongoose.startSession();
  try { session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 }); const value = await work(session); await session.commitTransaction(); return value; }
  catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyWithdrawal.transaction_abort")); if (error.publicCode) throw error; if (error.code === 11000 || error.code === 112 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED"); fail(503, "UNCONFIRMED"); }
  finally { await session.endSession(); }
}
async function syncPosting(raw, change, session) {
  if (raw.job && raw.jobId && id(raw.job) !== id(raw.jobId)) fail(409, "POSTING_CHANGED");
  const ownerId = id(raw.attorney || raw.attorneyId), jobId = id(raw.jobId || raw.job);
  const found = await Job.collection.find({ $or: [{ caseId: { $in: [raw._id, id(raw._id)] } }, ...(validId(jobId) ? [{ _id: new mongoose.Types.ObjectId(jobId) }] : [])] }, { session }).limit(3).toArray();
  if (found.length > 1) fail(409, "POSTING_CHANGED");
  const job = found[0], remaining = change.remainingAmount ?? raw.remainingAmount;
  if (job) {
    if (id(job.attorneyId) !== ownerId || job.caseId && id(job.caseId) !== id(raw._id) || jobId && jobId !== id(job._id)) fail(409, "POSTING_CHANGED");
    const updated = await Job.collection.updateOne({ _id: job._id, attorneyId: job.attorneyId, caseId: job.caseId === undefined ? { $exists: false } : job.caseId, status: job.status }, { $set: { caseId: raw._id, status: remaining > 0 ? "open" : "closed" } }, { session }); if (!updated.matchedCount) fail(409, "POSTING_CHANGED"); change.jobId = job._id;
  } else {
    if (jobId) fail(409, "POSTING_CHANGED");
    if (remaining > 0) { const [created] = await Job.create([{ caseId: raw._id, attorneyId: ownerId, title: raw.title, practiceArea: raw.practiceArea, description: raw.details || raw.briefSummary, budget: (raw.lockedTotalAmount ?? raw.totalAmount) / 100, status: "open", state: raw.state || raw.locationState || "", locationState: raw.locationState || raw.state || "" }], { session }); change.jobId = created._id; }
  }
  change.postingSyncStatus = "synced"; change.postingSyncedAt = new Date(); change.postingSyncError = "";
}
const claimValues = { withdrawalClaimToken: "", withdrawalClaimStatus: null, withdrawalClaimedAt: null, withdrawalClaimTransferId: "", withdrawalClaimAmount: null };
function finalChange(raw, body, transfer, now) {
  if (body.action === "reject") return { disputeDeadlineAt: new Date(now.getTime() + 86400000), partialPayoutAmount: null, payoutFinalizedType: null, payoutFinalizedAt: null, adminDisputeDeadlineAt: null, adminDisputeOverdueNotifiedAt: null, relistRequestedAt: null, relistPending: false, remainingAmount: amountFacts(raw).remaining };
  if (body.action === "relist") return { relistRequestedAt: now, relistPending: false };
  const remaining = amountFacts(raw).remaining - body.amountCents;
  return { ...claimValues, partialPayoutAmount: body.amountCents, payoutFinalizedType: body.actorRole === "admin" ? "admin" : "partial_attorney", payoutFinalizedAt: now, disputeDeadlineAt: null, adminDisputeDeadlineAt: null, adminDisputeOverdueNotifiedAt: null, relistRequestedAt: remaining > 0 ? now : null, relistPending: false, remainingAmount: remaining, ...(body.amountCents > 0 ? { ...transfer.funding, payoutTransferId: transfer.transferId, payoutStatus: "paid", payoutFailureReason: "", paidOutAt: raw.payoutTransferId === transfer.transferId && iso(raw.paidOutAt) ? raw.paidOutAt : now } : {}) };
}
async function storeResult(req, review, body, transfer, allowAdmin, claimed = null) {
  const raw = review.raw;
  const now = new Date(); return transaction(async session => {
    const latest = await matter(req, allowAdmin, session);
    if (fingerprint(await postingSources(latest, session)) !== fingerprint(review.jobs)) fail(409, "POSTING_CHANGED");
    if (claimed) { const person = await User.collection.findOne({ _id: review.person._id }, { projection: personFields, session }); if (fingerprint(person) !== fingerprint(review.person)) fail(409, "PAYEE_CHANGED"); }
    const expectedRaw = claimed ? { ...raw, ...claimed } : raw;
    const compared = fields.filter(key => !claimed || !["payoutTransferId", "payoutStatus", "payoutFailureReason", "paidOutAt", "paymentReleased"].includes(key));
    if (fingerprint(compared.map(key => latest[key])) !== fingerprint(compared.map(key => expectedRaw[key]))) fail(409, "CHANGED");
    if (claimed && (["failed", "reversed", "needs_reconciliation"].includes(latest.payoutStatus) || latest.payoutTransferId && latest.payoutTransferId !== raw.payoutTransferId && latest.payoutTransferId !== transfer.transferId || latest.paymentReleased !== raw.paymentReleased)) fail(409, "PAYMENT_CHANGED");
    const change = finalChange(latest, { ...body, actorRole: req.user.role }, transfer, now);
    if (body.action !== "reject") await syncPosting(latest, change, session);
    if (body.action === "partial" && body.amountCents > 0) {
      await upsertPayoutLedger({ operationKey: transfer.paymentOperationKey, caseId: latest._id, paralegalId: latest.withdrawnParalegalId, amountPaid: transfer.payout, transferId: transfer.transferId, stripeMode: transfer.stripeMode }, { session });
      await upsertPlatformIncomeLedger({ operationKey: transfer.paymentOperationKey, caseId: latest._id, attorneyId: latest.attorney || latest.attorneyId, paralegalId: latest.withdrawnParalegalId, feeAmount: transfer.feeAmount, stripeMode: transfer.stripeMode }, { session });
      const operation = await PaymentOperation.collection.findOne({ _id: transfer.paymentOperationId }, { session });
      const awaitingLedger = operation?.status === "needs_reconciliation" && operation.stripeObjectId === transfer.transferId && operation.lastError === "Stripe transfer exists; waiting for the local payout ledger to finalize.";
      if (!operation || operation.operationKey !== transfer.paymentOperationKey || operation.status !== "pending" && !awaitingLedger || operation.amount !== transfer.payout || operation.stripeTransferId !== transfer.transferId || operation.currency !== transfer.funding.currency) fail(409, "PAYMENT_CHANGED");
      await succeedPaymentOperation(operation, transfer.transferId, { session });
    }
    const updated = await Case.collection.findOneAndUpdate(exact(latest), { $set: change, $inc: { __v: 1 } }, { session, returnDocument: "after" }); if (!updated) fail(409, "CHANGED");
    if (!claimed) await AuditLog.create([entry(req, body.requestId, "started", { requestHash: requestHash(body), action: body.action, amountCents: body.amountCents ?? null })], { session });
    await AuditLog.create([entry(req, body.requestId, "recorded", { requestHash: requestHash(body), action: body.action, amountCents: body.amountCents ?? null, remainingAmount: updated.remainingAmount, payoutCents: transfer?.payout || 0, transferId: transfer?.transferId || null }), entry(req, body.requestId, body.action === "partial" ? "payout" : body.action, { grossAmount: body.amountCents ?? null, netAmount: transfer?.payout || 0, transferId: transfer?.transferId || null, pending: false, ...currentAssignmentScopeProgress(raw) })], { session, ordered: true });
    const dispatches = await require("./matterWithdrawalNotifications").stageDecision(updated, body.action, session, req.user.id);
    await actor(req, allowAdmin); return { updated, dispatches };
  });
}
async function execute(req, { allowAdmin = false, transfer, afterCommit } = {}) {
  const body = req.body; validate(body); await actor(req, allowAdmin);
  const previous = await log(req, body.requestId, "started");
  if (previous) { if (previous.meta.requestHash !== requestHash(body)) fail(409, "REQUEST_CHANGED"); return (await reviewed(req, body.requestId, allowAdmin)).dto; }
  const review = await reviewed(req, body.requestId, allowAdmin), dto = review.dto;
  if (dto.revision !== body.reviewedRevision) fail(409, "CHANGED");
  if (body.action === "relist" ? !dto.canRelist : !dto.canDecide || body.action === "partial" && (body.amountCents > dto.maximumPayoutCents || body.amountCents > 0 && !dto.canPay)) fail(409, "BLOCKED");
  if (body.action === "reject" && (dto.work.complete === 0 || dto.work.complete >= dto.work.total || review.raw.disputeDeadlineAt)) fail(409, "BLOCKED");
  let updated = null, paid = null, claimed = null, attempted = false, dispatches = [];
  try {
    if (body.action === "partial" && body.amountCents > 0) {
      const now = new Date(); claimed = { withdrawalClaimToken: body.requestId, withdrawalClaimStatus: "claimed", withdrawalClaimedAt: now, withdrawalClaimAmount: body.amountCents, withdrawalClaimTransferId: "", __v: Number(review.raw.__v || 0) + 1 };
      await transaction(async session => { const raw = await matter(req, allowAdmin, session); if (fingerprint(raw) !== fingerprint(review.raw)) fail(409, "CHANGED"); const set = { ...claimed }; delete set.__v; const locked = await Case.collection.updateOne(exact(raw), { $set: set, $inc: { __v: 1 } }, { session }); if (!locked.matchedCount) fail(409, "CHANGED"); await AuditLog.create([entry(req, body.requestId, "started", { requestHash: requestHash(body), action: body.action, amountCents: body.amountCents })], { session }); await actor(req, allowAdmin); });
      const beforeTransfer = async () => { const raw = await matter(req, allowAdmin); if (fingerprint(raw) !== fingerprint({ ...review.raw, ...claimed }) || fingerprint(await postingSources(raw)) !== fingerprint(review.jobs) || (await getPayoutHold(raw._id)).held) fail(409, "CHANGED"); const person = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(dto.paralegalId) }, { projection: personFields }); if (fingerprint(person) !== fingerprint(review.person)) fail(409, "CHANGED"); await actor(req, allowAdmin); };
      const afterTransfer = async transferId => { claimed.withdrawalClaimTransferId = transferId; const stored = await Case.collection.updateOne({ _id: review.raw._id, withdrawalClaimToken: body.requestId, withdrawalClaimStatus: "claimed" }, { $set: { withdrawalClaimTransferId: transferId } }); if (!stored.matchedCount) fail(409, "CHANGED"); };
      paid = await transfer(Case.hydrate({ ...review.raw, ...claimed }), User.hydrate(review.person), body.amountCents, { operationKey: eventKey(review.raw), beforeTransfer, afterTransfer, onAttempt: () => { attempted = true; } });
      if (paid?.pending || !paid?.transferId || !money(paid.payout) || paid.payout <= 0 || paid.payout + paid.feeAmount !== body.amountCents) fail(409, "PAYOUT_SETUP_REQUIRED");
    }
    ({ updated, dispatches } = await storeResult(req, review, body, paid, allowAdmin, claimed));
  } catch (error) {
    if (await log(req, body.requestId, "recorded")) return (await reviewed(req, body.requestId, allowAdmin)).dto;
    if (claimed) {
      if (attempted) await Case.collection.updateOne({ _id: review.raw._id, withdrawalClaimToken: body.requestId, withdrawalClaimStatus: "claimed" }, { $set: { withdrawalClaimStatus: "needs_reconciliation" } });
      else await transaction(async session => { const latest = await matter(req, allowAdmin, session); if (latest.withdrawalClaimToken !== body.requestId || latest.withdrawalClaimStatus !== "claimed") fail(409, "CHANGED"); await Case.collection.updateOne(exact(latest), { $set: claimValues, $inc: { __v: 1 } }, { session }); await AuditLog.create([entry(req, body.requestId, "not_sent", { action: body.action, amountCents: body.amountCents })], { session }); });
    }
    throw error;
  }
  for (const dispatch of dispatches) await dispatch();
  await afterCommit?.(updated, { action: body.action, amountCents: body.amountCents ?? null, payout: paid?.payout || 0 });
  return (await reviewed(req, body.requestId, allowAdmin)).dto;
}
async function legacy(req, action, options) {
  const amount = req.body?.amountCents !== undefined ? Number(req.body.amountCents) : /^\d+(?:\.\d{1,2})?$/.test(String(req.body?.amount ?? "")) ? Math.round(Number(req.body.amount) * 100) : NaN;
  const adapted = Object.assign(Object.create(req), { body: { expectedOwnerId: id(req.user.id), requestId: crypto.randomUUID(), action, ...(action === "partial" ? { amountCents: amount } : {}) } });
  const review = await reviewed(adapted, null, true); if (action === "relist" && review.dto.relistedAt && review.dto.decision && !review.dto.blockers.length && review.dto.balanceVerified && review.dto.remainingCents > 0) return { ...review.dto, legacyTransferId: null }; adapted.body.reviewedRevision = review.dto.revision; const value = await execute(adapted, { ...options, allowAdmin: true }); await actor(adapted, true); const saved = await log(adapted, adapted.body.requestId, "recorded"); return { ...value, legacyTransferId: saved?.meta.transferId || null };
}
// Both scheduled and request-time expiry use this automatic lifecycle decision.
// The supplied Case document is never a write authority: load retained raw facts
// and commit the zero decision, remaining balance, posting and audit together.
async function expire(caseId, { now = new Date() } = {}) {
  if (!validId(id(caseId)) || !iso(now)) fail(400, "EXPIRY_INVALID");
  let auditId = null;
  try {
    const result = await transaction(async session => {
      const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(id(caseId)) }, { projection, session });
      if (!raw || normalizeCaseStatus(raw.status) !== "paused" || raw.pausedReason !== "paralegal_withdrew" || raw.payoutFinalizedAt || !iso(raw.disputeDeadlineAt) || new Date(raw.disputeDeadlineAt) > now || raw.paralegal || raw.paralegalId || raw.archived || raw.readOnly || raw.purgedAt || raw.paymentReleased || raw.disputes?.some(item => String(item.status || "open").toLowerCase() === "open") || [raw.withdrawalClaimToken, raw.withdrawalClaimStatus, raw.hiringClaimToken, raw.hiringClaimStatus, raw.completionClaimToken, raw.completionClaimStatus].some(Boolean)) return { changed: false };
      if (!validId(id(raw.attorney || raw.attorneyId)) || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId) || !validId(id(raw.withdrawnParalegalId)) || !iso(raw.pausedAt)) fail(409, "EXPIRY_REVIEW");
      const amounts = amountFacts(raw);
      if (!amounts.balanceVerified || !amounts.currency || raw.partialPayoutAmount != null && raw.partialPayoutAmount !== 0 || ["failed", "reversed", "needs_reconciliation"].includes(raw.payoutStatus)) fail(409, "EXPIRY_REVIEW");
      const priorTransfers = new Set((raw.withdrawalHistory || []).filter(item => item.payoutFinalizedAt).map(item => item.payoutTransferId).filter(Boolean)), caseRefs = [raw._id, id(raw._id)];
      const operations = await PaymentOperation.collection.find({ caseId: { $in: caseRefs } }, { session }).limit(4001).toArray();
      const payouts = await Payout.collection.find({ caseId: { $in: caseRefs } }, { session }).limit(4001).toArray();
      if (operations.length > 4000 || payouts.length > 4000) fail(413, "EXPIRY_TOO_LARGE");
      if (payouts.some(item => !priorTransfers.has(item.transferId)) || operations.some(item => item.kind === "refund" || item.kind === "dispute_settlement" && (item.refundAmount > 0 || item.stripeRefundId) || ["partial_payout", "case_payout", "dispute_settlement"].includes(item.kind) && (["pending", "needs_reconciliation"].includes(item.status) || !priorTransfers.has(item.stripeTransferId || item.stripeObjectId) && (item.operationKey === eventKey(raw) || item.operationKey === `partial_payout:${id(raw._id)}:${id(raw.withdrawnParalegalId)}`)) || item.kind === "chargeback" && ["pending_review", "acknowledged"].includes(item.administrativeStatus))) fail(409, "EXPIRY_PAYMENT_REVIEW");
      const jobs = await postingSources(raw, session); if (!await postingReady(raw, jobs)) fail(409, "EXPIRY_POSTING_REVIEW");
      const change = { partialPayoutAmount: 0, payoutFinalizedType: "expired_zero", payoutFinalizedAt: now, disputeDeadlineAt: null, adminDisputeDeadlineAt: null, adminDisputeOverdueNotifiedAt: null, relistRequestedAt: amounts.remaining > 0 ? now : null, relistPending: false, remainingAmount: amounts.remaining };
      auditId = new mongoose.Types.ObjectId(fingerprint(["withdrawal_expired", id(raw._id), id(raw.withdrawnParalegalId), iso(raw.pausedAt), iso(raw.disputeDeadlineAt)]).slice(0, 24));
      await syncPosting(raw, change, session);
      const updated = await Case.collection.findOneAndUpdate(exact(raw), { $set: change, $inc: { __v: 1 } }, { session, returnDocument: "after" }); if (!updated) fail(409, "EXPIRY_CHANGED");
      await AuditLog.create([{ _id: auditId, actorRole: "system", action: "case.withdrawal.expired", case: raw._id, targetType: "case", targetId: id(raw._id), meta: { withdrawalAt: iso(raw.pausedAt), reviewDeadline: iso(raw.disputeDeadlineAt), paralegalId: id(raw.withdrawnParalegalId), remainingAmount: amounts.remaining, amountCents: 0 } }], { session });
      const dispatches = await require("./matterWithdrawalNotifications").stageDecision(updated, "expired", session);
      return { changed: true, doc: Case.hydrate(updated), dispatches };
    });
    for (const dispatch of result.dispatches || []) await dispatch();
    delete result.dispatches;
    return result;
  } catch (error) {
    if (auditId && await AuditLog.collection.findOne({ _id: auditId, action: "case.withdrawal.expired", case: new mongoose.Types.ObjectId(id(caseId)) }, { readConcern: { level: "majority" } })) return { changed: true, recovered: true };
    throw error;
  }
}
const sendError = (res, error) => res.status(error.status || error.statusCode || 503).json({ code: error.publicCode || "WORKSPACE_WITHDRAWAL_UNCONFIRMED", error: "The withdrawal decision could not be confirmed. Review the current Matter before continuing." });
// Shared read-only balance authority for replacement hiring.
module.exports = { read, execute, legacy, sendError, eventKey, actor, expire, amountFacts };
