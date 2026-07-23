const mongoose = require("mongoose");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_support_agent_tools";

const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Application = require("../models/Application");
const Job = require("../models/Job");
const Message = require("../models/Message");
const Payout = require("../models/Payout");
const User = require("../models/User");
const stripe = require("../utils/stripe");
const {
  executeSupportManagerTool,
  getAttorneyApplicationActivity,
  getAttorneyMessageActivity,
  getMyCaseOverview,
  getNavigationDestination,
  getSupportManagerToolDefinitions,
  validateToolArguments,
} = require("../ai/supportAgentTools");

describe("support manager tool permissions", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("publishes role-specific tool sets", () => {
    const attorneyTools = getSupportManagerToolDefinitions("attorney").map((tool) => tool.name);
    const paralegalTools = getSupportManagerToolDefinitions("paralegal").map((tool) => tool.name);
    const adminTools = getSupportManagerToolDefinitions("admin").map((tool) => tool.name);

    expect(attorneyTools).toContain("get_billing_snapshot");
    expect(attorneyTools).toContain("get_attorney_workflow_readiness");
    expect(attorneyTools).toContain("get_pending_paralegal_activity");
    expect(attorneyTools).toContain("get_attorney_application_activity");
    expect(attorneyTools).toContain("get_attorney_message_activity");
    expect(attorneyTools).toContain("get_attorney_attention_summary");
    expect(attorneyTools).toContain("get_attorney_case_financials");
    expect(attorneyTools).toContain("get_attorney_case_workspace");
    expect(attorneyTools).toContain("get_attorney_receipt_history");
    expect(attorneyTools).toContain("get_attorney_account_snapshot");
    expect(attorneyTools).toContain("get_attorney_matter_readiness");
    expect(attorneyTools).toContain("get_attorney_billing_summary");
    expect(attorneyTools).toContain("get_attorney_deactivation_eligibility");
    expect(attorneyTools).not.toContain("get_payout_snapshot");
    expect(paralegalTools).toContain("get_payout_snapshot");
    expect(paralegalTools).not.toContain("get_billing_snapshot");
    expect(paralegalTools).not.toContain("get_attorney_workflow_readiness");
    expect(paralegalTools).not.toContain("get_pending_paralegal_activity");
    expect(paralegalTools).not.toContain("get_attorney_attention_summary");
    expect(paralegalTools).not.toContain("get_attorney_case_workspace");
    expect(paralegalTools).not.toContain("get_attorney_receipt_history");
    expect(paralegalTools).not.toContain("get_attorney_account_snapshot");
    expect(adminTools).not.toContain("get_billing_snapshot");
    expect(adminTools).not.toContain("get_attorney_workflow_readiness");
    expect(adminTools).not.toContain("get_payout_snapshot");
  });

  test("rejects missing, extra, wrong-type, and invalid-enum tool arguments", async () => {
    expect(validateToolArguments("get_case_details", {})).toEqual(
      expect.objectContaining({ valid: false, error: "missing_tool_argument" })
    );
    expect(validateToolArguments("get_case_details", { case_reference: "Smith", user_id: "other" })).toEqual(
      expect.objectContaining({ valid: false, error: "unsupported_tool_argument", fields: ["user_id"] })
    );
    expect(validateToolArguments("get_case_details", { case_reference: 42 })).toEqual(
      expect.objectContaining({ valid: false, error: "invalid_tool_argument_type" })
    );
    expect(validateToolArguments("get_my_case_overview", { status_scope: "secret" })).toEqual(
      expect.objectContaining({ valid: false, error: "invalid_tool_argument_value" })
    );

    const result = await executeSupportManagerTool(
      "get_case_details",
      { case_reference: "Smith", user_id: "other" },
      { user: { _id: new mongoose.Types.ObjectId(), role: "attorney" } }
    );
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: "unsupported_tool_argument",
      evidenceState: "unknown",
    }));
  });

  test.each(["attorney", "paralegal", "admin"])(
    "returns the verified Contact Us destination for %s",
    (role) => {
      expect(validateToolArguments("find_navigation_destination", { destination: "contact" }))
        .toEqual(expect.objectContaining({ valid: true }));
      expect(getNavigationDestination(role, "contact")).toEqual({
        available: true,
        ctaLabel: "Contact Us",
        ctaHref: "contact.html",
        inlineLinkText: "here",
      });
    }
  );

  test("distinguishes saved, absent, and unavailable processor states", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    jest.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      invoice_settings: { default_payment_method: "pm_123" },
    });
    jest.spyOn(stripe.paymentMethods, "retrieve").mockResolvedValue({
      type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    });
    const saved = await executeSupportManagerTool("get_billing_snapshot", {}, {
      user: { _id: attorneyId, role: "attorney", stripeCustomerId: "cus_123" },
      pageContext: { supportCategory: "payment" },
    });
    expect(saved).toEqual(expect.objectContaining({ evidenceState: "verified", last4: "4242" }));

    const absent = await executeSupportManagerTool("get_billing_snapshot", {}, {
      user: { _id: attorneyId, role: "attorney", stripeCustomerId: "" },
      pageContext: { supportCategory: "payment" },
    });
    expect(absent).toEqual(expect.objectContaining({ evidenceState: "absent", source: "stored_missing" }));

    stripe.customers.retrieve.mockRejectedValueOnce(new Error("processor unavailable"));
    const unavailable = await executeSupportManagerTool("get_billing_snapshot", {}, {
      user: { _id: attorneyId, role: "attorney", stripeCustomerId: "cus_fail" },
      pageContext: { supportCategory: "payment" },
    });
    expect(unavailable).toEqual(expect.objectContaining({
      evidenceState: "temporarily_unavailable",
      source: "lookup_failed",
    }));
  });

  test("joins authoritative posting rules with the attorney's missing payment-method state", async () => {
    const result = await executeSupportManagerTool(
      "get_attorney_workflow_readiness",
      { capability: "posting" },
      {
        user: { _id: new mongoose.Types.ObjectId(), role: "attorney", stripeCustomerId: "" },
        pageContext: {},
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        available: true,
        authoritativeWorkflow: true,
        evidence: expect.objectContaining({
          capability: "posting",
          capabilityId: "A11_posting",
          sourceType: "executable_workflow_policy",
          policyOrLiveState: "mixed",
          authorized: true,
          facts: expect.any(Array),
        }),
        paymentMethod: expect.objectContaining({ stateKnown: true, saved: false }),
        requirements: expect.objectContaining({
          paymentMethodRequiredBeforePosting: true,
          paymentMethodRequiredBeforeApplications: true,
          paymentMethodRequiredBeforeHiring: true,
          chargeTiming: "charged_when_hire_is_confirmed",
          postHireWorkflow: {
            matterStatus: "in_progress",
            fundingStatus: "funded",
            scopeTasksLocked: true,
            nextStage: "workspace",
            workspaceParticipants: ["attorney", "hired_paralegal"],
            workspaceSupports: ["scope_tasks", "files", "messages"],
            completionStage: "complete_and_release",
          },
          paralegalPayoutTiming: expect.objectContaining({
            releaseTrigger: "when_attorney_completes_matter",
            allScopeTasksCompleteRequired: true,
            verifiedFundingRequired: true,
            paralegalPayoutSetupRequired: true,
            bankDepositEstimateBusinessDays: { minimum: 3, maximum: 5 },
            bankDepositTimingDependsOn: ["stripe", "paralegal_bank"],
          }),
        }),
      })
    );
    expect(result.stages.post_matter).toEqual(
      expect.objectContaining({ ready: false, blocker: "saved_payment_method_required" })
    );
  });

  test("joins the attorney charge snapshot with the actual paralegal payout ledger", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    const caseId = new mongoose.Types.ObjectId();
    const caseDoc = {
      _id: caseId,
      title: "Testing payout",
      status: "completed",
      attorney: attorneyId,
      attorneyId,
      currency: "usd",
      lockedTotalAmount: 10000,
      totalAmount: 10000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 2200,
      feeParalegalPct: 18,
      feeParalegalAmount: 1800,
      paymentReleased: true,
      paidOutAt: new Date("2026-02-18T12:00:00Z"),
    };
    jest.spyOn(Case, "findById").mockImplementation(() => ({
      select: () => ({ lean: async () => caseDoc }),
    }));
    jest.spyOn(Case, "find").mockReturnValue({
      select: () => ({
        sort: () => ({ limit: () => ({ lean: async () => [caseDoc] }) }),
      }),
    });
    jest.spyOn(Payout, "findOne").mockReturnValue({
      select: () => ({
        lean: async () => ({ caseId, amountPaid: 8200, createdAt: new Date("2026-02-18T12:00:00Z") }),
      }),
    });

    const result = await executeSupportManagerTool(
      "get_attorney_case_financials",
      { case_reference: "the matter you referenced" },
      {
        user: { _id: attorneyId, role: "attorney" },
        pageContext: {},
        conversationState: {},
        conversationHistory: [
          { role: "user", content: "How much was Testing payout for?" },
          { role: "assistant", content: "Do you mean the attorney charge or paralegal payout?" },
        ],
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        available: true,
        title: "Testing payout",
        matterAmount: { cents: 10000, formatted: "$100.00" },
        totalAttorneyCharge: { cents: 12200, formatted: "$122.00" },
        netParalegalPayout: {
          cents: 8200,
          formatted: "$82.00",
          source: "payout_ledger",
        },
      })
    );
  });

  test("returns complete attorney billing aggregates without a hidden row limit", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "find").mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            {
              currency: "usd",
              lockedTotalAmount: 10000,
              feeAttorneyAmount: 2200,
              paymentReleased: true,
            },
            {
              currency: "usd",
              lockedTotalAmount: 20000,
              escrowIntentId: "pi_active",
              escrowStatus: "funded",
              paymentReleased: false,
            },
            {
              currency: "usd",
              lockedTotalAmount: 30000,
              paralegalId: new mongoose.Types.ObjectId(),
              paymentReleased: false,
            },
          ],
        }),
      }),
    });
    const result = await executeSupportManagerTool("get_attorney_billing_summary", {}, {
      user: { _id: attorneyId, role: "attorney" },
    });
    expect(result).toEqual(expect.objectContaining({
      evidenceState: "verified",
      totalSpent: { cents: 12200, formatted: "$122.00" },
      activeFunded: { cents: 20000, formatted: "$200.00" },
      pendingFunding: { cents: 30000, formatted: "$300.00" },
      aggregationComplete: true,
    }));
  });

  test("uses the authoritative deactivation eligibility service without performing a mutation", async () => {
    jest.spyOn(Case, "countDocuments")
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const result = await executeSupportManagerTool("get_attorney_deactivation_eligibility", {}, {
      user: { _id: new mongoose.Types.ObjectId(), role: "attorney", disabled: false, deleted: false },
    });
    expect(result).toEqual(expect.objectContaining({
      evidenceState: "verified",
      canDeactivate: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "active_matters" }),
        expect.objectContaining({ code: "open_disputes" }),
        expect.objectContaining({ code: "unresolved_financials" }),
      ]),
    }));
  });

  test("returns a complete attorney matter workspace from a conversational case reference", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    const paralegalId = new mongoose.Types.ObjectId();
    const caseId = new mongoose.Types.ObjectId();
    const caseDoc = {
      _id: caseId,
      title: "Smith matter",
      practiceArea: "Litigation",
      status: "in progress",
      attorney: attorneyId,
      attorneyId,
      paralegal: paralegalId,
      paralegalId,
      deadline: new Date("2026-08-15T12:00:00Z"),
      tasks: [
        { title: "Prepare index", completed: false },
        { title: "Collect exhibits", completed: true },
      ],
      tasksLocked: true,
      files: [],
      applicants: [{ paralegalId, status: "accepted", appliedAt: new Date("2026-07-01T12:00:00Z") }],
      invites: [],
    };
    jest.spyOn(Case, "find").mockReturnValue({
      select: () => ({
        sort: () => ({ limit: () => ({ lean: async () => [caseDoc] }) }),
      }),
    });
    jest.spyOn(Case, "findById").mockReturnValue({
      select: () => ({ lean: async () => caseDoc }),
    });
    jest.spyOn(User, "find").mockReturnValue({
      select: () => ({ lean: async () => [{ _id: paralegalId, firstName: "Alex", lastName: "Rivera" }] }),
    });
    jest.spyOn(CaseFile, "find").mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            {
              originalName: "Draft index.pdf",
              status: "pending_review",
              version: 2,
              uploadedByRole: "paralegal",
            },
          ],
        }),
      }),
    });

    const result = await executeSupportManagerTool(
      "get_attorney_case_workspace",
      { case_reference: "that matter" },
      {
        user: { _id: attorneyId, role: "attorney" },
        conversationState: {},
        conversationHistory: [{ role: "user", content: "What is happening with the Smith matter?" }],
        pageContext: {},
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        available: true,
        caseId: String(caseId),
        title: "Smith matter",
        assignedParalegal: { assigned: true, name: "Alex Rivera" },
        tasks: expect.objectContaining({ total: 2, completed: 1, incomplete: 1, locked: true }),
        files: expect.objectContaining({ total: 1, pendingReview: 1 }),
      })
    );
  });

  test("returns safe attorney account completeness without secrets", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    jest.spyOn(User, "findById").mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: attorneyId,
          firstName: "Sam",
          lastName: "Counsel",
          email: "sam@example.test",
          lawFirm: "Counsel LLP",
          state: "NY",
          practiceAreas: ["Litigation"],
          bio: "Attorney bio",
          twoFactorEnabled: true,
          preferences: { theme: "mountain" },
        }),
      }),
    });

    const result = await executeSupportManagerTool("get_attorney_account_snapshot", {}, {
      user: { _id: attorneyId, role: "attorney" },
    });

    expect(result).toEqual(expect.objectContaining({
      available: true,
      profileComplete: null,
      profileAssessment: expect.objectContaining({
        evidenceState: "blocked_policy",
        assistantMinimumFieldsPresent: true,
      }),
    }));
    expect(JSON.stringify(result)).not.toMatch(/password|stripeCustomerId|backupCodes/i);
  });

  test("refuses a tool that is not authorized for the signed-in role before executing a lookup", async () => {
    await expect(
      executeSupportManagerTool(
        "get_payout_snapshot",
        {},
        { user: { _id: "507f1f77bcf86cd799439011", role: "attorney" } }
      )
    ).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: "tool_not_available_for_role",
      evidenceState: "unauthorized",
    }));
  });

  test("never falls back to another matter when an attorney requests a non-owned case id", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    const otherAttorneyId = new mongoose.Types.ObjectId();
    const otherCaseId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "findById").mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: otherCaseId,
          title: "Other attorney secret matter",
          attorney: otherAttorneyId,
          attorneyId: otherAttorneyId,
          status: "open",
        }),
      }),
    });
    const result = await executeSupportManagerTool(
      "get_case_details",
      { case_reference: String(otherCaseId) },
      { user: { _id: attorneyId, role: "attorney" }, pageContext: {} }
    );
    expect(result).toEqual(expect.objectContaining({
      found: false,
      clarificationNeeded: true,
    }));
    expect(JSON.stringify(result)).not.toContain("Other attorney secret matter");
  });

  test("returns navigation only from the signed-in role's allowlist", () => {
    expect(getNavigationDestination("attorney", "billing")).toEqual(
      expect.objectContaining({ available: true, ctaHref: "dashboard-attorney.html#billing" })
    );
    expect(getNavigationDestination("paralegal", "billing")).toEqual({
      available: false,
      reason: "destination_not_available_for_role",
    });
    expect(getNavigationDestination("admin", "knowledge")).toEqual(
      expect.objectContaining({ available: true, ctaHref: "admin-dashboard.html#knowledge-studio" })
    );
  });

  test("converts lookup failures into a safe retryable unavailable result", async () => {
    jest.spyOn(Case, "find").mockImplementation(() => {
      throw new Error("database host and credentials must never be exposed");
    });
    const result = await executeSupportManagerTool(
      "get_my_case_overview",
      { status_scope: "all" },
      { user: { _id: new mongoose.Types.ObjectId(), role: "attorney" } }
    );
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: "tool_execution_failed",
      retryable: true,
      evidenceState: "temporarily_unavailable",
    }));
    expect(JSON.stringify(result)).not.toMatch(/credentials|database host/i);
  });

  test("returns exact role-scoped case counts and a completed-case view", async () => {
    const lean = jest.fn().mockResolvedValue([
      {
        _id: "507f1f77bcf86cd799439021",
        title: "Completed matter",
        status: "completed",
        tasks: [{ title: "Done", completed: true }],
        applicants: [],
      },
      {
        _id: "507f1f77bcf86cd799439022",
        title: "Closed matter",
        status: "closed",
        tasks: [],
        applicants: [],
      },
      {
        _id: "507f1f77bcf86cd799439023",
        title: "Active matter",
        status: "in progress",
        tasks: [{ title: "Draft", completed: false }],
        applicants: [{ status: "pending" }],
      },
    ]);
    const sort = jest.fn().mockReturnValue({ lean });
    const select = jest.fn().mockReturnValue({ sort });
    const find = jest.spyOn(Case, "find").mockReturnValue({ select });
    const user = { _id: "507f1f77bcf86cd799439011", role: "attorney" };

    const overview = await getMyCaseOverview(user, "completed");

    expect(find).toHaveBeenCalledWith({
      $or: [{ attorney: user._id }, { attorneyId: user._id }],
    });
    expect(overview).toEqual(
      expect.objectContaining({ totalCount: 3, activeCount: 1, completedCount: 2 })
    );
    expect(overview.recentCases.map((entry) => entry.title)).toEqual([
      "Completed matter",
      "Closed matter",
    ]);
  });

  test("returns attorney-scoped pending applications with safe applicant names", async () => {
    const paralegalId = new mongoose.Types.ObjectId();
    const caseId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "find").mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            {
              _id: caseId,
              title: "Trademark review",
              status: "open",
              applicants: [
                { paralegalId, status: "pending", appliedAt: new Date("2026-07-20T12:00:00Z") },
                { paralegalId: new mongoose.Types.ObjectId(), status: "rejected" },
              ],
            },
          ],
        }),
      }),
    });
    jest.spyOn(Job, "find").mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    jest.spyOn(Application, "find").mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    jest.spyOn(User, "find").mockReturnValue({
      select: () => ({ lean: async () => [{ _id: paralegalId, firstName: "Alex", lastName: "Rivera" }] }),
    });

    const result = await getAttorneyApplicationActivity({
      _id: new mongoose.Types.ObjectId(),
      role: "attorney",
    });

    expect(result.pendingApplicationCount).toBe(1);
    expect(result.caseCountWithPendingApplications).toBe(1);
    expect(result.recentApplications).toEqual([
      expect.objectContaining({ caseTitle: "Trademark review", applicantName: "Alex Rivera" }),
    ]);
  });

  test("summarizes account-wide attorney message response state without message contents", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    const firstCaseId = new mongoose.Types.ObjectId();
    const secondCaseId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "find").mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: firstCaseId, title: "Case one", status: "in progress" },
          { _id: secondCaseId, title: "Case two", status: "open" },
        ],
      }),
    });
    jest.spyOn(User, "findById").mockReturnValue({
      select: () => ({ lean: async () => ({ messageLastViewedAt: new Map() }) }),
    });
    jest
      .spyOn(Message, "aggregate")
      .mockResolvedValue([
        { _id: firstCaseId, senderRole: "paralegal", createdAt: new Date("2026-07-21T12:00:00Z") },
        { _id: secondCaseId, senderRole: "attorney", createdAt: new Date("2026-07-20T12:00:00Z") },
      ]);
    jest.spyOn(Message, "countDocuments")
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

    const result = await getAttorneyMessageActivity({ _id: attorneyId, role: "attorney" });

    expect(result).toEqual(
      expect.objectContaining({
        unreadCount: 2,
        awaitingAttorneyReplyCount: 1,
        awaitingParalegalReplyCount: 1,
      })
    );
    expect(result.cases[0]).not.toHaveProperty("lastMessagePreview");
  });
});
