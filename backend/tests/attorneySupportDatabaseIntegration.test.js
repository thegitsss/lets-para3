const mongoose = require("mongoose");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_package6_attorney_support";
process.env.OPENAI_SUPPORT_MANAGER_ENABLED = "true";

const mockStripe = {
  customers: { retrieve: jest.fn() },
  paymentMethods: { retrieve: jest.fn() },
  accounts: { retrieve: jest.fn() },
};

jest.mock("../utils/stripe", () => mockStripe);

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const {
  SYNTHETIC_DOMAIN,
  assertSyntheticFixtureData,
  seedAttorneySupportFixtures,
} = require("./helpers/attorneySupportFixtures");
const Case = require("../models/Case");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const {
  buildAttorneyEvidencePlan,
} = require("../ai/attorneyConversationPolicy");
const {
  executeSupportManagerTool,
} = require("../ai/supportAgentTools");
const {
  generateSupportManagerReply,
} = require("../ai/supportManagerAgent");

function managerReply(overrides = {}) {
  return {
    reply: "The verified answer is available.",
    suggestions: [],
    navigation: null,
    primaryAsk: "package_6_integration",
    activeTask: "FACT_LOOKUP",
    awaitingField: "",
    responseMode: "DIRECT_ANSWER",
    confidence: "high",
    detailLevel: "concise",
    evidenceCapability: "account_fact",
    ...overrides,
  };
}

function scriptedManagerClient({ toolName, args, finalReply, invalidReplies = [] }) {
  const responses = [
    {
      id: `p6-${toolName}-tool`,
      model: "package-6-scripted-manager",
      output: [{
        type: "function_call",
        call_id: `call-${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    ...invalidReplies.map((reply, index) => ({
      id: `p6-${toolName}-invalid-${index}`,
      model: "package-6-scripted-manager",
      output: [],
      output_parsed: reply,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })),
    {
      id: `p6-${toolName}-final`,
      model: "package-6-scripted-manager",
      output: [],
      output_parsed: finalReply,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  ];
  return { responses: { parse: jest.fn().mockImplementation(async () => responses.shift()) } };
}

describe("attorney assistant Package 6 database-backed integration", () => {
  let fixture;

  beforeAll(async () => {
    await connect();
  });

  beforeEach(async () => {
    await clearDatabase();
    mockStripe.customers.retrieve.mockReset();
    mockStripe.paymentMethods.retrieve.mockReset();
    mockStripe.accounts.retrieve.mockReset();
    mockStripe.customers.retrieve.mockImplementation(async (customerId) => {
      if (customerId === "cus_p6_failure") throw new Error("synthetic processor timeout");
      if (customerId === "cus_p6_none") return { id: customerId, invoice_settings: { default_payment_method: null } };
      return { id: customerId, invoice_settings: { default_payment_method: `pm_${customerId}` } };
    });
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_p6_saved",
      type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2032 },
    });
    fixture = await seedAttorneySupportFixtures();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("uses synthetic-only isolated fixtures covering no, one, and multiple matters plus every material lifecycle", async () => {
    expect(assertSyntheticFixtureData(fixture)).toBe(true);
    expect(Object.values(fixture.users).every((user) => user.email.endsWith(`@${SYNTHETIC_DOMAIN}`))).toBe(true);

    const [empty, one, many] = await Promise.all([
      executeSupportManagerTool("get_my_case_overview", { status_scope: "all" }, { user: fixture.users.emptyAttorney }),
      executeSupportManagerTool("get_my_case_overview", { status_scope: "all" }, { user: fixture.users.oneAttorney }),
      executeSupportManagerTool("get_my_case_overview", { status_scope: "all" }, { user: fixture.users.owner }),
    ]);
    expect(empty).toEqual(expect.objectContaining({ available: true, totalCount: 0, evidenceState: "verified" }));
    expect(one).toEqual(expect.objectContaining({ available: true, totalCount: 1, evidenceState: "verified" }));
    expect(many).toEqual(expect.objectContaining({ available: true, totalCount: 7, completedCount: 3 }));
    expect(many.byStatus).toEqual(expect.objectContaining({
      open: 1,
      "in progress": 1,
      paused: 1,
      completed: 1,
      disputed: 1,
      closed: 2,
    }));
  });

  test("queries real workspace, application, message, deadline, and participant records", async () => {
    const context = { user: fixture.users.owner, conversationState: {}, conversationHistory: [] };
    const workspace = await executeSupportManagerTool(
      "get_attorney_case_workspace",
      { case_reference: "Active Discovery Matter" },
      context
    );
    expect(workspace).toEqual(expect.objectContaining({
      ok: true,
      available: true,
      title: fixture.cases.active.title,
      deadline: "2026-08-15T21:00:00.000Z",
      assignedParalegal: { assigned: true, name: "P6 Assigned" },
      tasks: expect.objectContaining({ total: 2, completed: 1, incomplete: 1, locked: true }),
      files: expect.objectContaining({ total: 2, pendingReview: 0, revisionsRequested: 1, approved: 1 }),
    }));

    const openWorkspace = await executeSupportManagerTool(
      "get_attorney_case_workspace",
      { case_reference: "Open Intake Matter" },
      context
    );
    expect(openWorkspace.applications).toEqual(expect.objectContaining({ total: 1, pending: 1 }));
    expect(openWorkspace.invitations).toEqual(expect.objectContaining({ pending: 1 }));
    expect(openWorkspace.preEngagement).toEqual(expect.objectContaining({
      status: "submitted",
      confidentialityRequired: true,
      conflictsCheckRequired: true,
    }));

    const [applications, messages, deadline] = await Promise.all([
      executeSupportManagerTool("get_attorney_application_activity", {}, context),
      executeSupportManagerTool("get_attorney_message_activity", {}, context),
      executeSupportManagerTool("get_next_deadline", {}, context),
    ]);
    expect(applications).toEqual(expect.objectContaining({ pendingApplicationCount: 1, aggregationComplete: true }));
    expect(applications.recentApplications[0]).toEqual(expect.objectContaining({ applicantName: "P6 Applicant" }));
    expect(messages).toEqual(expect.objectContaining({ unreadCount: 1, awaitingAttorneyReplyCount: 1 }));
    expect(deadline).toEqual(expect.objectContaining({
      found: true,
      accessible: true,
      title: fixture.cases.active.title,
      evidenceState: "verified",
    }));
  });

  test("queries real charges, fee snapshots, payout ledger, receipts, and billing aggregates", async () => {
    const context = { user: fixture.users.owner, conversationState: {}, conversationHistory: [] };
    const financials = await executeSupportManagerTool(
      "get_attorney_case_financials",
      { case_reference: "Completed Payout Matter" },
      context
    );
    expect(financials).toEqual(expect.objectContaining({
      available: true,
      matterAmount: { cents: 100000, formatted: "$1,000.00" },
      attorneyPlatformFee: expect.objectContaining({ cents: 22000, formatted: "$220.00", percent: 22 }),
      totalAttorneyCharge: { cents: 122000, formatted: "$1,220.00" },
      paralegalPlatformFee: expect.objectContaining({ cents: 18000, formatted: "$180.00", percent: 18 }),
      netParalegalPayout: { cents: 82000, formatted: "$820.00", source: "payout_ledger" },
    }));
    const receipts = await executeSupportManagerTool("get_attorney_receipt_history", {}, context);
    expect(receipts.receiptCount).toBe(2);
    expect(receipts.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: fixture.cases.completed.title, totalCharge: { cents: 122000, formatted: "$1,220.00" } }),
    ]));
    const summary = await executeSupportManagerTool("get_attorney_billing_summary", {}, context);
    expect(summary).toEqual(expect.objectContaining({
      aggregationComplete: true,
      totalSpent: { cents: 122000, formatted: "$1,220.00" },
      activeFunded: { cents: 250000, formatted: "$2,500.00" },
    }));

    const settlement = await executeSupportManagerTool(
      "get_attorney_case_financials",
      { case_reference: "Disputed Settlement Matter" },
      context
    );
    expect(settlement).toEqual(expect.objectContaining({
      attorneyPlatformFee: expect.objectContaining({ cents: 11000, formatted: "$110.00" }),
      paralegalPlatformFee: expect.objectContaining({ cents: 9000, formatted: "$90.00" }),
      netParalegalPayout: expect.objectContaining({ cents: 41000, formatted: "$410.00" }),
      financialEvidence: expect.objectContaining({
        payoutGrossAmount: { cents: 50000, formatted: "$500.00" },
      }),
    }));
  });

  test("preserves dispute, withdrawal, termination, settlement, relist, completion, archive, download, and purge state", async () => {
    const context = { user: fixture.users.owner, conversationState: {}, conversationHistory: [] };
    const [paused, disputed, completed, archived, purged] = await Promise.all([
      executeSupportManagerTool("get_attorney_case_workspace", { case_reference: "Paused Withdrawal Matter" }, context),
      executeSupportManagerTool("get_attorney_case_workspace", { case_reference: "Disputed Settlement Matter" }, context),
      executeSupportManagerTool("get_attorney_case_workspace", { case_reference: "Completed Payout Matter" }, context),
      executeSupportManagerTool("get_attorney_case_workspace", { case_reference: "Closed Archive Matter" }, context),
      executeSupportManagerTool("get_attorney_case_workspace", { case_reference: "Closed Purged Matter" }, context),
    ]);
    expect(paused.lifecycle).toEqual(expect.objectContaining({
      payoutFinalizedType: "partial_attorney",
      partialPayoutAmount: { cents: 30000, formatted: "$300.00" },
      remainingAmount: { cents: 70000, formatted: "$700.00" },
      relistPending: true,
    }));
    expect(disputed).toEqual(expect.objectContaining({
      disputes: expect.objectContaining({ total: 1, open: 0 }),
      lifecycle: expect.objectContaining({ terminationStatus: "resolved", terminationReason: "Synthetic scope ended." }),
    }));
    expect(completed.lifecycle.completedAt).toBe("2026-07-15T12:00:00.000Z");
    expect(archived.lifecycle).toEqual(expect.objectContaining({
      archived: true,
      archiveReadyAt: "2026-05-02T12:00:00.000Z",
      archiveDownloadedAt: "2026-05-03T12:00:00.000Z",
      purgeScheduledFor: "2026-11-01T12:00:00.000Z",
      archiveEvidenceState: "unknown",
      archiveStorageChecked: false,
    }));
    expect(fixture.cases.archived.downloadUrl).toEqual(["/synthetic/package6/archive.zip"]);
    expect(purged.lifecycle.archiveEvidenceState).toBe("not_applicable");
  });

  test("uses contract-faithful isolated processor states for saved, absent, and failed payment lookups", async () => {
    const saved = await executeSupportManagerTool("get_billing_snapshot", {}, {
      user: fixture.users.owner,
      pageContext: { viewName: "billing" },
    });
    const absent = await executeSupportManagerTool("get_billing_snapshot", {}, {
      user: fixture.users.oneAttorney,
      pageContext: { viewName: "billing" },
    });
    const failingUser = { ...fixture.users.owner, stripeCustomerId: "cus_p6_failure" };
    const unavailable = await executeSupportManagerTool("get_billing_snapshot", {}, {
      user: failingUser,
      pageContext: { viewName: "billing" },
    });
    expect(saved).toEqual(expect.objectContaining({ evidenceState: "verified", source: "live", last4: "4242", isValid: true }));
    expect(absent).toEqual(expect.objectContaining({ evidenceState: "absent", source: "live_none", isValid: false }));
    expect(unavailable).toEqual(expect.objectContaining({ evidenceState: "temporarily_unavailable", source: "lookup_failed" }));

    const workflow = await executeSupportManagerTool("get_attorney_workflow_readiness", { capability: "posting" }, {
      user: fixture.users.owner,
      pageContext: {},
    });
    expect(workflow).toEqual(expect.objectContaining({
      authoritativeWorkflow: true,
      paymentMethod: expect.objectContaining({ stateKnown: true, saved: true, usable: true }),
      requirements: expect.objectContaining({
        paymentMethodRequiredBeforePosting: true,
        paymentMethodRequiredBeforeApplications: true,
        paymentMethodRequiredBeforeHiring: true,
        chargeTiming: "charged_when_hire_is_confirmed",
      }),
    }));
  });

  test("enforces ownership so cross-user records cannot affect counts, workspaces, amounts, or answers", async () => {
    const context = { user: fixture.users.owner, conversationState: {}, conversationHistory: [] };
    const overview = await executeSupportManagerTool("get_my_case_overview", { status_scope: "all" }, context);
    expect(overview.totalCount).toBe(7);
    expect(JSON.stringify(overview)).not.toContain(fixture.cases.inaccessible.title);
    expect(JSON.stringify(overview)).not.toContain("999999");

    const workspace = await executeSupportManagerTool(
      "get_attorney_case_workspace",
      { case_reference: fixture.cases.inaccessible.title },
      context
    );
    const financials = await executeSupportManagerTool(
      "get_attorney_case_financials",
      { case_reference: String(fixture.caseIds.inaccessible) },
      context
    );
    expect(workspace).toEqual(expect.objectContaining({ available: false }));
    expect(financials).toEqual(expect.objectContaining({ available: false }));
    expect(JSON.stringify({ workspace, financials })).not.toContain("$9,999.99");
  });

  test("runs the real manager-to-tool-to-validator path and matches the deterministic route contract", async () => {
    const messageText = "How many matters have I completed?";
    const evidencePlan = buildAttorneyEvidencePlan({ messageText });
    expect(evidencePlan.requirements).toEqual([
      expect.objectContaining({ key: "case_overview", anyOf: ["get_my_case_overview"] }),
    ]);
    const client = scriptedManagerClient({
      toolName: "get_my_case_overview",
      args: { status_scope: "completed" },
      finalReply: managerReply({
        reply: "You have 3 completed matters.",
        primaryAsk: "completed_case_count",
      }),
    });
    const result = await generateSupportManagerReply({
      messageText,
      user: fixture.users.owner,
      client,
    });
    expect(result).toEqual(expect.objectContaining({
      reply: "You have 3 completed matters.",
      provider: "openai_manager",
      grounded: true,
      suggestions: [],
      navigation: null,
      supportFacts: expect.objectContaining({ evidenceStatus: "verified" }),
      telemetry: expect.objectContaining({
        validationExhausted: false,
        toolCalls: [expect.objectContaining({ name: "get_my_case_overview", ok: true })],
      }),
    }));
    expect(result.supportFacts.toolEvidence[0].result.completedCount).toBe(3);
  });

  test("persists verified entity state and resolves a pronoun follow-up against refreshed database facts", async () => {
    const firstClient = scriptedManagerClient({
      toolName: "get_attorney_case_workspace",
      args: { case_reference: "Active Discovery Matter" },
      finalReply: managerReply({
        reply: "P6 Synthetic Active Discovery Matter has 1 incomplete task.",
        primaryAsk: "matter_tasks",
      }),
    });
    const first = await generateSupportManagerReply({
      messageText: "What tasks are open on Active Discovery Matter?",
      user: fixture.users.owner,
      client: firstClient,
    });
    expect(first.activeEntity).toEqual(expect.objectContaining({
      type: "case",
      id: String(fixture.caseIds.active),
      name: fixture.cases.active.title,
    }));

    const conversation = await SupportConversation.create({
      userId: fixture.ids.owner,
      role: "attorney",
      sourceSurface: "attorney",
      sourcePage: "/dashboard-attorney.html",
      metadata: { support: { activeEntity: first.activeEntity, verifiedEntities: first.verifiedEntities } },
    });
    await SupportMessage.create([
      { conversationId: conversation._id, sender: "user", text: "What tasks are open on Active Discovery Matter?" },
      { conversationId: conversation._id, sender: "assistant", text: first.reply, metadata: { activeEntity: first.activeEntity } },
    ]);
    const persisted = await SupportConversation.findById(conversation._id).lean();
    expect(persisted.metadata.support.activeEntity.id).toBe(String(fixture.caseIds.active));

    await Case.updateOne({ _id: fixture.caseIds.active }, { $set: { status: "paused", pausedReason: "attorney_paused" } });
    const followUpClient = scriptedManagerClient({
      toolName: "get_case_details",
      args: { case_reference: "it" },
      finalReply: managerReply({
        reply: "P6 Synthetic Active Discovery Matter is now paused.",
        primaryAsk: "matter_status",
      }),
    });
    const followUp = await generateSupportManagerReply({
      messageText: "what is its status now?",
      user: fixture.users.owner,
      conversationId: String(conversation._id),
      conversationState: persisted.metadata.support,
      client: followUpClient,
    });
    expect(followUp.reply).toBe("P6 Synthetic Active Discovery Matter is now paused.");
    expect(followUp.activeEntity.id).toBe(String(fixture.caseIds.active));
    expect(followUp.supportFacts.toolEvidence[0].result.status).toBe("paused");
  });

  test("asserts authorized navigation and rejects unverified navigation payloads", async () => {
    const allowedClient = scriptedManagerClient({
      toolName: "find_navigation_destination",
      args: { destination: "billing" },
      finalReply: managerReply({
        reply: "Open Billing & Payments.",
        activeTask: "NAVIGATION",
        navigation: {
          ctaLabel: "Billing & payments",
          ctaHref: "dashboard-attorney.html#billing",
          inlineLinkText: "Billing & Payments",
        },
      }),
    });
    const allowed = await generateSupportManagerReply({
      messageText: "Where is billing?",
      user: fixture.users.owner,
      client: allowedClient,
    });
    expect(allowed.navigation).toEqual(expect.objectContaining({ ctaHref: "dashboard-attorney.html#billing" }));
    expect(allowed.suggestions).toEqual([]);

    const strippedClient = scriptedManagerClient({
      toolName: "find_navigation_destination",
      args: { destination: "billing" },
      finalReply: managerReply({
        reply: "Open Billing & Payments.",
        activeTask: "NAVIGATION",
        navigation: {
          ctaLabel: "Admin finance",
          ctaHref: "admin-dashboard.html#finance",
          inlineLinkText: "finance",
        },
      }),
    });
    const stripped = await generateSupportManagerReply({
      messageText: "Where is billing?",
      user: fixture.users.owner,
      client: strippedClient,
    });
    expect(stripped.navigation).toBeNull();
  });

  test("turns repeated semantic validation failures into the concise safe fallback", async () => {
    const invalid = managerReply({ reply: "You have 99 completed matters." });
    const client = scriptedManagerClient({
      toolName: "get_my_case_overview",
      args: { status_scope: "completed" },
      invalidReplies: [invalid, invalid],
      finalReply: invalid,
    });
    const result = await generateSupportManagerReply({
      messageText: "How many matters have I completed?",
      user: fixture.users.owner,
      client,
      maxIterations: 6,
    });
    expect(result).toEqual(expect.objectContaining({
      reply: "You have 3 completed matters.",
      suggestions: [],
      navigation: null,
      provider: "openai_manager_safe_fallback",
      grounded: true,
      supportFacts: expect.objectContaining({
        evidenceStatus: "verified_fallback",
        failureClass: "generation_replaced_from_verified_evidence",
      }),
      telemetry: expect.objectContaining({
        validationRetries: 2,
        validationExhausted: true,
        retryOutcome: "safe_fallback",
        validationFailures: expect.arrayContaining(["numeric_claim_absent_from_evidence"]),
      }),
    }));
  });

  test("turns a tool dependency failure into a truthful concise limitation without false absence", async () => {
    const client = scriptedManagerClient({
      toolName: "get_my_case_overview",
      args: { status_scope: "completed" },
      finalReply: managerReply({
        reply: "I couldn’t access your matter records right now. Please try again.",
        confidence: "low",
      }),
    });
    const toolExecutor = jest.fn().mockResolvedValue({
      ok: false,
      available: false,
      evidenceState: "temporarily_unavailable",
      error: "tool_execution_failed",
      retryable: true,
    });
    const result = await generateSupportManagerReply({
      messageText: "How many matters have I completed?",
      user: fixture.users.owner,
      client,
      toolExecutor,
    });
    expect(result).toEqual(expect.objectContaining({
      reply: "I couldn’t access your matter records right now. Please try again.",
      confidence: "low",
      suggestions: [],
      navigation: null,
      provider: "openai_manager",
      telemetry: expect.objectContaining({
        validationExhausted: false,
        toolCalls: [expect.objectContaining({ name: "get_my_case_overview", ok: false })],
      }),
    }));
    expect(result.reply).not.toMatch(/you (?:have|do not have) (?:0|no) completed/i);
  });

  test("does not expose the manager to paralegal or admin roles during attorney hardening", async () => {
    const client = scriptedManagerClient({
      toolName: "get_my_case_overview",
      args: { status_scope: "all" },
      finalReply: managerReply(),
    });
    await expect(generateSupportManagerReply({
      messageText: "How many cases?",
      user: fixture.users.assignedParalegal,
      client,
    })).resolves.toBeNull();
    await expect(generateSupportManagerReply({
      messageText: "How many cases?",
      user: { _id: new mongoose.Types.ObjectId(), role: "admin" },
      client,
    })).resolves.toBeNull();
    expect(client.responses.parse).not.toHaveBeenCalled();
  });
});
