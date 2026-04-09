const CtoExecutionRun = require("../models/CtoExecutionRun");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { buildExecutionPacket } = require("../services/ai/ctoExecutionService");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("CTO execution service", () => {
  test("creates an execution packet from a raw diagnosis payload", async () => {
    const result = await buildExecutionPacket({
      category: "hire_flow",
      urgency: "high",
      technicalSeverity: "high",
      diagnosisSummary: "Likely Confirm Hire action failure in attorney flow.",
      likelyRootCauses: [
        "Missing click handler",
        "Disabled state never clears",
        "Backend hire route blocked by guard",
      ],
      filesToInspect: [
        "frontend/assets/scripts/views/case-detail.js",
        "frontend/assets/scripts/attorney-tabs.js",
        "backend/routes/cases.js",
      ],
      recommendedFixStrategy: "Inspect Confirm Hire click handling and backend route response path.",
      testPlan: [
        "Open case detail as attorney",
        "Click Confirm Hire",
        "Verify request fires and UI updates",
      ],
      deploymentRisk: "Medium to high",
      issueId: "",
      saveRun: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        ctoRunId: "",
        executionRunId: null,
        category: "hire_flow",
        urgency: "high",
        technicalSeverity: "high",
        executionStatus: "awaiting_approval",
        implementationSummary: expect.stringMatching(/focused hire_flow fix|focused hire flow fix|Prepare a focused/i),
        executionPlan: expect.arrayContaining([expect.stringMatching(/Reproduce the reported issue/i)]),
        patchArtifact: expect.objectContaining({
          likelyFiles: expect.arrayContaining([
            "frontend/assets/scripts/views/case-detail.js",
            "frontend/assets/scripts/attorney-tabs.js",
            "backend/routes/cases.js",
          ]),
          likelyChangeTypes: expect.arrayContaining([expect.stringMatching(/event binding|modal flow wiring/i)]),
          prohibitedActions: expect.arrayContaining([expect.stringMatching(/unrelated refactors/i)]),
        }),
        codexExecutionPrompt: expect.stringMatching(/Implement a narrow LPC production fix/i),
        requiredTests: expect.arrayContaining([expect.stringMatching(/Confirm Hire|case detail/i)]),
        deploymentChecklist: expect.arrayContaining([expect.stringMatching(/manual reviewer approval/i)]),
        deploymentReadiness: expect.objectContaining({
          status: "not_ready",
          riskLevel: "medium",
          blockers: expect.arrayContaining([expect.stringMatching(/Implementation has not been completed/i)]),
        }),
        approvalRequired: true,
        canAutoDeploy: false,
        resolutionMessageDraft: expect.stringMatching(/We’re actively working on the issue/i),
        saved: false,
        saveSkippedReason: "saveRun was false",
      })
    );
  });

  test("persistence failure returns explicit saved and saveSkippedReason fields", async () => {
    const createSpy = jest.spyOn(CtoExecutionRun, "create").mockRejectedValueOnce(new Error("Execution write failed"));

    const result = await buildExecutionPacket({
      category: "profile_save",
      urgency: "medium",
      technicalSeverity: "medium",
      diagnosisSummary: "Likely profile save issue.",
      filesToInspect: ["frontend/assets/scripts/profile-attorney.js", "backend/routes/users.js"],
      recommendedFixStrategy: "Inspect profile save request and validation path.",
      testPlan: ["Save profile and reload page."],
      saveRun: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        saved: false,
        saveSkippedReason: expect.stringMatching(/Execution write failed/i),
        executionRunId: null,
      })
    );
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/Execution persistence was requested but skipped/i)])
    );

    createSpy.mockRestore();
  });

  test("deployment readiness becomes blocked when core diagnosis inputs are missing", async () => {
    const result = await buildExecutionPacket({
      category: "unknown",
      urgency: "medium",
      technicalSeverity: "medium",
      diagnosisSummary: "Sparse diagnosis.",
      saveRun: false,
    });

    expect(result.deploymentReadiness).toEqual(
      expect.objectContaining({
        status: "blocked",
        blockers: expect.arrayContaining([
          expect.stringMatching(/does not include mapped files/i),
          expect.stringMatching(/does not include targeted tests/i),
        ]),
      })
    );
  });
});
