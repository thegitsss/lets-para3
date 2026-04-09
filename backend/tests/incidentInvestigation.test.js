const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentArtifact = require("../models/IncidentArtifact");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentInvestigation = require("../models/IncidentInvestigation");
const { createIncidentFromHelpReport } = require("../services/incidents/intakeService");
const {
  claimNextIncidentJob,
  processClaimedIncidentJob,
  runIncidentSchedulerOnce,
  stopIncidentScheduler,
} = require("../scheduler/incidentScheduler");
const { runIncidentRunnerOnce } = require("../scripts/incident-runner");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

let emailCounter = 0;

async function createUser(role) {
  emailCounter += 1;
  return User.create({
    firstName: role === "paralegal" ? "Parker" : "Alex",
    lastName: "Investigation",
    email: `${role}.${emailCounter}@incident-investigation.test`,
    password: "Password123!",
    role,
    status: "approved",
    state: "CA",
  });
}

async function createHelpIncident(user, overrides = {}) {
  const payload = {
    summary: "Hire button is not working on case detail",
    description: "I click Hire and nothing happens on the case detail page.",
    pageUrl: "https://www.lets-paraconnect.com/case-detail.html?id=123",
    routePath: "/case-detail.html",
    featureKey: "hire-button",
    diagnostics: {
      browserName: "Chrome",
      deviceType: "desktop",
    },
    ...overrides,
  };

  return createIncidentFromHelpReport({
    user: {
      id: user._id,
      _id: user._id,
      role: user.role,
      email: user.email,
    },
    input: payload,
  });
}

async function createClassifiedIncident(user, overrides = {}) {
  const created = await createHelpIncident(user, overrides);
  await runIncidentSchedulerOnce({ maxJobs: 2, workerId: "jest:incident-scheduler" });
  return Incident.findOne({ publicId: created.incident.publicId });
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  stopIncidentScheduler();
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Incident investigation runner", () => {
  test("actionable investigation advances to patch_planning with artifacts and events", async () => {
    const attorney = await createUser("attorney");
    const classified = await createClassifiedIncident(attorney);

    const run = await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:incident-runner",
      jobTypes: ["investigation"],
    });
    expect(run.ok).toBe(true);
    expect(run.processed).toBe(1);

    const incident = await Incident.findById(classified._id).lean();
    const investigation = await IncidentInvestigation.findOne({ incidentId: classified._id }).lean();
    const events = await IncidentEvent.find({ incidentId: classified._id }).sort({ seq: 1 }).lean();
    const artifacts = await IncidentArtifact.find({ incidentId: classified._id }).lean();

    expect(incident.state).toBe("patch_planning");
    expect(incident.orchestration.nextJobType).toBe("patch_planning");
    expect(String(incident.currentInvestigationId)).toBe(String(investigation._id));
    expect(incident.userVisibleStatus).toBe("investigating");
    expect(investigation.status).toBe("completed");
    expect(investigation.recommendedAction).toBe("patch");
    expect(investigation.rootCauseSummary).toMatch(/Likely cause|Working hypothesis/);
    expect(investigation.hypotheses.length).toBeGreaterThan(0);
    expect(investigation.suspectedRoutes).toEqual(
      expect.arrayContaining(["/api/applications", "/api/cases/:caseId"])
    );
    expect(investigation.suspectedFiles).toEqual(
      expect.arrayContaining([
        "backend/routes/applications.js",
        "frontend/assets/scripts/case-detail.js",
      ])
    );
    expect(artifacts.map((artifact) => artifact.artifactType).sort()).toEqual(
      expect.arrayContaining(["cluster_summary", "log_excerpt", "repro_steps", "route_map"])
    );
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["investigation_started", "investigation_completed"])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromState: "classified", toState: "investigating" }),
        expect.objectContaining({ fromState: "investigating", toState: "patch_planning" }),
      ])
    );
  });

  test("thin investigation context routes the incident to needs_more_context", async () => {
    const attorney = await createUser("attorney");
    const classified = await createClassifiedIncident(attorney, {
      summary: "Something feels off in the product flow",
      description: "The product feels wrong during use, but I cannot identify the exact screen, route, or action yet.",
      pageUrl: "",
      routePath: "",
      featureKey: "",
    });

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:incident-runner",
      jobTypes: ["investigation"],
    });

    const incident = await Incident.findById(classified._id).lean();
    const investigation = await IncidentInvestigation.findOne({ incidentId: classified._id }).lean();

    expect(incident.state).toBe("needs_more_context");
    expect(incident.userVisibleStatus).toBe("needs_more_info");
    expect(incident.orchestration.nextJobType).toBe("none");
    expect(investigation.status).toBe("needs_more_context");
    expect(investigation.recommendedAction).toBe("request_context");
  });

  test("non-actionable investigation closes with a no-repro outcome", async () => {
    const attorney = await createUser("attorney");
    const classified = await createClassifiedIncident(attorney, {
      summary: "Dashboard numbers look stale after refresh",
      description: "On the attorney dashboard the counters look stale after refresh and no visible error is shown.",
      pageUrl: "https://www.lets-paraconnect.com/dashboard-attorney.html",
      routePath: "/dashboard-attorney.html",
      featureKey: "overview-counters",
    });

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:incident-runner",
      jobTypes: ["investigation"],
    });

    const incident = await Incident.findById(classified._id).lean();
    const investigation = await IncidentInvestigation.findOne({ incidentId: classified._id }).lean();

    expect(incident.state).toBe("closed_no_repro");
    expect(incident.userVisibleStatus).toBe("closed");
    expect(incident.adminVisibleStatus).toBe("closed");
    expect(incident.resolution).toEqual(
      expect.objectContaining({
        code: "no_repro",
      })
    );
    expect(investigation.status).toBe("no_repro");
    expect(investigation.recommendedAction).toBe("close_not_actionable");
  });

  test("investigation can reclassify risk upward when protected files are implicated", async () => {
    const attorney = await createUser("attorney");
    const classified = await createClassifiedIncident(attorney, {
      summary: "Settings toggle behaves inconsistently",
      description: "On the settings screen a settings toggle flips back after refresh and the change is not preserved.",
      pageUrl: "https://www.lets-paraconnect.com/settings",
      routePath: "/settings",
      featureKey: "settings-toggle",
    });

    const before = await Incident.findById(classified._id).lean();
    expect(before.classification.riskLevel).not.toBe("high");

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:incident-runner",
      jobTypes: ["investigation"],
    });

    const incident = await Incident.findById(classified._id).lean();
    const investigation = await IncidentInvestigation.findOne({ incidentId: classified._id }).lean();
    const events = await IncidentEvent.find({ incidentId: classified._id }).sort({ seq: 1 }).lean();

    expect(incident.classification.riskLevel).toBe("high");
    expect(incident.autonomyMode).toBe("approval_required");
    expect(incident.approvalState).toBe("pending");
    expect(incident.state).toBe("patch_planning");
    expect(investigation.suspectedFiles).toEqual(
      expect.arrayContaining(["frontend/assets/scripts/profile-settings.js"])
    );
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["risk_reclassified"])
    );
  });

  test("trusted preferences-save incidents stay low risk so autonomous repair can continue", async () => {
    const attorney = await createUser("attorney");
    const classified = await createClassifiedIncident(attorney, {
      summary: "Save preferences button does nothing on settings",
      description: "On the settings screen the save preferences button does nothing and the profile preference change is not preserved.",
      pageUrl: "https://www.lets-paraconnect.com/settings",
      routePath: "/settings",
      featureKey: "save-preferences",
    });

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:incident-runner",
      jobTypes: ["investigation"],
    });

    const incident = await Incident.findById(classified._id).lean();
    const investigation = await IncidentInvestigation.findOne({ incidentId: classified._id }).lean();

    expect(incident.classification.riskLevel).toBe("low");
    expect(incident.autonomyMode).toBe("full_auto");
    expect(incident.approvalState).toBe("not_needed");
    expect(incident.state).toBe("patch_planning");
    expect(investigation.suspectedFiles).toEqual(
      expect.arrayContaining(["frontend/assets/scripts/profile-settings.js"])
    );
  });

  test("investigation claims honor the existing lock semantics", async () => {
    const attorney = await createUser("attorney");
    await createClassifiedIncident(attorney);

    const firstClaim = await claimNextIncidentJob({
      jobTypes: ["investigation"],
      workerId: "jest:runner-lock-1",
    });
    const secondClaim = await claimNextIncidentJob({
      jobTypes: ["investigation"],
      workerId: "jest:runner-lock-2",
    });

    expect(firstClaim).toEqual(
      expect.objectContaining({
        jobType: "investigation",
      })
    );
    expect(secondClaim).toBeNull();

    const processed = await processClaimedIncidentJob(firstClaim);
    expect(processed.ok).toBe(true);
    expect(processed.state).toBe("patch_planning");
  });
});
