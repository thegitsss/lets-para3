const CtoAgentRun = require("../models/CtoAgentRun");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { runCtoDiagnosis } = require("../services/ai/ctoAgentService");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  delete process.env.OPENAI_API_KEY;
  await clearDatabase();
});

describe("CTO agent service", () => {
  test("buttonLabel Save Profile maps to profile_save and keeps persistence status explicit", async () => {
    const result = await runCtoDiagnosis({
      category: "unknown",
      urgency: "high",
      originalMessage: "It won't let me save my profile after I update my information.",
      internalSummary: "Attorney reports profile save failure from the profile page.",
      userEmail: "test@example.com",
      metadata: {
        page: "/profile-attorney.html",
        buttonLabel: "Save Profile",
        role: "attorney",
      },
      saveRun: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        category: "profile_save",
        urgency: "high",
        technicalSeverity: expect.stringMatching(/high|medium/),
        diagnosisSummary: expect.stringMatching(/profile save/i),
        likelyRootCauses: expect.arrayContaining([expect.stringMatching(/validation|session|save/i)]),
        filesToInspect: expect.arrayContaining([
          "frontend/profile-attorney.html",
          "frontend/assets/scripts/profile-attorney.js",
          "backend/routes/users.js",
        ]),
        backendAreasToCheck: expect.arrayContaining([expect.stringMatching(/validation|persistence/i)]),
        frontendAreasToCheck: expect.arrayContaining([expect.stringMatching(/submit|validation/i)]),
        recommendedFixStrategy: expect.stringMatching(/reproduce|save flow/i),
        codexPatchPrompt: expect.stringMatching(/Investigate and patch a narrow LPC production issue/i),
        readyToApply: true,
        testPlan: expect.arrayContaining([expect.stringMatching(/profile/i)]),
        deploymentRisk: expect.stringMatching(/approval/i),
        approvalRequired: true,
        canAutoDeploy: false,
        notifyUserWhenResolved: true,
        runId: null,
        saved: false,
        saveSkippedReason: "saveRun was false",
      })
    );
  });

  test("buttonLabel Confirm Hire beats generic dashboard wording and maps to hire_flow", async () => {
    const result = await runCtoDiagnosis({
      category: "unknown",
      urgency: "medium",
      originalMessage: "This button isn't working.",
      internalSummary: "User reports a non-working button in the dashboard.",
      userEmail: "test@example.com",
      metadata: {
        page: "/dashboard-attorney.html",
        buttonLabel: "Confirm Hire",
        role: "attorney",
      },
      saveRun: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        category: "hire_flow",
        diagnosisSummary: expect.stringMatching(/hire-flow action failure|hire flow/i),
        likelyRootCauses: expect.arrayContaining([
          expect.stringMatching(/click handler|modal binding|funding guard|frontend exception/i),
        ]),
        filesToInspect: expect.arrayContaining([
          "frontend/assets/scripts/attorney-tabs.js",
          "frontend/assets/scripts/views/case-detail.js",
          "backend/routes/cases.js",
        ]),
        readyToApply: true,
        backendAreasToCheck: expect.arrayContaining([expect.stringMatching(/hire route|funding/i)]),
        frontendAreasToCheck: expect.arrayContaining([expect.stringMatching(/modal|click handler/i)]),
      })
    );
    expect(result.category).not.toBe("dashboard_load");
  });

  test("generic dashboard blank still maps to dashboard_load", async () => {
    const result = await runCtoDiagnosis({
      category: "unknown",
      urgency: "medium",
      originalMessage: "My dashboard is blank and stuck loading.",
      internalSummary: "Attorney reports a blank dashboard after login.",
      userEmail: "test@example.com",
      metadata: {
        page: "/dashboard-attorney.html",
        role: "attorney",
      },
      saveRun: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        category: "dashboard_load",
        diagnosisSummary: expect.stringMatching(/dashboard load/i),
        filesToInspect: expect.arrayContaining([
          "frontend/dashboard-attorney.html",
          "frontend/assets/scripts/attorney-dashboard.js",
          "backend/routes/attorneyDashboard.js",
        ]),
        readyToApply: true,
      })
    );
  });

  test("persistence failure returns explicit saved and saveSkippedReason fields", async () => {
    const createSpy = jest.spyOn(CtoAgentRun, "create").mockRejectedValueOnce(new Error("Mongo write failed"));

    const result = await runCtoDiagnosis({
      category: "unknown",
      urgency: "medium",
      originalMessage: "This button isn't working.",
      internalSummary: "User reports a non-working button in the dashboard.",
      userEmail: "test@example.com",
      metadata: {
        page: "/dashboard-attorney.html",
        buttonLabel: "Confirm Hire",
        role: "attorney",
      },
      saveRun: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        saved: false,
        saveSkippedReason: expect.stringMatching(/Mongo write failed/i),
        runId: null,
        readyToApply: true,
      })
    );
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/Run persistence was requested but skipped/i)])
    );

    createSpy.mockRestore();
  });
});
