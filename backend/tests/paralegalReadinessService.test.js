const {
  buildApplicationEligibility,
  projectPayoutReadiness,
  resolveLivePayoutReadiness,
} = require("../services/paralegalReadinessService");
const fs = require("fs");
const path = require("path");

const readyUser = {
  role: "paralegal",
  status: "approved",
  profileImage: "https://example.test/profile.jpg",
  stripeAccountId: "acct_ready",
  stripeOnboarded: true,
  stripeChargesEnabled: true,
  stripePayoutsEnabled: true,
  availabilityDetails: { available: false },
};

describe("paralegal readiness projection", () => {
  test("requires verified account, details, and payout evidence", () => {
    expect(projectPayoutReadiness({
      accountId: "acct_ready",
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    })).toMatchObject({
      ready: true,
      accountPresent: true,
      detailsSubmitted: true,
      payoutsEnabled: true,
      blockers: [],
      requiredAction: null,
    });

    expect(projectPayoutReadiness({})).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining([
        "missing_stripe_account",
        "stripe_details_missing",
        "stripe_payouts_disabled",
      ]),
      requiredAction: "complete_payout_setup",
    });
  });

  test("preserves the verified payout rule when charges are disabled", () => {
    expect(projectPayoutReadiness({
      accountId: "acct_ready",
      detailsSubmitted: true,
      chargesEnabled: false,
      payoutsEnabled: true,
    })).toMatchObject({
      ready: true,
      chargesEnabled: false,
      blockers: ["stripe_charges_disabled"],
    });
  });

  test("never treats stale stored flags as ready after a failed live lookup", async () => {
    const result = await resolveLivePayoutReadiness({
      stripeAccountId: "acct_ready",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    }, {
      stripeClient: { accounts: { retrieve: jest.fn().mockRejectedValue(new Error("unavailable")) } },
    });
    expect(result).toMatchObject({
      ready: false,
      evidenceState: "temporarily_unavailable",
      source: "live_lookup_failed",
      blockers: expect.arrayContaining(["stripe_status_unverified"]),
    });
  });

  test("uses live Stripe evidence when it is available", async () => {
    const retrieve = jest.fn().mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });
    await expect(resolveLivePayoutReadiness(
      { stripeAccountId: "acct_ready" },
      { stripeClient: { accounts: { retrieve } } }
    )).resolves.toMatchObject({ ready: true, source: "live", evidenceState: "verified" });
    expect(retrieve).toHaveBeenCalledWith("acct_ready");
  });

  test("returns every authoritative application blocker", () => {
    const result = buildApplicationEligibility({
      user: { role: "attorney", status: "pending" },
      caseDoc: { status: "completed", archived: true, paralegalId: "para-2" },
      partiesBlocked: true,
      duplicateApplication: true,
    });
    expect(result).toMatchObject({ ready: false, allowed: false });
    expect(result.blockers).toEqual(expect.arrayContaining([
      "approved_paralegal_required",
      "parties_blocked",
      "applications_closed",
      "paralegal_already_assigned",
      "duplicate_application",
      "profile_photo_required",
      "paralegal_payout_setup_required",
    ]));
  });

  test("allows the eligible state and records that availability is not an application blocker", () => {
    expect(buildApplicationEligibility({
      user: readyUser,
      caseDoc: { status: "open" },
      job: { status: "open" },
    })).toMatchObject({
      ready: true,
      allowed: true,
      blockers: [],
      facts: {
        availabilityIsApplicationBlocker: false,
        payoutReadiness: { ready: true },
      },
    });
  });

  test("keeps the development bypass explicit in the projection", () => {
    expect(projectPayoutReadiness({ devBypass: true, source: "development_bypass" })).toMatchObject({
      ready: true,
      devBypass: true,
      source: "development_bypass",
    });
  });

  test("frontend application controls consume the server projection without Stripe storage fallback", () => {
    const browse = fs.readFileSync(path.join(__dirname, "../../frontend/assets/scripts/views/browse-jobs.js"), "utf8");
    const stripeConnect = fs.readFileSync(path.join(__dirname, "../../frontend/assets/scripts/utils/stripe-connect.js"), "utf8");
    const settings = fs.readFileSync(path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"), "utf8");
    expect(browse).toContain("job?.applicationEligibility");
    expect(browse).not.toContain("stripeConnected");
    expect(browse).not.toContain("profilePhotoAllowed");
    expect(stripeConnect).toContain("status?.readiness?.ready === true");
    expect(stripeConnect).not.toContain("sessionStorage");
    expect(settings).toContain("readiness?.ready === true");
  });
});
