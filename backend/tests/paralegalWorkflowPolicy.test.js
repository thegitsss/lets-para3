const fs = require("fs");
const path = require("path");
const {
  allScopeTasksComplete,
  evaluateApplicationEligibility,
  evaluateArchiveAccess,
  evaluateCompletionState,
  evaluateInvitationEligibility,
  evaluateMessagingPermission,
  evaluatePayoutReadiness,
  evaluatePreEngagementSubmission,
  evaluateWithdrawalEligibility,
  evaluateWorkspaceAccess,
} = require("../services/paralegalWorkflowPolicy");

const paralegal = { _id: "para-1", role: "paralegal", status: "approved" };

describe("paralegal workflow policy", () => {
  test("allows an approved paralegal to apply only to an open unassigned matter", () => {
    expect(evaluateApplicationEligibility({
      user: paralegal,
      caseDoc: { status: "open", tasks: [{ completed: false }] },
    })).toMatchObject({ allowed: true, blockers: [] });

    expect(evaluateApplicationEligibility({
      user: paralegal,
      caseDoc: { status: "in progress", paralegalId: "para-2" },
      alreadyApplied: true,
    }).blockers).toEqual(expect.arrayContaining([
      "open_matter_required",
      "matter_already_assigned",
      "application_already_exists",
    ]));
  });

  test("preserves the mutation-route application contract through the shared policy", () => {
    expect(evaluateApplicationEligibility({
      attorneyPaymentMethodSaved: true,
      applicantApproved: true,
      partiesBlocked: false,
      caseStatus: "open",
      jobStatus: "open",
      archived: false,
      paralegalAssigned: false,
      duplicateApplication: false,
      profilePhotoReady: true,
      payoutSetupReady: true,
    })).toMatchObject({ ready: true, allowed: true, blockers: [] });
  });

  test("requires a pending invitation, defined scope, and ready payout setup", () => {
    const eligible = evaluateInvitationEligibility({
      user: paralegal,
      caseDoc: { status: "open", tasks: [{ completed: false }] },
      inviteStatus: "pending",
      stripeState: { accountId: "acct_synthetic", detailsSubmitted: true, payoutsEnabled: true },
    });
    expect(eligible.allowed).toBe(true);

    const blocked = evaluateInvitationEligibility({
      user: paralegal,
      caseDoc: { status: "open", tasks: [] },
      inviteStatus: "expired",
      stripeState: {},
    });
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      "pending_invitation_required",
      "scope_tasks_required",
      "payout_account_required",
      "payout_setup_incomplete",
    ]));
  });

  test("limits pre-engagement submission to the requested paralegal and editable states", () => {
    const result = evaluatePreEngagementSubmission({
      user: paralegal,
      caseDoc: {
        preEngagement: {
          requestedParalegalId: "para-2",
          status: "approved",
        },
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "requested_paralegal_required",
      "pre_engagement_not_editable",
    ]));
  });

  test("allows assigned workspace access and makes withdrawn access read-only", () => {
    expect(evaluateWorkspaceAccess({
      user: paralegal,
      caseDoc: { status: "in progress", paralegalId: "para-1" },
    })).toMatchObject({
      allowed: true,
      facts: { relationship: "assigned", readOnly: false },
    });

    expect(evaluateWorkspaceAccess({
      user: paralegal,
      caseDoc: { status: "paused", withdrawnParalegalId: "para-1" },
    })).toMatchObject({
      allowed: true,
      facts: { relationship: "withdrawn", readOnly: true },
    });

    expect(evaluateWorkspaceAccess({
      user: paralegal,
      caseDoc: { status: "in progress", paralegalId: "para-2" },
    }).blockers).toContain("authorized_matter_relationship_required");
  });

  test("denies messaging after completion, in read-only mode, or without active assignment", () => {
    const result = evaluateMessagingPermission({
      user: paralegal,
      caseDoc: {
        status: "completed",
        readOnly: true,
        withdrawnParalegalId: "para-1",
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "matter_read_only",
      "matter_final",
      "active_assignment_required",
    ]));
  });

  test("separates task completion, attorney completion, fund release, and bank receipt", () => {
    const caseDoc = {
      status: "in progress",
      paralegalId: "para-1",
      tasks: [{ completed: true }, { completed: true }],
      paymentReleased: false,
    };
    expect(allScopeTasksComplete(caseDoc)).toBe(true);
    expect(evaluateCompletionState({ user: paralegal, caseDoc })).toMatchObject({
      allowed: true,
      facts: {
        allScopeTasksComplete: true,
        matterCompleted: false,
        paymentReleased: false,
        nextActor: "attorney",
      },
    });

    const payout = evaluatePayoutReadiness({
      user: paralegal,
      caseDoc,
      stripeState: { accountId: "acct_synthetic", detailsSubmitted: true, payoutsEnabled: true },
    });
    expect(payout.allowed).toBe(false);
    expect(payout.blockers).toContain("payment_not_released");
    expect(payout.facts.bankReceiptConfirmed).toBe(false);
  });

  test("allows withdrawal only during an active unfinished assignment", () => {
    expect(evaluateWithdrawalEligibility({
      user: paralegal,
      caseDoc: {
        status: "in progress",
        paralegalId: "para-1",
        tasks: [{ completed: true }, { completed: false }],
      },
    })).toMatchObject({
      allowed: true,
      facts: { completedTaskCount: 1, totalTaskCount: 2, outcomeRequiresReview: true },
    });

    expect(evaluateWithdrawalEligibility({
      user: paralegal,
      caseDoc: {
        status: "completed",
        paralegalId: "para-1",
        tasks: [{ completed: true }],
      },
    }).blockers).toEqual(expect.arrayContaining([
      "matter_not_withdrawable",
      "all_scope_tasks_complete",
    ]));
  });

  test("does not claim archive availability until storage is verified", () => {
    const unverified = evaluateArchiveAccess({
      user: paralegal,
      caseDoc: { status: "completed", paralegalId: "para-1", archived: true },
      storageChecked: false,
    });
    expect(unverified.allowed).toBe(false);
    expect(unverified.blockers).toContain("archive_storage_unverified");

    const verified = evaluateArchiveAccess({
      user: paralegal,
      caseDoc: { status: "completed", paralegalId: "para-1", archived: true },
      storageChecked: true,
      storageObjectExists: true,
    });
    expect(verified.allowed).toBe(true);
  });

  test("is imported by the existing paralegal mutation gates", () => {
    const sources = [
      fs.readFileSync(path.join(__dirname, "../routes/applications.js"), "utf8"),
      fs.readFileSync(path.join(__dirname, "../routes/messages.js"), "utf8"),
      fs.readFileSync(path.join(__dirname, "../routes/cases.js"), "utf8"),
    ];
    expect(sources[0]).toContain('require("../services/paralegalWorkflowPolicy")');
    expect(sources[0]).toContain("evaluateApplicationEligibility");
    expect(sources[1]).toContain("evaluateParalegalMessagingPermission");
    expect(sources[2]).toContain("evaluateParalegalInvitationAcceptance");
    expect(sources[2]).toContain("evaluatePreEngagementSubmission");
    expect(sources[2]).toContain("evaluateWithdrawalEligibility");
  });
});
