"use strict";
const funding = require("./attorneyFunding"), checkoutEvidence = require("./attorneyCheckoutEvents"), { fingerprint } = require("./matterDraftRevision"), { normalizeCaseStatus } = require("../utils/caseState"), { currentStripeMode } = require("../utils/stripeMode");
const id = value => String(value?._id || value || "");
const fail = (status, suffix) => { throw Object.assign(new Error("Original Checkout could not be verified."), { status, publicCode: `WORKSPACE_FUNDING_${suffix}` }); };
const retained = view => [view.cases, view.owner, view.operations, view.payouts];
function hostedUrl(checkout) {
  if (checkout?.ui_mode !== "hosted_page" || typeof checkout.url !== "string") return null;
  try {
    const url = new URL(checkout.url);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password || url.port || ![`/c/pay/${checkout.id}`, `/pay/${checkout.id}`].includes(url.pathname)) return null;
    return checkout.url;
  } catch { return null; }
}
function eligible(view, evidence) {
  const raw = evidence.view.raw, personId = id(raw.paralegal || raw.paralegalId), person = view.person;
  // The original Session can predate assignment. Any current assignment must
  // still be eligible. Never reopen a payment after a decision or money event.
  return !view.dto.closed && normalizeCaseStatus(raw.status) === "open" && view.amounts.canCharge && !view.dto.fundingVerified &&
    !view.dto.blockers.some(key => key !== "payment_reference_needs_review") &&
    (!personId || person?.role === "paralegal" && person.status === "approved" && !person.disabled && !person.deleted) &&
    ![raw.pausedAt, raw.pausedReason, raw.disputeDeadlineAt, raw.fundingRequestKey, raw.fundingRequestFingerprint, raw.fundingVerifiedAt, raw.payoutTransferId, raw.paidOutAt, raw.payoutFinalizedAt, raw.payoutFinalizedType, raw.withdrawnParalegalId, raw.partialPayoutAmount].some(Boolean) &&
    !Object.values(raw.disputeSettlement || {}).some(value => value !== null && value !== undefined && value !== "" && value !== 0) &&
    !(raw.withdrawalHistory || []).length && !(raw.disputes || []).length && !evidence.view.operations.length && !evidence.view.payouts.length &&
    [undefined, null, "", "pending", "awaiting_funding"].includes(raw.escrowStatus) &&
    [undefined, null, "", "unpaid", "pending", "requires_payment_method", "requires_confirmation", "requires_action"].includes(raw.paymentStatus) &&
    [undefined, null, "", "not_started"].includes(raw.payoutStatus);
}
async function review(req, stripe) {
  const before = await funding.reviewedSnapshot(req), sessionId = before.raw.escrowSessionId;
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) fail(409, "CHECKOUT_NOT_FOUND");
  const initial = await checkoutEvidence.inventory(sessionId, null), mode = currentStripeMode() === "unknown" ? before.raw.stripeMode : currentStripeMode();
  let evidence;
  if (!["live", "test"].includes(mode)) evidence = { view: initial, problem: "checkout_mode_unknown" };
  else {
    try { evidence = await checkoutEvidence.observe(sessionId, { livemode: mode === "live" }, stripe, { allowNoIntent: true, requestOptions: { timeout: 20000, maxNetworkRetries: 0 } }); }
    catch { fail(502, "CHECKOUT_UNAVAILABLE"); }
  }
  const latest = await funding.reviewedSnapshot(req), inventory = await checkoutEvidence.inventory(sessionId, evidence.intentId);
  if (latest.dto.revision !== before.dto.revision || fingerprint(retained(initial)) !== fingerprint(retained(evidence.view)) || fingerprint(inventory) !== fingerprint(evidence.view)) fail(409, "CHANGED");
  const checkout = evidence.checkout, intent = evidence.intent, expiry = Number.isSafeInteger(checkout?.expires_at) && checkout.expires_at > 0 && Number.isFinite(new Date(checkout.expires_at * 1000).getTime()) ? checkout.expires_at * 1000 : null;
  const url = hostedUrl(checkout), active = expiry !== null && expiry > Date.now();
  let state = "needs_review";
  if (!evidence.problem) {
    if (latest.dto.fundingVerified) state = "verified";
    else if (checkout.payment_status === "paid" && intent?.status === "succeeded") state = "paid";
    else if (["processing", "requires_capture"].includes(intent?.status) || checkout.status === "complete" && checkout.payment_status === "unpaid") state = "processing";
    else if (checkout.status === "expired") state = "expired";
    else if (checkout.status === "open" && checkout.payment_status === "unpaid" && active && url && eligible(latest, evidence) && (!intent || ["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status) && intent.amount_received === 0 && !intent.latest_charge)) state = "available";
  }
  const dto = { ownerId: latest.dto.ownerId, caseId: latest.dto.caseId, fundingRevision: latest.dto.revision, sessionId, state, canResume: state === "available", fundingVerified: latest.dto.fundingVerified, totalCents: latest.dto.totalCents, currency: latest.dto.currency, expiresAt: !evidence.problem && expiry ? new Date(expiry).toISOString() : null };
  dto.revision = fingerprint([dto, evidence.view, evidence.problem, checkout, intent]);
  // Final account check also covers revocation during the inventory reads.
  const final = await funding.reviewedSnapshot(req); if (final.dto.revision !== latest.dto.revision) fail(409, "CHANGED");
  return { dto, url };
}
async function read(req, stripe) {
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  return (await review(req, stripe)).dto;
}
async function resume(req, stripe) {
  if (Object.keys(req.body || {}).some(key => !["expectedOwnerId", "reviewedRevision"].includes(key)) || !/^[a-f0-9]{64}$/.test(req.body?.reviewedRevision || "")) fail(400, "INVALID");
  const current = await review(req, stripe);
  if (!current.dto.canResume || current.dto.revision !== req.body.reviewedRevision || !current.url || Date.parse(current.dto.expiresAt) <= Date.now()) fail(409, "CHECKOUT_CHANGED");
  return { checkout: current.dto, url: current.url };
}
module.exports = { read, resume };
