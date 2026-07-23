process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_package6_paralegal_support";

const mockStripe = {
  accounts: { retrieve: jest.fn() },
};

jest.mock("../utils/stripe", () => mockStripe);

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const {
  SYNTHETIC_DOMAIN,
  assertSyntheticFixtureData,
  seedParalegalSupportFixtures,
} = require("./helpers/paralegalSupportFixtures");
const {
  buildParalegalEvidencePlan,
  evidenceToolNamesForParalegalPlan,
} = require("../ai/paralegalConversationPolicy");
const {
  executeParalegalSupportTool,
} = require("../ai/paralegalSupportAgentTools");
const {
  runParalegalResponsePipeline,
} = require("../ai/paralegalResponsePipeline");

function toolArgs(name, { messageText = "", matter = "", destination = "" } = {}) {
  if (name === "get_paralegal_case_overview") return { status_scope: "all" };
  if ([
    "get_paralegal_case_workspace",
    "get_paralegal_case_financials",
    "get_paralegal_workflow_readiness",
    "get_paralegal_messaging_state",
  ].includes(name)) {
    return { case_reference: matter };
  }
  if (name === "find_paralegal_navigation_destination") {
    return { destination: destination || "cases" };
  }
  if (name === "search_lpc_knowledge") return { query: messageText };
  return {};
}

async function executePlannedTurn({
  user,
  messageText,
  matter = "",
  destination = "",
  conversationHistory = [],
  conversationState = {},
  generate,
}) {
  const evidencePlan = buildParalegalEvidencePlan({
    messageText,
    conversationHistory,
    conversationState,
  });
  const toolOutputs = [];
  for (const name of evidenceToolNamesForParalegalPlan(evidencePlan)) {
    const result = await executeParalegalSupportTool({
      name,
      args: toolArgs(name, { messageText, matter, destination }),
      context: { user, conversationHistory, conversationState },
    });
    toolOutputs.push({ name, result });
  }
  const response = await runParalegalResponsePipeline({
    generate,
    messageText,
    evidencePlan,
    toolOutputs,
  });
  return { evidencePlan, toolOutputs, response };
}

describe("paralegal assistant Package 6 database-backed integration", () => {
  let fixture;

  beforeAll(async () => {
    await connect();
  });

  beforeEach(async () => {
    await clearDatabase();
    mockStripe.accounts.retrieve.mockReset();
    mockStripe.accounts.retrieve.mockImplementation(async (accountId) => {
      if (accountId === "acct_p6_paralegal_failure") {
        throw new Error("synthetic processor timeout");
      }
      return {
        id: accountId,
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        external_accounts: {
          data: [{
            object: "bank_account",
            bank_name: "P6 Synthetic Bank",
            last4: "6789",
          }],
        },
      };
    });
    fixture = await seedParalegalSupportFixtures();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("uses synthetic-only fixtures and covers all required lifecycle states", async () => {
    expect(assertSyntheticFixtureData(fixture)).toBe(true);
    expect(Object.values(fixture.users).every((user) => user.email.endsWith(`@${SYNTHETIC_DOMAIN}`))).toBe(true);

    const overview = await executeParalegalSupportTool({
      name: "get_paralegal_case_overview",
      args: { status_scope: "all" },
      context: { user: fixture.users.owner },
    });
    expect(overview).toEqual(expect.objectContaining({
      ok: true,
      available: true,
      totalCount: 5,
      activeCount: 3,
      completedCount: 2,
    }));
    expect(overview.items.map((item) => item.title)).toEqual(expect.arrayContaining([
      fixture.cases.assigned.title,
      fixture.cases.completed.title,
      fixture.cases.withdrawn.title,
      fixture.cases.disputed.title,
      fixture.cases.archived.title,
    ]));
  });

  test("reconciles applied, rejected, and invited records from real collections", async () => {
    const [applications, invitations] = await Promise.all([
      executeParalegalSupportTool({
        name: "get_paralegal_application_activity",
        args: {},
        context: { user: fixture.users.owner },
      }),
      executeParalegalSupportTool({
        name: "get_paralegal_invitation_activity",
        args: {},
        context: { user: fixture.users.owner },
      }),
    ]);
    expect(applications).toEqual(expect.objectContaining({
      totalCount: 3,
      counts: expect.objectContaining({ submitted: 1, rejected: 1, pending: 1 }),
    }));
    expect(applications.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: fixture.cases.applied.title, status: "submitted" }),
      expect.objectContaining({ title: fixture.cases.rejected.title, status: "rejected" }),
    ]));
    expect(invitations).toEqual(expect.objectContaining({
      totalCount: 1,
      pendingCount: 1,
      items: [expect.objectContaining({
        title: fixture.cases.invited.title,
        invitationStatus: "pending",
      })],
    }));
  });

  test("queries assigned workspace tasks, files, messages, and attorney state", async () => {
    const context = { user: fixture.users.owner };
    const [workspace, messaging] = await Promise.all([
      executeParalegalSupportTool({
        name: "get_paralegal_case_workspace",
        args: { case_reference: "Assigned Discovery Matter" },
        context,
      }),
      executeParalegalSupportTool({
        name: "get_paralegal_messaging_state",
        args: { case_reference: "Assigned Discovery Matter" },
        context,
      }),
    ]);
    expect(workspace).toEqual(expect.objectContaining({
      available: true,
      title: fixture.cases.assigned.title,
      status: "in progress",
      deadline: "2026-08-15T21:00:00.000Z",
      attorneyName: "P6 Synthetic Attorney",
      relationship: "assigned",
      scopeTasks: expect.arrayContaining([
        expect.objectContaining({ title: "Draft chronology", completed: false }),
      ]),
      standaloneTasks: [expect.objectContaining({ title: "Prepare witness index", status: "in progress" })],
      files: [expect.objectContaining({
        name: "Synthetic chronology.pdf",
        status: "attorney_revision",
      })],
    }));
    expect(messaging).toEqual(expect.objectContaining({
      available: true,
      canSend: true,
      totalMessages: 2,
      unreadCount: 1,
      awaitingMyReply: true,
      awaitingAttorneyReply: false,
    }));
  });

  test("limits withdrawn workspace evidence to records created before access revocation", async () => {
    const workspace = await executeParalegalSupportTool({
      name: "get_paralegal_case_workspace",
      args: { case_reference: "Withdrawn Matter" },
      context: { user: fixture.users.owner },
    });
    expect(workspace).toEqual(expect.objectContaining({
      available: true,
      relationship: "withdrawn",
      readOnly: true,
      withdrawal: expect.objectContaining({
        pausedReason: "paralegal_withdrew",
        payoutFinalizedType: "partial_paralegal",
      }),
    }));
    expect(workspace.standaloneTasks.map((task) => task.title)).toEqual(["Pre-withdrawal task"]);
    expect(workspace.files.map((file) => file.name)).toEqual(["Synthetic pre-withdrawal file.pdf"]);
  });

  test("uses processor mocks and keeps gross, fee, net, release, and bank receipt distinct", async () => {
    const context = { user: fixture.users.owner };
    const [setup, history, financials, workflow] = await Promise.all([
      executeParalegalSupportTool({ name: "get_paralegal_payout_setup", args: {}, context }),
      executeParalegalSupportTool({ name: "get_paralegal_payout_history", args: {}, context }),
      executeParalegalSupportTool({
        name: "get_paralegal_case_financials",
        args: { case_reference: "Completed Payout Matter" },
        context,
      }),
      executeParalegalSupportTool({
        name: "get_paralegal_workflow_readiness",
        args: { case_reference: "Completed Payout Matter" },
        context,
      }),
    ]);
    expect(setup).toEqual(expect.objectContaining({
      source: "live",
      ready: true,
      bankName: "P6 Synthetic Bank",
      bankLast4: "6789",
    }));
    expect(history).toEqual(expect.objectContaining({
      payoutCount: 1,
      totalPaidCents: 82000,
      currentRelease: expect.objectContaining({
        paymentReleased: true,
        paidOutAt: "2026-07-16T12:00:00.000Z",
      }),
    }));
    expect(financials).toEqual(expect.objectContaining({
      gross: { cents: 100000, formatted: "$1,000.00" },
      platformFee: { cents: 18000, formatted: "$180.00", percent: 18 },
      net: { cents: 82000, formatted: "$820.00" },
      finalized: true,
      paymentReleased: true,
    }));
    expect(workflow.bankDepositEstimateBusinessDays).toEqual({ minimum: 3, maximum: 5 });
    expect(workflow.evaluations.payout.facts.bankReceiptConfirmed).toBe(false);
  });

  test("prevents inaccessible matters and amounts from crossing paralegal ownership boundaries", async () => {
    const context = { user: fixture.users.owner };
    const [workspace, financials, messaging] = await Promise.all([
      executeParalegalSupportTool({
        name: "get_paralegal_case_workspace",
        args: { case_reference: fixture.cases.inaccessible.title },
        context,
      }),
      executeParalegalSupportTool({
        name: "get_paralegal_case_financials",
        args: { case_reference: String(fixture.caseIds.inaccessible) },
        context,
      }),
      executeParalegalSupportTool({
        name: "get_paralegal_messaging_state",
        args: { case_reference: fixture.cases.inaccessible.title },
        context,
      }),
    ]);
    expect(workspace).toEqual(expect.objectContaining({ available: false, authorized: false }));
    expect(financials).toEqual(expect.objectContaining({ available: false, authorized: false }));
    expect(messaging).toEqual(expect.objectContaining({ available: false, authorized: false }));
    expect(JSON.stringify({ workspace, financials, messaging })).not.toContain("999999");
  });

  test("runs planning, authorized tools, generation, validation correction, and UI filtering together", async () => {
    const generated = [
      {
        reply: "The payout is $999.00. Read the raw evidence here: dashboard-paralegal.html#cases-completed",
        navigation: {
          ctaLabel: "Completed cases",
          ctaHref: "dashboard-paralegal.html#cases-completed",
        },
        suggestions: ["Open billing", "Open payouts"],
      },
      {
        reply: "Completed Payout Matter is completed, and your finalized net payout is $820.00.",
        navigation: {
          ctaLabel: "Completed cases",
          ctaHref: "dashboard-paralegal.html#cases-completed",
        },
        suggestions: ["Open payouts"],
      },
    ];
    const result = await executePlannedTurn({
      user: fixture.users.owner,
      messageText: "How much was I paid for the Completed Payout Matter?",
      matter: "Completed Payout Matter",
      destination: "completed_cases",
      generate: jest.fn(async () => generated.shift()),
    });

    expect(result.evidencePlan.requirements.map((entry) => entry.key)).toEqual([
      "matter_financials",
      "workspace",
    ]);
    expect(result.toolOutputs.map((entry) => entry.name)).toEqual([
      "get_paralegal_case_financials",
      "get_paralegal_case_workspace",
    ]);
    expect(result.response).toEqual(expect.objectContaining({
      reply: "Completed Payout Matter is completed, and your finalized net payout is $820.00.",
      provider: "openai_manager_paralegal",
      grounded: true,
      navigation: null,
      suggestions: [],
      validation: expect.objectContaining({
        correctionAttempts: 1,
        exhausted: false,
        retryOutcome: "corrected",
      }),
    }));
  });

  test("replaces repeated invalid generations with a concise evidence-derived fallback", async () => {
    const generate = jest.fn(async () => ({
      reply: "Verified information: you were paid $9,999.99 and it hit your bank.",
      suggestions: ["Open billing", "Contact support"],
      navigation: {
        ctaLabel: "Admin finance",
        ctaHref: "admin-dashboard.html#finance",
      },
    }));
    const result = await executePlannedTurn({
      user: fixture.users.owner,
      messageText: "How much was I paid for the Completed Payout Matter?",
      matter: "Completed Payout Matter",
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.response).toEqual(expect.objectContaining({
      provider: "openai_manager_paralegal_safe_fallback",
      grounded: true,
      navigation: null,
      suggestions: [],
      validation: expect.objectContaining({
        exhausted: true,
        retryOutcome: "safe_fallback",
      }),
    }));
    expect(result.response.reply).not.toMatch(/verified information|9,999|hit your bank/i);
    expect(result.response.reply).toMatch(/\$820\.00/);
  });
});
