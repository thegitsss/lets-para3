const { evaluateApplicationEligibility } = require("./attorneyWorkflowPolicy");
const { hasStripeConnectBypass } = require("../utils/stripeConnectBypass");

function projectPayoutReadiness(input = {}) {
  const accountId = String(input.accountId || input.stripeAccountId || "").trim();
  const detailsSubmitted = input.detailsSubmitted === true || input.details_submitted === true;
  const chargesEnabled = input.chargesEnabled === true || input.charges_enabled === true;
  const payoutsEnabled = input.payoutsEnabled === true || input.payouts_enabled === true;
  const devBypass = input.devBypass === true;
  const evidenceState = String(input.evidenceState || "verified");
  const source = String(input.source || "stored");
  const blockers = [];
  if (!devBypass && !accountId) blockers.push("missing_stripe_account");
  if (!devBypass && !detailsSubmitted) blockers.push("stripe_details_missing");
  if (!devBypass && accountId && !chargesEnabled) blockers.push("stripe_charges_disabled");
  if (!devBypass && !payoutsEnabled) blockers.push("stripe_payouts_disabled");
  if (evidenceState !== "verified") blockers.push("stripe_status_unverified");
  const ready = (devBypass || Boolean(accountId && detailsSubmitted && payoutsEnabled)) && evidenceState === "verified";
  return {
    ready,
    accountPresent: Boolean(accountId) || devBypass,
    detailsSubmitted: devBypass || detailsSubmitted,
    chargesEnabled: devBypass || chargesEnabled,
    payoutsEnabled: devBypass || payoutsEnabled,
    restricted: !ready,
    blockers: [...new Set(blockers)],
    requiredAction: ready ? null : "complete_payout_setup",
    evidenceState,
    source,
    devBypass,
  };
}

function buildApplicationEligibility(input = {}) {
  const user = input.user || {};
  const matter = input.caseDoc || input.job || input.listing || {};
  const payoutReadiness = input.payoutReadiness || projectPayoutReadiness({
    accountId: user.stripeAccountId,
    detailsSubmitted: user.stripeOnboarded,
    chargesEnabled: user.stripeChargesEnabled,
    payoutsEnabled: user.stripePayoutsEnabled,
    devBypass: input.devBypass,
  });
  const result = evaluateApplicationEligibility({
    applicantApproved:
      String(user.role || "").toLowerCase() === "paralegal" &&
      String(user.status || "").toLowerCase() === "approved",
    partiesBlocked: input.partiesBlocked === true || input.blockedRelationship === true,
    caseStatus: input.caseStatus || input.caseDoc?.status || matter.status,
    jobStatus: input.jobStatus || input.job?.status || matter.status,
    archived: input.archived === true || input.caseDoc?.archived === true || matter.archived === true,
    paralegalAssigned:
      input.paralegalAssigned === true ||
      Boolean(input.caseDoc?.paralegal || input.caseDoc?.paralegalId || matter.paralegal || matter.paralegalId),
    relistRequestedAt: input.relistRequestedAt || input.caseDoc?.relistRequestedAt || matter.relistRequestedAt,
    payoutFinalizedAt: input.payoutFinalizedAt || input.caseDoc?.payoutFinalizedAt || matter.payoutFinalizedAt,
    duplicateApplication: input.duplicateApplication === true || input.alreadyApplied === true,
    profilePhotoReady:
      input.profilePhotoReady !== undefined
        ? input.profilePhotoReady === true
        : Boolean(user.profileImage || user.avatarURL),
    payoutSetupReady: payoutReadiness.ready === true,
  });
  return {
    ...result,
    allowed: result.ready,
    facts: {
      ...(result.facts || {}),
      payoutReadiness,
      availabilityIsApplicationBlocker: false,
    },
  };
}

async function resolveLivePayoutReadiness(user = {}, { stripeClient = null } = {}) {
  if (hasStripeConnectBypass(user.email)) {
    return projectPayoutReadiness({ devBypass: true, source: "development_bypass" });
  }
  const accountId = String(user.stripeAccountId || "").trim();
  if (!accountId) return projectPayoutReadiness({ source: "stored", evidenceState: "verified" });
  try {
    const client = stripeClient || require("../utils/stripe");
    const account = await client.accounts.retrieve(accountId);
    return projectPayoutReadiness({
      accountId,
      detailsSubmitted: account?.details_submitted === true,
      chargesEnabled: account?.charges_enabled === true,
      payoutsEnabled: account?.payouts_enabled === true,
      source: "live",
      evidenceState: "verified",
    });
  } catch (_error) {
    return projectPayoutReadiness({
      accountId,
      source: "live_lookup_failed",
      evidenceState: "temporarily_unavailable",
    });
  }
}

module.exports = { buildApplicationEligibility, projectPayoutReadiness, resolveLivePayoutReadiness };
