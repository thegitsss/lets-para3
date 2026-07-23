const fs = require("fs");
const path = require("path");

const {
  ATTORNEY_WORKFLOW_STAGES,
  CASE_ARCHIVE_RETENTION_MONTHS,
  EVIDENCE_STATES,
  MIN_MATTER_AMOUNT_CENTS,
  calculateArchivePurgeAt,
  evaluateApplicationEligibility,
  evaluateArchiveReadiness,
  evaluateCompletionEligibility,
  evaluateHiringEligibility,
  evaluateInvitationEligibility,
  evaluateMatterPosting,
  evaluateMessagingPermission,
  evaluatePreEngagementRequest,
  evaluateTerminationEligibility,
  evaluateWithdrawalAndRelist,
  evaluateWorkspaceAccess,
  getAttorneyWorkflowPolicy,
} = require("../services/attorneyWorkflowPolicy");
const {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
  getCurrentPlatformFeePolicy,
} = require("../services/platformFeePolicy");

function activeCase(overrides = {}) {
  return {
    status: "in progress",
    attorneyId: "attorney-1",
    paralegalId: "paralegal-1",
    escrowIntentId: "pi_123",
    escrowStatus: "funded",
    totalAmount: MIN_MATTER_AMOUNT_CENTS,
    lockedTotalAmount: MIN_MATTER_AMOUNT_CENTS,
    tasks: [{ title: "Draft", completed: true }],
    ...overrides,
  };
}

describe("attorney executable workflow policy", () => {
  test("publishing uses one minimum and reports every blocker", () => {
    const blocked = evaluateMatterPosting({
      paymentMethodSaved: false,
      title: "",
      details: "",
      practiceArea: "",
      amountCents: MIN_MATTER_AMOUNT_CENTS - 1,
      deadlineProvided: true,
      deadlineValid: false,
      attorneyStateRequired: true,
      attorneyState: "",
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      "saved_payment_method_required",
      "title_required",
      "description_required",
      "practice_area_required",
      "minimum_matter_amount_required",
      "valid_deadline_required",
      "attorney_state_required",
    ]));
    expect(getAttorneyWorkflowPolicy().post_matter.minimumMatterAmountCents).toBe(40_000);
  });

  test("application policy covers payment, lifecycle, duplication, profile, payout, and blocking", () => {
    const result = evaluateApplicationEligibility({
      attorneyPaymentMethodSaved: false,
      applicantApproved: false,
      partiesBlocked: true,
      caseStatus: "completed",
      paralegalAssigned: true,
      duplicateApplication: true,
      profilePhotoReady: false,
      payoutSetupReady: false,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "attorney_payment_method_required",
      "approved_paralegal_required",
      "parties_blocked",
      "applications_closed",
      "paralegal_already_assigned",
      "duplicate_application",
      "profile_photo_required",
      "paralegal_payout_setup_required",
    ]));
  });

  test("invitation and pre-engagement policies expose target and document requirements", () => {
    expect(evaluateInvitationEligibility({ caseDoc: { status: "open" }, ownerAuthorized: true }).blockers)
      .toContain("paralegal_selection_required");
    const pre = evaluatePreEngagementRequest({
      caseDoc: { status: "open", tasks: [{ title: "Review" }] },
      ownerAuthorized: true,
      targetSelected: true,
      confidentialityRequired: true,
      conflictsCheckRequired: true,
      conflictsDetails: "",
      confidentialityDocumentReady: false,
    });
    expect(pre.blockers).toEqual(expect.arrayContaining([
      "conflicts_details_required",
      "confidentiality_document_required",
    ]));
  });

  test("hiring policy requires successful prerequisites and states actual charge timing", () => {
    const ready = evaluateHiringEligibility({
      caseDoc: activeCase({ status: "open", paralegalId: null, escrowIntentId: null, escrowStatus: null }),
      ownerAuthorized: true,
      targetSelected: true,
      paralegalApproved: true,
      paralegalPayoutSetupReady: true,
      paymentMethodSaved: true,
      partiesBlocked: false,
    });
    expect(ready.ready).toBe(true);
    expect(ready.facts).toEqual(expect.objectContaining({
      chargeTiming: "charged_when_hire_is_confirmed",
      requiredProcessorState: "succeeded",
    }));
    expect(getAttorneyWorkflowPolicy().hire_and_fund).toEqual(expect.objectContaining({
      resultingMatterStatus: "in_progress",
      resultingFundingStatus: "funded",
      locksScopeTasks: true,
      nextStage: "workspace",
    }));
    expect(getAttorneyWorkflowPolicy().workspace).toEqual(expect.objectContaining({
      participants: ["attorney", "hired_paralegal"],
      supports: ["scope_tasks", "files", "messages"],
      nextStage: "complete_and_release",
    }));
  });

  test("workspace and messaging share funded active-state rules", () => {
    const workspace = evaluateWorkspaceAccess({ caseDoc: activeCase(), viewerId: "attorney-1", viewerRole: "attorney" });
    const messaging = evaluateMessagingPermission({ caseDoc: activeCase(), viewerId: "attorney-1", viewerRole: "attorney" });
    expect(workspace.ready).toBe(true);
    expect(messaging.ready).toBe(true);
    expect(evaluateMessagingPermission({
      caseDoc: activeCase({ readOnly: true, status: "completed" }),
      viewerId: "attorney-1",
      viewerRole: "attorney",
    }).blockers).toEqual(expect.arrayContaining(["case_read_only", "messaging_closed"]));
  });

  test("completion distinguishes incomplete, unfunded, and already completed", () => {
    const blocked = evaluateCompletionEligibility({
      caseDoc: activeCase({ tasks: [{ title: "Draft", completed: false }], escrowIntentId: null }),
      ownerAuthorized: true,
    });
    expect(blocked.blockers).toEqual(expect.arrayContaining(["incomplete_scope_tasks", "verified_funding_required"]));
    const completed = evaluateCompletionEligibility({
      caseDoc: activeCase({ status: "completed" }),
      ownerAuthorized: true,
    });
    expect(completed.evidenceState).toBe(EVIDENCE_STATES.NOT_APPLICABLE);
  });

  test("completion policy exposes the authoritative paralegal payout and bank timing", () => {
    expect(getAttorneyWorkflowPolicy().complete_and_release).toEqual(expect.objectContaining({
      allScopeTasksComplete: true,
      verifiedFundingRequired: true,
      paralegalPayoutSetupRequired: true,
      payoutReleaseTrigger: "when_attorney_completes_matter",
      bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
      bankDepositTimingDependsOn: ["stripe", "paralegal_bank"],
    }));
  });

  test("withdrawal, relist, and archive policies expose review and storage blockers", () => {
    const paused = activeCase({
      status: "paused",
      pausedReason: "paralegal_withdrew",
      payoutFinalizedAt: new Date("2026-07-20T00:00:00Z"),
      remainingAmount: 25_000,
      disputeDeadlineAt: new Date("2026-07-21T00:00:00Z"),
    });
    const withdrawal = evaluateWithdrawalAndRelist({ caseDoc: paused, now: new Date("2026-07-22T00:00:00Z") });
    expect(withdrawal.relist.ready).toBe(true);
    const archive = evaluateArchiveReadiness({
      caseDoc: activeCase({ status: "completed", archived: true, archiveZipKey: "cases/a/archive.zip" }),
      storageChecked: false,
    });
    expect(archive.blockers).toContain("archive_storage_unverified");
    expect(CASE_ARCHIVE_RETENTION_MONTHS).toBe(6);
    expect(calculateArchivePurgeAt(new Date("2026-01-15T00:00:00Z")).toISOString())
      .toBe("2026-07-15T00:00:00.000Z");
  });

  test("termination policy shares dispute-initiation prerequisites", () => {
    expect(evaluateTerminationEligibility({ caseDoc: activeCase(), ownerAuthorized: true })).toEqual(
      expect.objectContaining({ ready: true, facts: expect.objectContaining({ opensDisputeReview: true }) })
    );
    expect(evaluateTerminationEligibility({
      caseDoc: activeCase({ terminationStatus: "disputed" }),
      ownerAuthorized: true,
    }).blockers).toContain("termination_already_in_progress");
  });

  test("enforcing routes import the shared policy instead of private minimum/timing rules", () => {
    const root = path.join(__dirname, "..");
    const sources = ["routes/cases.js", "routes/jobs.js", "routes/applications.js", "routes/messages.js", "routes/payments.js"]
      .map((relative) => fs.readFileSync(path.join(root, relative), "utf8"));
    for (const source of sources) expect(source).toContain("attorneyWorkflowPolicy");
    expect(sources[0]).toContain("evaluateCompletionEligibility");
    expect(sources[0]).toContain("evaluateHiringEligibility");
    expect(sources[0]).toContain("evaluateInvitationEligibility");
    expect(sources[0]).toContain("evaluatePreEngagementRequest");
    expect(sources[0]).toContain("evaluateWithdrawalAndRelist");
    expect(sources[0]).toContain("evaluateTerminationEligibility");
    expect(sources[0]).toContain("evaluateArchiveReadiness");
    expect(sources[0]).toContain("calculateArchivePurgeAt");
    expect(sources[1]).toContain("evaluateMatterPosting");
    expect(sources[2]).toContain("evaluateApplicationEligibility");
    expect(sources[3]).toContain("evaluateMessagingPermission");
    expect(sources[4]).toContain("bankDepositEstimateBusinessDays");
    expect(sources[4]).not.toContain("ranges from 3–5 business days");
  });

  test("stage registry includes every Package 2 workflow family", () => {
    expect(Object.values(ATTORNEY_WORKFLOW_STAGES)).toEqual(expect.arrayContaining([
      "post_matter", "receive_applications", "invite_paralegal", "pre_engagement", "hire_and_fund",
      "workspace", "messaging", "complete_and_release", "withdrawal_decision", "termination", "relist", "archive_download",
    ]));
  });

  test("case model and payment routes consume one current fee policy while historical cases retain snapshots", () => {
    expect(getCurrentPlatformFeePolicy()).toEqual({
      attorneyPercent: DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
      paralegalPercent: DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
      attorneyChargeTiming: "charged_when_hire_is_confirmed",
      historicalSource: "case_fee_snapshot",
    });
    const root = path.join(__dirname, "..");
    for (const relative of ["models/Case.js", "routes/cases.js", "routes/payments.js"]) {
      expect(fs.readFileSync(path.join(root, relative), "utf8")).toContain("platformFeePolicy");
    }
  });
});
