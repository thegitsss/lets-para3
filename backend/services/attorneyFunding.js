const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose"), crypto = require("crypto");
const Case = require("../models/Case"), User = require("../models/User"), PaymentOperation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), AuditLog = require("../models/AuditLog");
const account = require("./attorneyAccountBoundary"), { findActiveSession } = require("./authSessionService"), { fingerprint } = require("./matterDraftRevision"), { normalizeCaseStatus } = require("../utils/caseState");
const { expectedCaseFunding, validatePaymentIntentForCase } = require("../utils/paymentIntegrity"), financial = require("./attorneyFinancialHistory"), { inspectFundingCandidate, operationMatchesEvidence, fundingOperationKey, captureRecoveryUpdate } = require("./fundingEvidenceBackfillService");
const { buildFundingFingerprint } = require("../utils/funding"), { operationFingerprint } = require("../utils/paymentOperationFingerprint"), { currentStripeMode } = require("../utils/stripeMode");
const Job = require("../models/Job");
const { MIN_MATTER_AMOUNT_CENTS } = require("./attorneyWorkflowPolicy");
const id = value => String(value?._id || value || ""), validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value), money = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value), hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const external = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(value), iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fields = "attorney attorneyId paralegal paralegalId title status archived readOnly purgedAt hiredAt tasks taskRevision applicants invites preEngagement pendingParalegalId job jobId currency stripeMode totalAmount lockedTotalAmount remainingAmount feeAttorneyPct feeAttorneyAmount feeParalegalPct feeParalegalAmount paymentIntentId escrowIntentId escrowSessionId escrowStatus paymentStatus fundingIntegrityStatus fundingIntegrityFailure fundingVerifiedAt fundingRequestKey fundingRequestFingerprint paymentReleased payoutStatus payoutTransferId paidOutAt withdrawnParalegalId payoutFinalizedAt payoutFinalizedType partialPayoutAmount pausedAt pausedReason disputeDeadlineAt disputes withdrawalHistory disputeSettlement hiringClaimToken hiringClaimStatus hiringClaimPaymentIntentId completionClaimToken completionClaimStatus withdrawalClaimToken withdrawalClaimStatus __v".split(" ");
const projection = Object.fromEntries(fields.map(key => [key, 1])), exact = raw => ({ _id: raw._id, ...Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : { $eq: raw[key] }])) });
const personFields = { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1, stripeCustomerId: 1 };
const approvedFundingParticipant = (person, role) => person?.role === role && person.status === "approved" && !person.disabled && !person.deleted;
const fail = (status, suffix) => { throw Object.assign(new Error("The Matter funding details could not be verified. Review the current payment before continuing."), { status, publicCode: `WORKSPACE_FUNDING_${suffix}` }); };
const expected = req => req.method === "GET" ? req.query?.expectedOwnerId : req.body?.expectedOwnerId;
async function actor(req, allowAdmin = false) {
  if (req.user?.role === "attorney") { try { return await account.read(req, expected(req), ["stripeCustomerId"]); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; } }
  const actorId = id(req.user?.id);
  if (!allowAdmin || req.user?.role !== "admin" || expected(req) !== actorId || !validId(actorId)) fail(403, "ACCOUNT_CHANGED");
  const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(actorId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!user || user.role !== "admin" || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, actorId)) fail(403, "ACCOUNT_CHANGED"); return user;
}
async function rawMatter(req, allowAdmin, session) {
  await actor(req, allowAdmin); if (!validId(req.params.caseId)) fail(400, "INVALID");
  const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) }, { projection, session }); if (!raw) fail(404, "NOT_FOUND");
  if (!validId(id(raw.attorney || raw.attorneyId)) || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId)) fail(409, "OWNERSHIP_CHANGED");
  if (req.user.role !== "admin" && id(raw.attorney || raw.attorneyId) !== expected(req)) fail(403, "RESTRICTED");
  if (raw.paralegal && raw.paralegalId && id(raw.paralegal) !== id(raw.paralegalId)) fail(409, "ASSIGNMENT_CHANGED"); return raw;
}
function amountsFor(raw) {
  const base = raw.lockedTotalAmount ?? raw.totalAmount;
  if (!money(base) || base <= 0 || raw.feeAttorneyAmount != null && !money(raw.feeAttorneyAmount) || raw.feeAttorneyPct != null && (typeof raw.feeAttorneyPct !== "number" || !Number.isFinite(raw.feeAttorneyPct) || raw.feeAttorneyPct < 0 || raw.feeAttorneyPct > 100)) return { baseCents: money(base) ? base : null, feeCents: null, totalCents: null, currency: null, feePct: null, canCharge: false };
  const expectedAmount = expectedCaseFunding(raw), currency = typeof raw.currency === "string" ? raw.currency.toUpperCase() : "USD";
  let code = null; try { if (Intl.supportedValuesOf("currency").includes(currency) && new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits === 2) code = currency; } catch { /* Do not invent a minor unit. */ }
  const feeCents = expectedAmount.feeAmount, totalCents = expectedAmount.totalAmount, consistent = feeCents === Math.round(base * expectedAmount.feePercent / 100);
  return { baseCents: base, feeCents: money(feeCents) ? feeCents : null, totalCents: money(totalCents) ? totalCents : null, currency: code, feePct: consistent ? expectedAmount.feePercent : null, canCharge: Boolean(code && consistent && base >= MIN_MATTER_AMOUNT_CENTS && money(totalCents) && totalCents <= 99999999) };
}
const logId = (req, requestId, kind) => new mongoose.Types.ObjectId(fingerprint(["matter_funding", expected(req), requestId, kind]).slice(0, 24));
async function log(req, requestId, kind, session) {
  const saved = await AuditLog.collection.findOne({ _id: logId(req, requestId, kind) }, { session, ...(session ? {} : { readConcern: { level: "majority" } }) });
  if (saved && (id(saved.actor) !== expected(req) || id(saved.case) !== req.params.caseId || saved.action !== `case.funding.${kind}` || saved.meta?.kind !== "matter_funding")) fail(409, "REQUEST_CHANGED"); return saved;
}
const entry = (req, requestId, kind, meta) => ({ _id: logId(req, requestId, kind), actor: expected(req), actorRole: req.user.role, case: req.params.caseId, action: `case.funding.${kind}`, targetType: "case", targetId: req.params.caseId, meta: { kind: "matter_funding", ...meta } });
async function outcome(req, requestId) {
  if (!requestId) return null;
  const [started, prepared, checked] = await Promise.all([log(req, requestId, "started"), log(req, requestId, "prepared"), log(req, requestId, "checked")]);
  const saved = prepared || checked || started;
  return { requestId, action: saved?.meta.action || null, status: prepared ? "prepared" : checked ? "checked" : started ? Date.now() - new Date(started.createdAt).getTime() < 600000 ? "processing" : "needs_review" : "not_found", at: iso(saved?.createdAt) };
}
async function snapshot(req, requestId, allowAdmin = false) {
  const user = await actor(req, allowAdmin), raw = await rawMatter(req, allowAdmin), ownerId = id(raw.attorney || raw.attorneyId), paraId = id(raw.paralegal || raw.paralegalId), caseRefs = [raw._id, id(raw._id)];
  const [owner, person, operations, payouts] = await Promise.all([
    User.collection.findOne({ _id: new mongoose.Types.ObjectId(ownerId) }, { projection: personFields }),
    validId(paraId) ? User.collection.findOne({ _id: new mongoose.Types.ObjectId(paraId) }, { projection: personFields }) : null,
    PaymentOperation.collection.find({ caseId: { $in: caseRefs } }).sort({ _id: 1 }).limit(4001).toArray(),
    Payout.collection.find({ caseId: { $in: caseRefs } }).sort({ _id: 1 }).limit(4001).toArray(),
  ]);
  if (operations.length > 4000 || payouts.length > 4000) fail(413, "TOO_LARGE");
  const intentIds = [...new Set([raw.paymentIntentId, raw.escrowIntentId].filter(Boolean))], allIntentIds = [...new Set([...intentIds, ...operations.filter(op => op.kind === "funding").flatMap(op => [op.stripePaymentIntentId, op.stripeObjectId])].filter(value => external(value, "pi")))];
  const fundingOps = operations.filter(op => op.kind === "funding");
  const [fundingReferences, fundingOperations] = await Promise.all([
    Case.collection.find({ $or: [{ paymentIntentId: { $in: allIntentIds } }, { escrowIntentId: { $in: allIntentIds } }] }, { projection: { paymentIntentId: 1, escrowIntentId: 1 } }).sort({ _id: 1 }).limit(4001).toArray(),
    PaymentOperation.collection.find({ kind: "funding", $or: [{ stripePaymentIntentId: { $in: allIntentIds } }, { stripeObjectId: { $in: allIntentIds } }, { stripeChargeId: { $in: fundingOps.map(op => op.stripeChargeId).filter(Boolean) } }, { stripeBalanceTransactionId: { $in: fundingOps.map(op => op.stripeBalanceTransactionId).filter(Boolean) } }] }, { projection: { stripePaymentIntentId: 1, stripeObjectId: 1, stripeChargeId: 1, stripeBalanceTransactionId: 1 } }).sort({ _id: 1 }).limit(4001).toArray(),
  ]);
  if (fundingReferences.length > 4000 || fundingOperations.length > 4000) fail(413, "TOO_LARGE");
  const history = financial.rowsFor({ cases: [raw], operations, payouts, fundingReferences, fundingOperations, people: person ? [person] : [] }), amounts = amountsFor(raw), fundingRows = history.filter(row => row.type === "funding"), recorded = fundingRows.filter(row => row.state === "recorded");
  const fundingVerified = recorded.length === 1 && recorded[0].amount === amounts.totalCents && recorded[0].currency === amounts.currency;
  const closed = raw.archived || raw.readOnly || raw.purgedAt || raw.paymentReleased || !["open", "in progress"].includes(normalizeCaseStatus(raw.status));
  const claims = [raw.hiringClaimToken, raw.hiringClaimStatus, raw.completionClaimToken, raw.completionClaimStatus, raw.withdrawalClaimToken, raw.withdrawalClaimStatus].some(Boolean);
  const held = operations.some(op => op.kind === "chargeback" && ["pending_review", "acknowledged"].includes(op.administrativeStatus)), dispute = raw.disputes?.some(item => String(item.status || "open").toLowerCase() === "open");
  const blockers = [];
  if (!amounts.canCharge) blockers.push("amount_needs_review");
  if (intentIds.length > 1 || intentIds.some(value => !external(value, "pi")) || raw.escrowSessionId && !intentIds.length || fundingReferences.some(row => id(row._id) !== id(raw._id)) || fundingOperations.some(row => !operations.some(op => id(op._id) === id(row._id)))) blockers.push("payment_reference_needs_review");
  if (claims) blockers.push("decision_processing");
  if (held || dispute) blockers.push("payment_review");
  if (!owner || owner.role !== "attorney" || owner.status !== "approved" || owner.disabled || owner.deleted) blockers.push("owner_unavailable");
  const canCheck = intentIds.length === 1 && external(intentIds[0], "pi") && !claims;
  if (["processing", "requires_capture"].includes(raw.paymentStatus)) blockers.push("payment_processing");
  const financialFootprint = payouts.length || history.some(row => ["refund", "withdrawal", "chargeback"].includes(row.type)) || fundingVerified || raw.escrowStatus === "funded" || raw.paymentReleased;
  const preparationUnconfirmed = Boolean(raw.fundingRequestKey && !intentIds.length);
  const canPrepare = !closed && normalizeCaseStatus(raw.status) === "open" && validId(paraId) && person?.role === "paralegal" && person.status === "approved" && !person.disabled && !person.deleted && raw.lockedTotalAmount != null && !blockers.length && !financialFootprint && !preparationUnconfirmed && !raw.escrowSessionId;
  const canEditAmount = normalizeCaseStatus(raw.status) === "open" && !closed && !paraId && !raw.hiredAt && raw.lockedTotalAmount == null && !raw.pendingParalegalId && !(raw.applicants || []).length && !(raw.invites || []).some(item => item.paralegalId && String(item.status || "pending").toLowerCase() === "pending") && !claims && !financialFootprint && !raw.fundingRequestKey && !raw.escrowSessionId && !intentIds.length;
  const state = fundingVerified ? "verified" : claims || preparationUnconfirmed ? "needs_review" : blockers.length || financialFootprint ? "needs_review" : intentIds.length ? "unconfirmed" : paraId ? "awaiting_payment" : "not_requested";
  const revision = fingerprint([user, raw, owner, person, operations, payouts, fundingReferences, fundingOperations]);
  return { raw, user, owner, person, operations, payouts, fundingReferences, fundingOperations, amounts, dto: { ownerId: expected(req), caseId: id(raw._id), caseTitle: typeof raw.title === "string" && raw.title || "Untitled Matter", revision, state, blockers: [...new Set(blockers)], fundingVerified, verifiedAt: fundingVerified ? recorded[0].recordedAt : null, baseCents: amounts.baseCents, feeCents: amounts.feeCents, totalCents: amounts.totalCents, currency: amounts.currency, feePct: amounts.feePct, paralegalName: person ? [person.firstName, person.lastName].filter(value => typeof value === "string").join(" ") || "Paralegal" : null, hasOriginalCheckout: Boolean(raw.escrowSessionId), canPrepare, canCheck, canEditAmount, closed: Boolean(closed), operation: await outcome(req, requestId) } };
}
async function reviewed(req, requestId, allowAdmin = false) { const first = await snapshot(req, requestId, allowAdmin), latest = await snapshot(req, requestId, allowAdmin); if (first.dto.revision !== latest.dto.revision) fail(409, "CHANGED"); await actor(req, allowAdmin); return latest; }
async function read(req) {
  if (Object.keys(req.query).some(key => !["expectedOwnerId", "requestId"].includes(key)) || req.query.requestId !== undefined && !uuid(req.query.requestId)) fail(400, "INVALID");
  return (await reviewed(req, req.query.requestId)).dto;
}
async function transaction(work) {
  let timer; try { await Promise.race([Promise.all([Case.init(), AuditLog.init(), PaymentOperation.init(), Job.init()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Funding initialization incomplete")), 8000); })]); } finally { clearTimeout(timer); }
  const session = await mongoose.startSession();
  try { session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 }); const result = await work(session); await session.commitTransaction(); return result; }
  catch (error) { if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyFunding.transaction_abort")); if (error.publicCode) throw error; if (error.code === 11000 || error.code === 112 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED"); fail(503, "UNCONFIRMED"); }
  finally { await session.endSession(); }
}

function validateIntent(intent, view, { unrecorded = false } = {}) {
  const raw = unrecorded ? { ...view.raw, escrowIntentId: "", paymentIntentId: "" } : view.raw;
  if (!external(intent?.id, "pi") || !validatePaymentIntentForCase(intent, raw).valid || !view.amounts.canCharge || intent.amount !== view.amounts.totalCents || typeof intent.livemode !== "boolean" || intent.metadata?.attorneyId && intent.metadata.attorneyId !== id(raw.attorney || raw.attorneyId) || intent.customer && id(intent.customer?.id || intent.customer) !== view.owner?.stripeCustomerId) fail(409, "PAYMENT_MISMATCH");
  if (!Object.hasOwn({ requires_payment_method: 1, requires_confirmation: 1, requires_action: 1, processing: 1, requires_capture: 1, canceled: 1, succeeded: 1 }, intent.status)) fail(409, "PAYMENT_MISMATCH");
  const mode = currentStripeMode(); if (mode !== "unknown" && mode !== (intent.livemode ? "live" : "test")) fail(409, "PAYMENT_MISMATCH");
}
async function sameReview(req, view, allowAdmin) {
  const next = await reviewed(req, null, allowAdmin); if (next.dto.revision !== view.dto.revision) fail(409, "CHANGED"); return next;
}
function preparationSource(view) {
  const raw = { ...view.raw }; for (const key of ["fundingRequestKey", "fundingRequestFingerprint", "paymentIntentId", "escrowIntentId", "__v"]) delete raw[key];
  return fingerprint([raw, view.user, view.owner, view.person, view.operations, view.payouts]);
}
async function updateCase(view, values, session) {
  const result = await Case.collection.updateOne(exact(view.raw), { $set: { ...values, updatedAt: new Date() }, $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1) fail(409, "CHANGED");
}
async function retrieve(stripe, intentId) {
  try { return await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge.balance_transaction"] }); }
  catch { fail(502, "PROVIDER_UNAVAILABLE"); }
}
function paymentForm(intent) {
  if (!["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status) || typeof intent.client_secret !== "string" || !intent.client_secret.startsWith(`${intent.id}_secret_`) || !/^[A-Za-z0-9_]+$/.test(intent.client_secret) || intent.client_secret.length > 500) fail(409, "PAYMENT_NOT_READY");
  return { intentId: intent.id, clientSecret: intent.client_secret, status: intent.status };
}
async function expandCapturedIntent(intent, view, stripe) {
  if (intent.status === "succeeded") {
    let charge = intent.latest_charge || intent.charges?.data?.[0];
    if (typeof charge === "string") { try { charge = await stripe.charges.retrieve(charge, { expand: ["balance_transaction"] }); } catch { fail(502, "PROVIDER_UNAVAILABLE"); } }
    let balance = charge?.balance_transaction;
    if (typeof balance === "string") { try { balance = await stripe.balanceTransactions.retrieve(balance); } catch { fail(502, "PROVIDER_UNAVAILABLE"); } }
    if (intent.amount_received !== view.amounts.totalCents || !charge || !external(charge.id, "ch") || id(charge.payment_intent?.id || charge.payment_intent) !== intent.id || charge.paid !== true || charge.captured !== true || charge.status !== "succeeded" || charge.amount_captured !== intent.amount_received || charge.livemode !== intent.livemode || charge.transfer_group && charge.transfer_group !== `case_${view.raw._id}` || !balance || id(balance.source?.id || balance.source) !== charge.id) fail(409, "PAYMENT_NEEDS_REVIEW");
    intent = { ...intent, latest_charge: { ...charge, balance_transaction: balance } };
  }
  return intent;
}
const fundingStatuses = new Set(["", "pending", "requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded", "verification_failed"]);
function paymentProjection(raw, status, operations = [], payouts = []) {
  if (!fundingStatuses.has(String(raw.paymentStatus || "").toLowerCase())) return {};
  if (payouts.length || operations.some(op => op.kind !== "funding")) return {};
  if (status !== "succeeded" && (raw.escrowStatus === "funded" || raw.fundingIntegrityStatus === "verified" || raw.paymentStatus === "succeeded" || !mayActivateFunding(raw))) return {};
  return raw.paymentStatus === status ? {} : { paymentStatus: status };
}
function mayActivateFunding(raw, operations = [], payouts = []) {
  return !raw.archived && !raw.readOnly && !raw.purgedAt && !raw.paymentReleased && !raw.paidOutAt && !raw.payoutTransferId && !raw.payoutFinalizedAt && !raw.withdrawnParalegalId && !raw.withdrawalHistory?.length && !Object.values(raw.disputeSettlement || {}).some(value => value != null && value !== "" && value !== 0) && !raw.disputes?.length && !raw.pausedAt && !raw.pausedReason &&
    ["open", "in progress"].includes(normalizeCaseStatus(raw.status)) && [null, undefined, "", "awaiting_funding", "funded"].includes(raw.escrowStatus) && [null, undefined, "", "not_started"].includes(raw.payoutStatus) && fundingStatuses.has(String(raw.paymentStatus || "").toLowerCase()) &&
    ![raw.hiringClaimToken, raw.hiringClaimStatus, raw.completionClaimToken, raw.completionClaimStatus, raw.withdrawalClaimToken, raw.withdrawalClaimStatus].some(Boolean) && !payouts.length && !operations.some(op => op.kind !== "funding");
}
async function lockFundingActivation(view, session, options) {
  if (view.raw.escrowStatus === "funded" && normalizeCaseStatus(view.raw.status) === "in progress" && view.raw.hiredAt) return;
  const members = [[id(view.raw.attorney || view.raw.attorneyId), "attorney"], [id(view.raw.paralegal || view.raw.paralegalId), "paralegal"]];
  await require("../utils/activeAccountWrite").lockActiveAccounts(members.map(([userId]) => userId), session, options);
  // The shared write lock also arbitrates concurrent account removal or role
  // changes. Captured payment evidence can still be reconciled on the retry.
  for (const [userId, role] of members) {
    const person = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }, { session, projection: personFields });
    if (!approvedFundingParticipant(person, role)) fail(409, "ASSIGNMENT_CHANGED");
  }
}
async function verifyAndRecord(req, view, intent, stripe, requestId, action, allowAdmin) {
  validateIntent(intent, view);
  intent = await expandCapturedIntent(intent, view, stripe);
  const inspection = intent.status === "succeeded" ? await inspectFundingCandidate({ caseDoc: view.raw, operations: view.operations, stripeClient: stripe, paymentIntent: intent, allowCaptureRecovery: true }) : null;
  if (inspection?.action === "review") fail(409, "PAYMENT_NEEDS_REVIEW");
  if (inspection) {
    const evidence = inspection.evidence;
    if (!external(evidence.stripeChargeId, "ch") || !external(evidence.stripeBalanceTransactionId, "txn") || view.fundingReferences.some(row => id(row._id) !== req.params.caseId) || view.fundingOperations.some(row => !view.operations.some(op => id(op._id) === id(row._id)))) fail(409, "PAYMENT_NEEDS_REVIEW");
    // Check references learned from the provider as well as the saved inventory.
    const shared = await PaymentOperation.collection.findOne({ kind: "funding", caseId: { $nin: [view.raw._id, req.params.caseId] }, $or: [{ stripePaymentIntentId: intent.id }, { stripeObjectId: intent.id }, { stripeChargeId: evidence.stripeChargeId }, { stripeBalanceTransactionId: evidence.stripeBalanceTransactionId }] });
    if (shared) fail(409, "PAYMENT_NEEDS_REVIEW");
  }
  await sameReview(req, view, allowAdmin);
  let dispatchNotice;
  await transaction(async session => {
    await actor(req, allowAdmin);
    if (await log(req, requestId, "checked", session)) return;
    const refs = [view.raw._id, req.params.caseId], operations = await PaymentOperation.collection.find({ caseId: { $in: refs } }, { session }).sort({ _id: 1 }).limit(4001).toArray(), payouts = await Payout.collection.find({ caseId: { $in: refs } }, { session }).sort({ _id: 1 }).limit(4001).toArray();
    if (fingerprint([operations, payouts]) !== fingerprint([view.operations, view.payouts])) fail(409, "CHANGED");
    const now = new Date(), values = paymentProjection(view.raw, intent.status, view.operations, view.payouts);
    if (inspection) {
      const evidence = inspection.evidence;
      if (inspection.action === "create") await PaymentOperation.create([{ operationKey: fundingOperationKey(req.params.caseId, intent.id), caseId: view.raw._id, kind: "funding", fingerprint: operationFingerprint(evidence), status: "succeeded", amount: evidence.grossAmount, stripeObjectId: intent.id, ...evidence, evidenceVerifiedAt: now, completedAt: now }], { session });
      else {
        const operation = view.operations.find(row => id(row._id) === id(inspection.operationId)); if (!operation) fail(409, "CHANGED");
        const recovery = inspection.action === "recover" ? captureRecoveryUpdate(operation, evidence, now) : null;
        const compare = operationMatchesEvidence(operation, evidence); if (inspection.action === "recover" ? !recovery : compare.conflicts.length) fail(409, "PAYMENT_NEEDS_REVIEW");
        const result = await PaymentOperation.collection.updateOne({ _id: operation._id, ...Object.fromEntries(Object.entries(operation).filter(([key]) => key !== "_id").map(([key, value]) => [key, { $eq: value }])) }, { $set: { ...(recovery || compare.missing), ...(!operation.evidenceVerifiedAt ? { evidenceVerifiedAt: now } : {}) } }, { session }); if (result.matchedCount !== 1) fail(409, "CHANGED");
      }
      Object.assign(values, { paymentIntentId: intent.id, escrowIntentId: intent.id, stripeMode: intent.livemode ? "live" : "test", fundingIntegrityStatus: "verified", fundingIntegrityFailure: "", fundingVerifiedAt: view.raw.fundingVerifiedAt || now });
      // Historical checks record original funding; they do not reopen a closed,
      // withdrawn, paid-out or disputed Matter or replace its remaining amount.
      if (mayActivateFunding(view.raw, view.operations, view.payouts) && !view.dto.closed && !view.dto.blockers.filter(value => value !== "payment_processing").length && approvedFundingParticipant(view.owner, "attorney") && approvedFundingParticipant(view.person, "paralegal")) {
        await lockFundingActivation(view, session, req.user.role === "attorney" ? { ownerId: expected(req), authVersion: req.auth?.payload?.av || 0 } : undefined);
        values.escrowStatus = "funded";
        if (view.raw.paralegal || view.raw.paralegalId) { values.status = "in progress"; if (!view.raw.hiredAt) values.hiredAt = now; }
      }
    }
    await updateCase(view, values, session);
    await AuditLog.create([entry(req, requestId, "checked", { action, reviewedRevision: req.body.reviewedRevision, paymentIntentId: intent.id, paymentStatus: intent.status, verified: Boolean(inspection) })], { session });
    if (values.escrowStatus === "funded" && view.raw.escrowStatus !== "funded" && values.status === "in progress") {
      dispatchNotice = await require("../utils/notifyUser").notifyUser(id(view.raw.paralegal || view.raw.paralegalId), "case_work_ready", { caseId: view.raw._id, caseTitle: view.raw.title, link: `case-detail.html?caseId=${view.raw._id}` }, { session, deferDispatch: true, workReady: true });
    }
  });
  if (dispatchNotice) await dispatchNotice().catch(reportOperationalFailure("services.attorneyFunding.funding_notice_dispatch"));
  if (inspection && mayActivateFunding(view.raw, view.operations, view.payouts) && !view.dto.closed) {
    const current = await rawMatter(req, allowAdmin);
    if (current.escrowStatus === "funded" && normalizeCaseStatus(current.status) === "in progress") {
      require("../utils/caseProjectionEvents").publishCaseProjectionRefresh(current, "matter_payment_refresh", { discovery: true });
    }
  }
  return { funding: (await reviewed(req, requestId, allowAdmin)).dto, payment: null };
}
async function prepare(req, view, stripe, requestId, allowAdmin) {
  if (!view.dto.canPrepare) fail(409, "NOT_AVAILABLE");
  if (typeof view.raw.feeParalegalPct !== "number" || !Number.isFinite(view.raw.feeParalegalPct) || view.raw.feeParalegalPct < 0 || view.raw.feeParalegalPct > 100) fail(409, "AMOUNT_INVALID");
  const priorId = view.raw.escrowIntentId || view.raw.paymentIntentId;
  let intent = priorId ? await retrieve(stripe, priorId) : null;
  if (intent) {
    validateIntent(intent, view);
    if (["succeeded", "processing", "requires_capture"].includes(intent.status)) return verifyAndRecord(req, view, intent, stripe, requestId, "prepare", allowAdmin);
    if (intent.status !== "canceled") {
      const payment = paymentForm(intent); await sameReview(req, view, allowAdmin);
      await transaction(async session => { await actor(req, allowAdmin); await updateCase(view, {}, session); await AuditLog.create([entry(req, requestId, "prepared", { action: "prepare", reviewedRevision: req.body.reviewedRevision, paymentIntentId: intent.id })], { session }); });
      const current = await reviewed(req, requestId, allowAdmin); if (!current.dto.canPrepare || preparationSource(current) !== preparationSource(view)) fail(409, "CHANGED"); validateIntent(intent, current); return { funding: current.dto, payment };
    }
    if (intent.amount_received !== 0 || intent.latest_charge || intent.charges?.data?.length) fail(409, "PAYMENT_NEEDS_REVIEW");
  }
  await sameReview(req, view, allowAdmin);
  const key = crypto.randomUUID(), requestFingerprint = buildFundingFingerprint({ caseId: req.params.caseId, amount: view.amounts.totalCents, currency: view.amounts.currency.toLowerCase(), mode: "client-escrow" });
  await transaction(async session => {
    await actor(req, allowAdmin);
    await updateCase(view, { fundingRequestKey: key, fundingRequestFingerprint: requestFingerprint, ...(intent ? { escrowIntentId: "", paymentIntentId: "" } : {}) }, session);
    await AuditLog.create([entry(req, requestId, "started", { action: "prepare", fundingRequestKey: key, reviewedRevision: view.dto.revision, canceledPaymentIntentId: intent?.id || null })], { session });
  });
  // The saved claim survives an unknown provider result and Stripe key expiry.
  // Repeating this request never repeats paymentIntents.create.
  const claimed = await reviewed(req, requestId, allowAdmin);
  if (claimed.raw.fundingRequestKey !== key || claimed.raw.escrowIntentId || claimed.raw.paymentIntentId || preparationSource(claimed) !== preparationSource(view) || claimed.dto.closed || claimed.dto.blockers.length) fail(409, "CHANGED");
  try {
    intent = await stripe.paymentIntents.create({ amount: view.amounts.totalCents, currency: view.amounts.currency.toLowerCase(), automatic_payment_methods: { enabled: true }, transfer_group: `case_${req.params.caseId}`, metadata: { caseId: req.params.caseId, attorneyId: id(view.raw.attorney || view.raw.attorneyId) }, description: `Matter funding: ${view.dto.caseTitle}`.slice(0, 500), ...(view.owner.stripeCustomerId ? { customer: view.owner.stripeCustomerId } : {}) }, { idempotencyKey: key });
  } catch { fail(503, "PREPARATION_UNCONFIRMED"); }
  // Retain a known provider ID even if access or another record changed. This
  // evidence write alone grants no charge, funding or lifecycle permission.
  if (!external(intent?.id, "pi")) fail(503, "PREPARATION_UNCONFIRMED");
  const retained = await Case.collection.updateOne({ _id: view.raw._id, fundingRequestKey: key, $and: [{ $or: [{ escrowIntentId: "" }, { escrowIntentId: null }, { escrowIntentId: { $exists: false } }] }, { $or: [{ paymentIntentId: "" }, { paymentIntentId: null }, { paymentIntentId: { $exists: false } }] }] }, { $set: { escrowIntentId: intent.id, paymentIntentId: intent.id }, $inc: { __v: 1 } }, { writeConcern: { w: "majority" } });
  if (retained.matchedCount !== 1) fail(503, "PREPARATION_UNCONFIRMED");
  validateIntent(intent, view, { unrecorded: true }); const payment = paymentForm(intent);
  const latest = await reviewed(req, requestId, allowAdmin);
  if (!latest.dto.canPrepare || preparationSource(latest) !== preparationSource(view) || latest.raw.fundingRequestKey !== key) fail(409, "CHANGED");
  validateIntent(intent, latest);
  await transaction(async session => { await actor(req, allowAdmin); await updateCase(latest, { stripeMode: intent.livemode ? "live" : "test", feeAttorneyAmount: view.amounts.feeCents, feeAttorneyPct: view.amounts.feePct, feeParalegalAmount: Math.round(view.amounts.baseCents * view.raw.feeParalegalPct / 100), paymentStatus: intent.status }, session); await AuditLog.create([entry(req, requestId, "prepared", { action: "prepare", reviewedRevision: req.body.reviewedRevision, paymentIntentId: intent.id })], { session }); });
  const current = await reviewed(req, requestId, allowAdmin); if (!current.dto.canPrepare) fail(409, "CHANGED"); validateIntent(intent, current); return { funding: current.dto, payment };
}
async function write(req, stripe, allowAdmin = false) {
  const body = req.body || {};
  if (Object.keys(body).some(key => !["expectedOwnerId", "reviewedRevision", "requestId", "action"].includes(key)) || !uuid(body.requestId) || !hash(body.reviewedRevision) || !["prepare", "check"].includes(body.action)) fail(400, "INVALID");
  const view = await reviewed(req, body.requestId, allowAdmin);
  if (view.dto.operation.status !== "not_found") {
    if (view.dto.operation.action !== body.action) fail(409, "REQUEST_CHANGED");
    const saved = await log(req, body.requestId, "prepared") || await log(req, body.requestId, "checked") || await log(req, body.requestId, "started");
    if (saved?.meta.reviewedRevision !== body.reviewedRevision) fail(409, "REQUEST_CHANGED");
    return { funding: view.dto, payment: null };
  }
  if (view.dto.revision !== body.reviewedRevision) fail(409, "CHANGED");
  if (body.action === "prepare") return prepare(req, view, stripe, body.requestId, allowAdmin);
  if (!view.dto.canCheck) fail(409, "NOT_AVAILABLE");
  return verifyAndRecord(req, view, await retrieve(stripe, view.raw.escrowIntentId || view.raw.paymentIntentId), stripe, body.requestId, "check", allowAdmin);
}
async function legacy(req, stripe, action, confirmOnly = false) {
  const internal = { ...req, method: "POST", params: { ...req.params, caseId: req.params.caseId || req.body?.caseId }, body: { expectedOwnerId: id(req.user?.id), action, requestId: crypto.randomUUID() } };
  const view = await reviewed(internal, null, true); internal.body.reviewedRevision = view.dto.revision;
  if (action === "prepare" && view.dto.fundingVerified) internal.body.action = "check";
  const result = await write(internal, stripe, true), raw = await rawMatter(internal, true);
  if (confirmOnly && !result.funding.fundingVerified) fail(402, "NOT_COMPLETED");
  return { ...result.payment, ok: action === "check" && !confirmOnly || result.funding.fundingVerified, paymentStatus: raw.paymentStatus, paymentIntentStatus: raw.paymentStatus, integrityFailure: null, alreadyFunded: result.funding.fundingVerified, fundingVerified: result.funding.fundingVerified, status: raw.status, escrowStatus: raw.escrowStatus, paymentIntentId: raw.escrowIntentId || raw.paymentIntentId || null, funding: result.funding };
}
async function budget(req) {
  const internal = { ...req, method: "POST", body: { expectedOwnerId: id(req.user?.id) } }, input = req.body?.amountUsd;
  if (!["number", "string"].includes(typeof input) || !/^\d+(?:\.\d{1,2})?$/.test(String(input))) fail(400, "AMOUNT_INVALID");
  const [whole, fraction = ""] = String(input).split("."), amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (money(amount) && amount < MIN_MATTER_AMOUNT_CENTS) fail(400, "AMOUNT_TOO_SMALL");
  const view = await reviewed(internal, null, true); if (!view.dto.canEditAmount) fail(409, "AMOUNT_LOCKED");
  const next = amountsFor({ ...view.raw, totalAmount: amount, feeAttorneyAmount: null }); if (!next.canCharge || req.body.currency && String(req.body.currency).toUpperCase() !== next.currency) fail(400, "AMOUNT_INVALID");
  const jobs = await Job.collection.find({ $or: [{ caseId: { $in: [view.raw._id, req.params.caseId] } }, { _id: { $in: [view.raw.job, view.raw.jobId].filter(Boolean).map(value => validId(id(value)) ? new mongoose.Types.ObjectId(id(value)) : value) } }] }).limit(3).toArray();
  if (jobs.length > 1 || (view.raw.job || view.raw.jobId) && !jobs.length || jobs.some(job => id(job.attorneyId) !== id(view.raw.attorney || view.raw.attorneyId) || job.caseId && id(job.caseId) !== req.params.caseId || job.status !== "open")) fail(409, "POSTING_CHANGED");
  await transaction(async session => {
    await actor(internal, true); await updateCase(view, { totalAmount: amount, feeAttorneyAmount: next.feeCents, feeAttorneyPct: next.feePct }, session);
    if (jobs.length) { const job = jobs[0], result = await Job.collection.updateOne({ _id: job._id, ...Object.fromEntries(Object.entries(job).filter(([key]) => key !== "_id").map(([key, value]) => [key, { $eq: value }])) }, { $set: { budget: amount / 100, updatedAt: new Date() } }, { session }); if (result.matchedCount !== 1) fail(409, "POSTING_CHANGED"); }
    await AuditLog.create([entry(internal, crypto.randomUUID(), "budget", { action: "budget", fromCents: view.raw.totalAmount, toCents: amount, currency: next.currency })], { session });
  });
  await actor(internal, true); return { ok: true, totalAmount: amount, currency: next.currency.toLowerCase() };
}
module.exports = { reviewedSnapshot: reviewed, read, write, legacy, budget, amountsFor, validateIntent, expandCapturedIntent, paymentProjection, mayActivateFunding, approvedFundingParticipant, lockFundingActivation };
