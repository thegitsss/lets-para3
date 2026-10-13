const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose"), crypto = require("crypto");
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), User = require("../models/User"), AuditLog = require("../models/AuditLog"), Payout = require("../models/Payout"), PaymentOperation = require("../models/PaymentOperation");
const account = require("./attorneyAccountBoundary"), files = require("./attorneyMatterFiles"), payoutEvidence = require("./completionPayoutEvidence");
const { fingerprint } = require("./matterDraftRevision"), { normalizeCaseStatus } = require("../utils/caseState");
const { evaluateCompletionEligibility, CASE_ARCHIVE_RETENTION_MONTHS } = require("./attorneyWorkflowPolicy"), { getPayoutHold } = require("./payoutHoldService");
const id = value => String(value?._id || value || ""), valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fields = "payoutFailureReason title attorney attorneyId paralegal paralegalId paralegalNameSnapshot status tasks taskRevision __v files statusHistory archived readOnly purgedAt hiredAt withdrawnParalegalId pausedReason disputes disputeSettlement paymentIntentId escrowIntentId escrowStatus paymentStatus paymentReleased payoutTransferId payoutStatus paidOutAt totalAmount lockedTotalAmount remainingAmount feeParalegalPct feeParalegalAmount feeAttorneyPct feeAttorneyAmount currency stripeMode fundingIntegrityStatus fundingIntegrityFailure fundingVerifiedAt completionClaimStatus completionClaimToken completionClaimedAt completionClaimTransferId completionClaimError hiringClaimStatus hiringClaimToken withdrawalClaimStatus withdrawalClaimToken payoutFinalizedAt payoutFinalizedType completedAt archiveZipKey archiveReadyAt purgeScheduledFor".split(" ");
const projection = Object.fromEntries(fields.map(key => [key, 1]));
const exact = raw => ({ _id: raw._id, ...Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : { $eq: raw[key] }])) });
const fail = (status, suffix) => { throw Object.assign(new Error("Completion could not be confirmed. Review the current Matter and payment records before continuing."), { status, publicCode: `WORKSPACE_COMPLETION_${suffix}` }); };
const owner = req => req.method === "GET" ? req.query.expectedOwnerId : req.body?.expectedOwnerId;
async function actor(req) { try { return await account.read(req, owner(req)); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; } }
async function rawMatter(req, session) {
  await actor(req); if (!valid(req.params.caseId)) fail(400, "INVALID");
  const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) }, { projection, session });
  if (!raw) fail(404, "NOT_FOUND");
  if (![raw.attorney, raw.attorneyId].some(value => id(value) === owner(req)) || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId)) fail(403, "RESTRICTED");
  if (raw.paralegal && raw.paralegalId && id(raw.paralegal) !== id(raw.paralegalId)) fail(409, "CHANGED");
  return raw;
}
async function fileSummary(caseId, session) {
  const counts = { total: 0, awaitingReview: 0, revisions: 0, approved: 0, securityPending: 0 };
  const hash = crypto.createHash("sha256");
  const cursor = CaseFile.collection.find({ caseId: { $in: [caseId, id(caseId)] } }, { session, projection: Object.fromEntries([...files.fileFields, "createdAt", "previewKey"].map(key => [key, 1])), maxTimeMS: 10000 }).sort({ _id: 1 });
  for await (const raw of cursor) {
    counts.total++; if (raw.status === "approved") counts.approved++; else if (raw.status === "attorney_revision") counts.revisions++; else counts.awaitingReview++;
    if (!["clean", "not_required"].includes(raw.securityStatus)) counts.securityPending++;
    hash.update(fingerprint(raw));
  }
  return { ...counts, revision: hash.digest("hex") };
}
const logId = (req, requestId, kind) => new mongoose.Types.ObjectId(fingerprint(["attorney_completion", owner(req), requestId, kind]).slice(0, 24));
async function log(req, requestId, kind, session) {
  const raw = await AuditLog.collection.findOne({ _id: logId(req, requestId, kind) }, { session, ...(session ? {} : { readConcern: { level: "majority" } }) });
  if (raw && (id(raw.actor) !== owner(req) || id(raw.case) !== id(req.params.caseId) || raw.actorRole !== "attorney" || raw.action !== `case.completion.${kind}` || raw.meta?.kind !== "attorney_completion")) fail(409, "REQUEST_CHANGED");
  return raw;
}
function entry(req, requestId, kind, meta) { return { _id: logId(req, requestId, kind), actor: owner(req), actorRole: "attorney", case: req.params.caseId, targetType: "case", targetId: req.params.caseId, action: `case.completion.${kind}`, method: req.method, path: req.originalUrl?.split("?")[0], meta: { kind: "attorney_completion", ...meta } }; }
async function outcome(req, requestId, raw, evidence) {
  if (!requestId) return null;
  const [began, completed] = await Promise.all([log(req, requestId, "started"), log(req, requestId, "recorded")]);
  if (completed) return { status: normalizeCaseStatus(raw.status) === "completed" && evidence.state === "recorded" && raw.payoutStatus !== "needs_reconciliation" ? "recorded" : "recorded_needs_review", at: iso(completed.createdAt) };
  if (!began) return { status: "not_found", at: null };
  return { status: raw.completionClaimToken === requestId ? raw.completionClaimStatus === "claimed" && iso(raw.completionClaimedAt) && Date.now() - new Date(raw.completionClaimedAt).getTime() < 10 * 60 * 1000 ? "processing" : "needs_review" : evidence.state !== "none" || raw.paymentReleased ? "needs_review" : "not_completed", at: null };
}
async function snapshot(req, requestId) {
  const user = await actor(req), raw = await rawMatter(req), paraId = id(raw.paralegal || raw.paralegalId);
  const [documents, evidence, hold, person] = await Promise.all([fileSummary(raw._id), valid(paraId) || raw.paymentReleased || raw.payoutTransferId ? payoutEvidence.inspect(raw) : Promise.resolve({ state: "none", payout: null, operation: null }), getPayoutHold(raw._id), valid(paraId) ? User.collection.findOne({ _id: new mongoose.Types.ObjectId(paraId) }, { projection: { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1, stripeAccountId: 1, stripeOnboarded: 1, stripePayoutsEnabled: 1 } }) : null]);
  const policy = evaluateCompletionEligibility({ caseDoc: raw, ownerAuthorized: true, reconcileReleasedPayout: evidence.state === "recorded" }), completed = normalizeCaseStatus(raw.status) === "completed";
  const blockers = [...policy.blockers];
  if (!policy.applicable && !completed) blockers.push("active_matter_required");
  if (completed) blockers.push(evidence.state === "recorded" ? "completed" : "payout_reconciliation");
  if (raw.hiringClaimStatus || raw.hiringClaimToken || raw.withdrawalClaimStatus || raw.withdrawalClaimToken) blockers.push("hiring_processing");
  if (raw.completionClaimStatus || raw.completionClaimToken) blockers.push(raw.completionClaimStatus === "needs_reconciliation" || raw.completionClaimStatus === "claimed" && (!iso(raw.completionClaimedAt) || Date.now() - new Date(raw.completionClaimedAt).getTime() >= 10 * 60 * 1000) ? "completion_reconciliation" : "completion_processing");
  if (evidence.state === "needs_review" || raw.payoutStatus === "needs_reconciliation") blockers.push("payout_reconciliation");
  if (evidence.operation?.status === "pending") blockers.push("payout_processing");
  if (evidence.operation?.status === "failed") blockers.push("payout_reconciliation");
  if (hold.held) blockers.push("payment_review");
  if (raw.fundingIntegrityStatus === "failed" || raw.paymentIntentId && raw.escrowIntentId && raw.paymentIntentId !== raw.escrowIntentId) blockers.push("funding_reconciliation");
  if (raw.purgedAt) blockers.push("matter_removed");
  if (evidence.state !== "recorded" && (!person || person.role !== "paralegal" || person.status !== "approved" || person.deleted || person.disabled || !person.stripeAccountId || !person.stripeOnboarded || !person.stripePayoutsEnabled)) blockers.push("payout_setup_required");
  const currency = typeof raw.currency === "string" ? raw.currency.toUpperCase() : "USD", amount = payoutEvidence.amountFor(raw), gross = raw.remainingAmount ?? raw.lockedTotalAmount ?? raw.totalAmount;
  let currencyValid = false; try { currencyValid = Intl.supportedValuesOf("currency").includes(currency) && new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits === 2; } catch { /* Unrecognized currency has no payable preview. */ }
  if (amount === null || !currencyValid) blockers.push("amount_unavailable");
  const operation = await outcome(req, requestId, raw, evidence);
  if (operation?.status === "recorded_needs_review") blockers.push("completion_reconciliation");
  const revision = fingerprint([user, fields.map(key => raw[key]), documents, evidence, hold.operation?.toObject(), person]);
  const dto = { retentionMonths: CASE_ARCHIVE_RETENTION_MONTHS, ownerId: owner(req), caseId: id(raw._id), caseTitle: typeof raw.title === "string" ? raw.title : "Untitled Matter", paralegalId: valid(paraId) ? paraId : null, paralegalName: [person?.firstName, person?.lastName].filter(value => typeof value === "string").join(" ") || (typeof raw.paralegalNameSnapshot === "string" ? raw.paralegalNameSnapshot : "") || "Paralegal", revision, closed: normalizeCaseStatus(raw.status) === "closed", withdrawalActive: !valid(paraId) && valid(id(raw.withdrawnParalegalId)) && raw.pausedReason === "paralegal_withdrew", canComplete: policy.ready && !blockers.length, blockers: [...new Set(blockers)], mode: evidence.state === "recorded" ? "finish_completion" : "complete_and_release", payoutState: evidence.state, grossCents: Number.isSafeInteger(gross) && gross > 0 ? gross : null, payoutCents: amount, feeCents: amount !== null && Number.isSafeInteger(gross) ? gross - amount : null, currency: currencyValid ? currency : null, work: { total: Array.isArray(raw.tasks) ? raw.tasks.length : 0, complete: (Array.isArray(raw.tasks) ? raw.tasks : []).filter(task => task.completed === true).length }, documents: { ...documents, revision: undefined }, completedAt: iso(raw.completedAt), archiveReady: Boolean(raw.archiveZipKey && raw.archiveReadyAt), purgeAt: iso(raw.purgeScheduledFor), operation };
  return { raw, user, person, documents, evidence, dto };
}
async function reviewed(req, requestId) {
  const first = await snapshot(req, requestId), latest = await snapshot(req, requestId);
  if (first.dto.revision !== latest.dto.revision) fail(409, "CHANGED");
  await actor(req); return latest;
}
async function read(req) {
  if (Object.keys(req.query).some(key => !["expectedOwnerId", "requestId"].includes(key)) || req.query.requestId !== undefined && !uuid(req.query.requestId)) fail(400, "INVALID");
  return (await reviewed(req, req.query.requestId)).dto;
}
const confirmation = dto => ({ caseId: dto.caseId, paralegalId: dto.paralegalId, reviewedRevision: dto.revision, mode: dto.mode, grossCents: dto.grossCents, payoutCents: dto.payoutCents, currency: dto.currency });
const confirmationHash = value => fingerprint(["caseId", "paralegalId", "reviewedRevision", "mode", "grossCents", "payoutCents", "currency"].map(key => value[key]));
async function prepare(req) {
  const body = req.body || {};
  if (Object.keys(body).some(key => !["expectedOwnerId", "requestId", "confirmation"].includes(key)) || !uuid(body.requestId) || !body.confirmation || typeof body.confirmation !== "object" || Array.isArray(body.confirmation) || Object.keys(body.confirmation).length !== 7 || Object.keys(body.confirmation).some(key => !["caseId", "paralegalId", "reviewedRevision", "mode", "grossCents", "payoutCents", "currency"].includes(key))) fail(400, "INVALID");
  await actor(req); const existing = await log(req, body.requestId, "started");
  if (existing) {
    if (confirmationHash(body.confirmation) !== existing.meta.confirmationHash) fail(409, "REQUEST_CHANGED");
    return { recovered: (await reviewed(req, body.requestId)).dto };
  }
  const result = await reviewed(req, body.requestId);
  if (confirmationHash(body.confirmation) !== confirmationHash(confirmation(result.dto))) fail(409, "CHANGED");
  if (!result.dto.canComplete) fail(409, "BLOCKED");
  return result;
}
async function ready() { let timer; try { await Promise.race([Promise.all([AuditLog.init(), Payout.init(), PaymentOperation.init()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Completion initialization incomplete")), 8000); })]); } finally { clearTimeout(timer); } }
async function transaction(callback) {
  await ready(); const session = await mongoose.startSession();
  try { session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 }); const result = await callback(session); await session.commitTransaction(); return result; }
  catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyCompletion.transaction_abort")); if (error.publicCode) throw error; if (error.code === 11000 || error.code === 112 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED"); fail(503, "UNCONFIRMED"); }
  finally { await session.endSession(); }
}
async function claim(req, review) {
  const token = req.body.requestId, now = new Date();
  return transaction(async session => {
    const raw = await rawMatter(req, session); if (fingerprint(fields.map(key => raw[key])) !== fingerprint(fields.map(key => review.raw[key]))) fail(409, "CHANGED");
    const documents = await fileSummary(raw._id, session); if (documents.revision !== review.documents.revision) fail(409, "CHANGED");
    const change = { completionClaimToken: token, completionClaimedAt: now, completionClaimStatus: "claimed", completionClaimTransferId: "", completionClaimError: "" };
    const result = await Case.collection.findOneAndUpdate(exact(raw), { $set: change, $inc: { __v: 1 } }, { session, returnDocument: "after" }); if (!result) fail(409, "CHANGED");
    await AuditLog.create([entry(req, token, "started", { confirmationHash: confirmationHash(req.body.confirmation), reviewedRevision: review.dto.revision })], { session }); await actor(req);
    return { token, acquired: true, caseDoc: Case.hydrate(result), facts: { ...raw, ...change, __v: Number(raw.__v || 0) + 1 } };
  });
}
async function beforeRelease(req, review, claimed) {
  const raw = await rawMatter(req);
  if (fingerprint(fields.map(key => raw[key])) !== fingerprint(fields.map(key => claimed.facts[key])) || (await fileSummary(raw._id)).revision !== review.documents.revision) fail(409, "CHANGED");
  const paraId = review.dto.paralegalId;
  const person = paraId ? await User.collection.findOne({ _id: new mongoose.Types.ObjectId(paraId) }, { projection: { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1, stripeAccountId: 1, stripeOnboarded: 1, stripePayoutsEnabled: 1 } }) : null;
  if (fingerprint(person) !== fingerprint(review.person) || (await getPayoutHold(raw._id)).held) fail(409, "CHANGED");
  await actor(req);
}
async function afterTransfer(req, transferId) {
  const raw = await rawMatter(req);
  if (typeof transferId !== "string" || !/^(?:tr_|bypass_)[A-Za-z0-9_]{1,200}$/.test(transferId) || ["failed", "reversed", "needs_reconciliation"].includes(raw.payoutStatus) || raw.payoutTransferId && raw.payoutTransferId !== transferId) fail(409, "PAYMENT_CHANGED");
}
async function finish(req, review, claimed, doc) {
  try { return await transaction(async session => {
    const raw = await rawMatter(req, session), expected = { ...claimed.facts, completionClaimTransferId: doc.payoutTransferId };
    // A matching transfer.created webhook may update payment projections while
    // the provider call returns. Preserve that timestamp and accept only these
    // positive projections; assignment/work/claim changes and negative payment
    // evidence still prevent closure.
    const paymentFields = ["payoutTransferId", "payoutStatus", "payoutFailureReason", "paidOutAt", "paymentReleased"];
    const unchangedFields = fields.filter(key => !paymentFields.includes(key));
    if (fingerprint(unchangedFields.map(key => raw[key])) !== fingerprint(unchangedFields.map(key => expected[key])) || (await fileSummary(raw._id, session)).revision !== review.documents.revision) fail(409, "CHANGED");
    const paymentChanged = fingerprint(paymentFields.map(key => raw[key])) !== fingerprint(paymentFields.map(key => expected[key]));
    if (paymentChanged && (raw.payoutTransferId !== doc.payoutTransferId || raw.payoutStatus !== "paid" || raw.payoutFailureReason || !iso(raw.paidOutAt) || expected.paymentReleased === true && raw.paymentReleased !== true)) fail(409, "CHANGED");
    if (paymentChanged) doc.paidOutAt = raw.paidOutAt;
    const evidence = await payoutEvidence.requireRecorded(doc, { session }), row = evidence.payout;
    const locked = await Payout.collection.updateOne(files.exact(row, Object.keys(row)), { $inc: { __v: 1 } }, { session }); if (locked.matchedCount !== 1) fail(409, "CHANGED");
    if (evidence.operation) { const operation = evidence.operation, lockedOperation = await PaymentOperation.collection.updateOne(files.exact(operation, Object.keys(operation)), { $inc: { __v: 1 } }, { session }); if (lockedOperation.matchedCount !== 1) fail(409, "CHANGED"); }
    const result = await Case.collection.updateOne(exact(raw), { $inc: { __v: 1 } }, { session }); if (result.matchedCount !== 1) fail(409, "CHANGED");
    doc.transitionTo("completed"); await doc.save({ session });
    await AuditLog.create([entry(req, req.body.requestId, "recorded", { reviewedRevision: review.dto.revision, payoutCents: review.dto.payoutCents, currency: review.dto.currency })], { session });
    const dispatches = await require("./matterPaymentNotifications").stageCompletion(doc, session, req.user.id);
    await actor(req); return dispatches;
  }); } catch (error) {
    if (await log(req, req.body.requestId, "recorded")) return;
    throw error;
  }
}
const sendError = (res, error) => res.status(error.status || error.statusCode || 503).json({ code: error.publicCode || "WORKSPACE_COMPLETION_UNCONFIRMED", error: "Completion could not be confirmed. Check the current Matter and payment records before continuing." });
module.exports = { read, prepare, claim, beforeRelease, afterTransfer, finish, sendError, confirmation, actor };
