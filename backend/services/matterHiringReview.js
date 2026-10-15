const { Types } = require("mongoose");
const Case = require("../models/Case"), User = require("../models/User");
const applications = require("./matterApplications"), account = require("./attorneyAccountBoundary");
const { fingerprint } = require("./matterDraftRevision");
const { isBlockedBetween } = require("../utils/blocks");
const { normalizeCaseStatus } = require("../utils/caseState");
const { DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT } = require("./platformFeePolicy");
const { MIN_MATTER_AMOUNT_CENTS } = require("./attorneyWorkflowPolicy");
const { validatePaymentIntentForCase } = require("../utils/paymentIntegrity");
const { id } = require("./applicationIdentity");
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const fields = "attorney attorneyId title status archived readOnly job jobId paralegal paralegalId hiredAt tasks applicants invites preEngagement totalAmount lockedTotalAmount amountLockedAt feeAttorneyPct feeParalegalPct feeAttorneyAmount feeParalegalAmount stripeMode currency escrowIntentId paymentIntentId paymentStatus escrowStatus paymentReleased fundingIntegrityStatus fundingRequestKey fundingRequestFingerprint hiringClaimToken hiringClaimStatus hiringClaimParalegalId hiringClaimPaymentIntentId hiringClaimAmount relistPending pausedReason payoutFinalizedAt remainingAmount partialPayoutAmount disputeDeadlineAt disputes __v".split(" ");
const projection = Object.fromEntries(fields.map(key => [key, 1]));
const fail = (status, suffix) => { throw Object.assign(new Error("The hiring and funding details could not be verified."), { status, publicCode: `HIRING_${suffix}` }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
function cardSummary(pm) {
  if (!pm || pm.type !== "card" || typeof pm.id !== "string" || !/^pm_[A-Za-z0-9_]{1,200}$/.test(pm.id) || !/^\d{4}$/.test(pm.card?.last4 || "")) fail(502, "CARD_UNAVAILABLE");
  return { id: pm.id, type: "card", brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year };
}
async function savedCard(stripeClient, customerId) {
  if (!customerId) return null;
  const customer = await stripeClient.customers.retrieve(customerId);
  if (customer?.deleted) fail(409, "CARD_UNAVAILABLE");
  const ref = customer?.invoice_settings?.default_payment_method, pmId = ref?.id || ref;
  if (!pmId) return null;
  const pm = await stripeClient.paymentMethods.retrieve(pmId);
  if (String(pm?.customer?.id || pm?.customer || "") !== customerId || pm?.id !== pmId) fail(409, "CARD_UNAVAILABLE");
  return cardSummary(pm);
}
function approvedPreEngagement(record, caseId, applicantId) {
  if (!record) return true;
  if (record.status !== "approved" || id(record.requestedParalegalId) !== applicantId || (!record.confidentialityAgreementRequired && !record.conflictsCheckRequired)) return false;
  if (record.confidentialityAgreementRequired && (record.confidentialityAcknowledged !== true || !record.confidentialityDocument?.key)) return false;
  if (record.conflictsCheckRequired && (typeof record.conflictsDetails !== "string" || !record.conflictsDetails.trim() || !["none_known", "disclosure"].includes(record.conflictsResponseType) || record.conflictsResponseType === "disclosure" && !(typeof record.conflictsDisclosureText === "string" && record.conflictsDisclosureText.trim()))) return false;
  return [record.confidentialityDocument, record.paralegalConfidentialityDocument].filter(Boolean).every(doc => typeof doc.key === "string" && doc.key.startsWith(`cases/${caseId}/pre-engagement/`) && !/[\\\x00-\x1f\x7f]/.test(doc.key) && !doc.key.split("/").some(part => [".", ".."].includes(part)));
}
async function snapshot(req, { stripeClient, bypassEmails = new Set() }) {
  const ownerId = req.query.expectedOwnerId, caseId = req.params.caseId, applicantId = req.params.applicantId;
  if (!validId(caseId) || !validId(applicantId)) fail(400, "INVALID");
  let user;
  try { user = await account.read(req, ownerId, ["stripeCustomerId"]); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; }
  const selected = await applications.selectedRecords(req);
  const facts = await Case.collection.findOne({ _id: selected.doc._id }, { projection });
  if (!facts || id(facts.attorney || facts.attorneyId) !== ownerId || facts.attorney && facts.attorneyId && id(facts.attorney) !== id(facts.attorneyId)) fail(409, "CHANGED");
  if (fingerprint([facts.applicants, facts.preEngagement, facts.paralegal, facts.paralegalId]) !== fingerprint([selected.doc.applicants, selected.doc.preEngagement, selected.doc.paralegal, selected.doc.paralegalId])) fail(409, "CHANGED");
  const profile = await User.collection.findOne({ _id: new Types.ObjectId(applicantId) }, { projection: { firstName: 1, lastName: 1, email: 1, role: 1, status: 1, disabled: 1, deleted: 1, stripeAccountId: 1, stripeOnboarded: 1, stripePayoutsEnabled: 1 } });
  const blocked = await isBlockedBetween(ownerId, applicantId), available = !!profile && profile.role === "paralegal" && profile.status === "approved" && !profile.disabled && !profile.deleted;
  const assignedId = id(facts.paralegal || facts.paralegalId), status = normalizeCaseStatus(facts.status);
  const relisted = status === "paused" && facts.pausedReason === "paralegal_withdrew" && !!facts.payoutFinalizedAt;
  const budgetCents = positive(facts.lockedTotalAmount) ? facts.lockedTotalAmount : (relisted || assignedId) && positive(facts.totalAmount) ? facts.totalAmount : null;
  const feePct = typeof facts.feeAttorneyPct === "number" && Number.isFinite(facts.feeAttorneyPct) ? facts.feeAttorneyPct : DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
  const feeCents = budgetCents !== null && feePct >= 0 ? Math.round(budgetCents * feePct / 100) : null;
  const chargeCents = relisted ? 0 : budgetCents !== null && Number.isSafeInteger(feeCents) && Number.isSafeInteger(budgetCents + feeCents) ? budgetCents + feeCents : null;
  const remainingCents = Number.isSafeInteger(facts.remainingAmount) && facts.remainingAmount >= 0 ? facts.remainingAmount : budgetCents !== null && Number.isSafeInteger(facts.partialPayoutAmount || 0) ? Math.max(0, budgetCents - (facts.partialPayoutAmount || 0)) : null;
  const candidateEligible = !blocked && available && !!selected.mirror && ["pending", "submitted", "viewed", "shortlisted", "accepted"].includes(selected.record.status) && (!selected.applicationId || applications.mirrorStatusMatches(selected.record.status, selected.mirror.status) && !["pending", "needs_reconciliation"].includes(selected.record.syncStatus)) && Array.isArray(facts.tasks) && facts.tasks.length > 0 && approvedPreEngagement(facts.preEngagement, caseId, applicantId) && (bypassEmails.has(String(profile.email || "").trim().toLowerCase()) || !!(profile.stripeAccountId && profile.stripeOnboarded && profile.stripePayoutsEnabled));
  let reason = "ready", card = null, fundingVerified = false, resumableIntent = false;
  if (facts.hiringClaimStatus === "needs_reconciliation") reason = "reconciliation";
  else if (facts.hiringClaimToken || facts.hiringClaimStatus) reason = "processing";
  else if (assignedId) reason = assignedId === applicantId ? "assigned" : "other_assigned";
  else if (facts.archived || facts.readOnly || facts.paymentReleased || status !== "open" && !relisted || (facts.disputes || []).some(entry => entry.status === "open")) reason = "matter_unavailable";
  else if (blocked) reason = "blocked";
  else if (!available) reason = "profile_unavailable";
  else if (!selected.mirror || !["pending", "submitted", "viewed", "shortlisted", "accepted"].includes(selected.record.status) || selected.applicationId && (!applications.mirrorStatusMatches(selected.record.status, selected.mirror.status) || ["pending", "needs_reconciliation"].includes(selected.record.syncStatus))) reason = "application_unavailable";
  else if (!Array.isArray(facts.tasks) || !facts.tasks.length) reason = "scope_required";
  else if (!budgetCents || !relisted && budgetCents < MIN_MATTER_AMOUNT_CENTS || chargeCents === null || feeCents === null || relisted && !positive(remainingCents)) reason = "amount_unavailable";
  else if (!approvedPreEngagement(facts.preEngagement, caseId, applicantId)) reason = "pre_engagement_required";
  else if (!bypassEmails.has(String(profile.email || "").trim().toLowerCase()) && !(profile.stripeAccountId && profile.stripeOnboarded && profile.stripePayoutsEnabled)) reason = "payout_setup_required";
  if (["ready", "assigned", "reconciliation"].includes(reason) && (relisted || assignedId === applicantId || facts.hiringClaimPaymentIntentId)) {
    const intentId = facts.escrowIntentId || facts.hiringClaimPaymentIntentId || facts.paymentIntentId;
    if (intentId) {
      const intent = await stripeClient.paymentIntents.retrieve(intentId), integrity = validatePaymentIntentForCase(intent, facts), transferable = stripeClient.isTransferablePaymentIntent(intent, { caseId: facts._id });
      fundingVerified = !!integrity.valid && !!transferable?.transferable && String(intent.customer?.id || intent.customer || "") === String(user.stripeCustomerId || "") && intent.metadata?.attorneyId === ownerId;
      resumableIntent = fundingVerified && intent.metadata?.paralegalId === applicantId && id(facts.hiringClaimParalegalId) === applicantId && intent.id === facts.hiringClaimPaymentIntentId;
      if (relisted && (!fundingVerified || String(facts.escrowStatus || "").toLowerCase() !== "funded")) reason = "reconciliation";
    } else if (relisted) reason = "reconciliation";
  }
  const canResume = reason === "reconciliation" && !relisted && !assignedId && !facts.archived && !facts.readOnly && !facts.paymentReleased && status === "open" && !(facts.disputes || []).some(entry => entry.status === "open") && facts.hiringClaimStatus === "needs_reconciliation" && resumableIntent && candidateEligible && positive(chargeCents) && budgetCents >= MIN_MATTER_AMOUNT_CENTS;
  if (reason === "ready" && !relisted) {
    // Earlier funding without an assignment cannot be interpreted as a failed
    // charge. It must be resolved before offering a new hire confirmation.
    if (facts.escrowIntentId || facts.paymentIntentId || facts.fundingRequestKey) reason = "reconciliation";
    else { card = await savedCard(stripeClient, String(user.stripeCustomerId || "")); if (!card) reason = "card_required"; }
  }
  let withdrawalRevision = null;
  if (relisted && reason === "ready") {
    try { withdrawalRevision = await require("./replacementWithdrawal").review(facts._id); }
    catch (error) { if (error.status === 409 && error.publicCode) reason = "withdrawal_review_required"; else throw error; }
  }
  const revision = fingerprint([user, selected.revision, facts, profile, blocked, card, fundingVerified, resumableIntent, withdrawalRevision]);
  const dto = { ownerId, caseId, applicantId, caseTitle: typeof facts.title === "string" ? facts.title : "Untitled Matter", name: available && !blocked ? [profile.firstName, profile.lastName].filter(value => typeof value === "string").join(" ") || "Paralegal applicant" : "Paralegal applicant", revision, reason, canHire: reason === "ready", canResume, relisted, budgetCents, feeCents: relisted ? 0 : feeCents, chargeCents, remainingCents: relisted ? remainingCents : null, currency: facts.currency || "usd", card, fundingVerified, assigned: assignedId === applicantId };
  return { dto, facts, selected, user, profile, blocked, withdrawalRevision, filter: { _id: facts._id, ...Object.fromEntries(fields.map(key => [key, facts[key] === undefined ? { $exists: false } : { $eq: facts[key] }])) } };
}
async function readSnapshot(req, options) {
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  const first = await snapshot(req, options), latest = await snapshot(req, options);
  if (first.dto.revision !== latest.dto.revision) fail(409, "CHANGED");
  await verifyParties(req, latest);
  const finalCase = await Case.collection.findOne({ _id: latest.facts._id }, { projection });
  if (fingerprint(finalCase) !== fingerprint(latest.facts) || (await applications.selectedRecords(req)).revision !== latest.selected.revision) fail(409, "CHANGED");
  return latest;
}
async function verifyParties(req, value) {
  let user;
  try { user = await account.read(req, value.dto.ownerId, ["stripeCustomerId"]); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; }
  const profile = await User.collection.findOne({ _id: new Types.ObjectId(value.dto.applicantId) }, { projection: { firstName: 1, lastName: 1, email: 1, role: 1, status: 1, disabled: 1, deleted: 1, stripeAccountId: 1, stripeOnboarded: 1, stripePayoutsEnabled: 1 } });
  if (fingerprint(user) !== fingerprint(value.user) || fingerprint(profile) !== fingerprint(value.profile) || await isBlockedBetween(value.dto.ownerId, value.dto.applicantId) !== value.blocked) fail(409, "CHANGED");
}
async function read(req, options) { return (await readSnapshot(req, options)).dto; }
async function reviewed(req, options) {
  if (typeof req.body?.reviewedRevision !== "string" || !/^[a-f0-9]{64}$/.test(req.body.reviewedRevision)) fail(400, "INVALID");
  const bound = { ...req, params: { ...req.params, applicantId: req.params.paralegalId }, query: { expectedOwnerId: req.body.expectedOwnerId } };
  const value = await readSnapshot(bound, options);
  if (value.dto.revision !== req.body.reviewedRevision) fail(409, "CHANGED");
  if (!value.dto.canHire && !value.dto.canResume) fail(409, "UNAVAILABLE");
  return value;
}
module.exports = { read, reviewed, readSnapshot, verifyParties, savedCard, approvedPreEngagement };
