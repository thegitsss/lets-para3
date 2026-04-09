const fs = require("fs");

const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentInvestigation = require("../models/IncidentInvestigation");
const IncidentPatch = require("../models/IncidentPatch");
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
    lastName: "Patch",
    email: `${role}.${emailCounter}@incident-patch.test`,
    password: "Password123!",
    role,
    status: "approved",
    state: "CA",
  });
}

async function createHelpIncident(user, overrides = {}) {
  const payload = {
    summary: "Notification dropdown loses styling after refresh",
    description:
      "On the attorney dashboard the notification panel loses spacing and fade animation after refresh.",
    pageUrl: "https://www.lets-paraconnect.com/dashboard-attorney.html",
    routePath: "/dashboard-attorney.html",
    featureKey: "notification-dropdown",
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

async function createPatchPlanningIncident(user, overrides = {}) {
  const incident = await createClassifiedIncident(user, overrides);
  await runIncidentRunnerOnce({
    maxJobs: 1,
    workerId: "jest:incident-runner",
    jobTypes: ["investigation"],
  });
  return Incident.findById(incident._id);
}

async function seedManualPatchPlanningIncident(user, options = {}) {
  const incident = await createClassifiedIncident(user, {
    summary: options.summary || "General settings issue",
    description:
      options.description ||
      "A settings-related issue was reported and the investigation recommends a code patch.",
    pageUrl: options.pageUrl || "",
    routePath: options.routePath || "",
    featureKey: options.featureKey || "",
  });

  const investigation = await IncidentInvestigation.create({
    incidentId: incident._id,
    attemptNumber: 1,
    status: "completed",
    triggerType: "auto",
    assignedAgent: "engineering_agent",
    rootCauseSummary: options.rootCauseSummary || "Investigation identified a likely code-path issue.",
    rootCauseConfidence: options.rootCauseConfidence || "medium",
    reproductionStatus: "not_reproduced",
    hypotheses: [
      {
        key: "manual-seed",
        statement: "Manual seeded hypothesis for patch-stage testing.",
        confidence: options.rootCauseConfidence || "medium",
        selected: true,
        status: "pending",
      },
    ],
    impactedDomains: options.impactedDomains || [incident.classification.domain || "ui"],
    suspectedRoutes: options.suspectedRoutes || [],
    suspectedFiles: options.suspectedFiles || [],
    recommendedAction: "patch",
    startedAt: new Date(),
    completedAt: new Date(),
  });

  incident.state = "patch_planning";
  incident.currentInvestigationId = investigation._id;
  incident.userVisibleStatus = "investigating";
  incident.adminVisibleStatus = "active";
  incident.classification.riskLevel = options.riskLevel || "low";
  incident.classification.severity = options.severity || "medium";
  incident.classification.confidence = options.confidence || "medium";
  incident.autonomyMode = "full_auto";
  incident.approvalState = "not_needed";
  incident.orchestration.nextJobType = "patch_planning";
  incident.orchestration.nextJobRunAt = new Date();
  await incident.save();

  return Incident.findById(incident._id);
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

describe("Incident patch runner", () => {
  test("actionable patch planning and execution create a real isolated patch record", async () => {
    const attorney = await createUser("attorney");
    const patchPlanningIncident = await createPatchPlanningIncident(attorney);
    expect(patchPlanningIncident.state).toBe("patch_planning");

    const run = await runIncidentRunnerOnce({
      maxJobs: 2,
      workerId: "jest:incident-runner",
      jobTypes: ["patch_planning", "patch_execution"],
    });
    expect(run.ok).toBe(true);
    expect(run.processed).toBe(2);

    const incident = await Incident.findById(patchPlanningIncident._id).lean();
    const patch = await IncidentPatch.findOne({ incidentId: patchPlanningIncident._id }).lean();
    const events = await IncidentEvent.find({ incidentId: patchPlanningIncident._id }).sort({ seq: 1 }).lean();

    expect(incident.state).toBe("awaiting_verification");
    expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(incident.orchestration.nextJobType).toBe("verification");
    expect(String(incident.currentPatchId)).toBe(String(patch._id));

    expect(patch.status).toBe("ready_for_verification");
    expect(patch.patchStrategy).toBe("frontend_only");
    expect(patch.baseCommitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(patch.gitBranch).toMatch(/^incident\//);
    expect(patch.worktreePath).toContain("lpc-incident-worktrees");
    expect(fs.existsSync(patch.worktreePath)).toBe(true);
    expect(patch.headCommitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(patch.patchSummary).toMatch(/notification style injection/i);
    expect(patch.filesTouched).toEqual(["frontend/assets/scripts/utils/notifications.js"]);
    expect(patch.testsAdded).toEqual([]);
    expect(patch.testsModified).toEqual([]);
    expect(patch.requiresApproval).toBe(false);

    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["patch_planned", "patch_created"])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromState: "patch_planning", toState: "patching" }),
        expect.objectContaining({ fromState: "patching", toState: "awaiting_verification" }),
      ])
    );
  });

  test("patch execution reclassifies risk upward and stops when protected paths are selected", async () => {
    const attorney = await createUser("attorney");
    const incident = await seedManualPatchPlanningIncident(attorney, {
      summary: "Settings patch candidate",
      description: "A settings issue needs a targeted patch.",
      featureKey: "profile-visibility-toggle",
      suspectedFiles: ["frontend/assets/scripts/profile-settings.js"],
      suspectedRoutes: ["/settings"],
      impactedDomains: ["profile"],
      riskLevel: "low",
      severity: "medium",
      confidence: "medium",
    });

    await runIncidentRunnerOnce({
      maxJobs: 2,
      workerId: "jest:incident-runner",
      jobTypes: ["patch_planning", "patch_execution"],
    });

    const updatedIncident = await Incident.findById(incident._id).lean();
    const patch = await IncidentPatch.findOne({ incidentId: incident._id }).lean();
    const events = await IncidentEvent.find({ incidentId: incident._id }).sort({ seq: 1 }).lean();

    expect(updatedIncident.state).toBe("needs_human_owner");
    expect(updatedIncident.classification.riskLevel).toBe("high");
    expect(updatedIncident.autonomyMode).toBe("approval_required");
    expect(updatedIncident.approvalState).toBe("pending");
    expect(patch.status).toBe("failed");
    expect(patch.highRiskTouched).toBe(true);
    expect(patch.requiresApproval).toBe(true);
    expect(patch.blockedReason).toMatch(/protected files/i);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["risk_reclassified", "patch_failed"])
    );
  });

  test("trusted preferences-save recipe can patch the protected settings file autonomously", async () => {
    const attorney = await createUser("attorney");
    const incident = await seedManualPatchPlanningIncident(attorney, {
      summary: "Save preferences button does nothing on settings",
      description: "The save preferences button does nothing and the change is not preserved.",
      featureKey: "save-preferences",
      suspectedFiles: ["frontend/assets/scripts/profile-settings.js"],
      suspectedRoutes: ["/settings"],
      impactedDomains: ["profile"],
      riskLevel: "low",
      severity: "medium",
      confidence: "medium",
    });

    await runIncidentRunnerOnce({
      maxJobs: 2,
      workerId: "jest:incident-runner",
      jobTypes: ["patch_planning", "patch_execution"],
    });

    const updatedIncident = await Incident.findById(incident._id).lean();
    const patch = await IncidentPatch.findOne({ incidentId: incident._id }).lean();

    expect(updatedIncident.state).toBe("awaiting_verification");
    expect(updatedIncident.classification.riskLevel).toBe("low");
    expect(updatedIncident.autonomyMode).toBe("full_auto");
    expect(updatedIncident.approvalState).toBe("not_needed");
    expect(patch.status).toBe("ready_for_verification");
    expect(patch.requiresApproval).toBe(false);
    expect(patch.highRiskTouched).toBe(false);
    expect(patch.filesTouched).toEqual(["frontend/assets/scripts/profile-settings.js"]);
    expect(patch.patchSummary).toMatch(/preferences save/i);
  });

  test("patch execution without a safe recipe stops at needs_human_owner", async () => {
    const attorney = await createUser("attorney");
    const incident = await seedManualPatchPlanningIncident(attorney, {
      summary: "Document search filter issue",
      description: "The documents filter feels wrong and needs a code patch.",
      featureKey: "document-filter",
      suspectedFiles: ["frontend/assets/scripts/views/documents.js"],
      suspectedRoutes: ["/documents"],
      impactedDomains: ["documents"],
      riskLevel: "low",
      severity: "medium",
      confidence: "medium",
    });

    await runIncidentRunnerOnce({
      maxJobs: 2,
      workerId: "jest:incident-runner",
      jobTypes: ["patch_planning", "patch_execution"],
    });

    const updatedIncident = await Incident.findById(incident._id).lean();
    const patch = await IncidentPatch.findOne({ incidentId: incident._id }).lean();

    expect(updatedIncident.state).toBe("needs_human_owner");
    expect(updatedIncident.classification.riskLevel).toBe("low");
    expect(patch.status).toBe("failed");
    expect(patch.blockedReason).toMatch(/no safe automated patch recipe/i);
  });

  test("patch stage claims honor the existing lock semantics", async () => {
    const attorney = await createUser("attorney");
    const incident = await createPatchPlanningIncident(attorney);

    const firstClaim = await claimNextIncidentJob({
      jobTypes: ["patch_planning", "patch_execution"],
      workerId: "jest:patch-lock-1",
    });
    const secondClaim = await claimNextIncidentJob({
      jobTypes: ["patch_planning", "patch_execution"],
      workerId: "jest:patch-lock-2",
    });

    expect(firstClaim).toEqual(
      expect.objectContaining({
        jobType: "patch_planning",
      })
    );
    expect(secondClaim).toBeNull();

    const processed = await processClaimedIncidentJob(firstClaim);
    expect(processed.ok).toBe(true);
    expect(processed.state).toBe("patching");

    const updatedIncident = await Incident.findById(incident._id).lean();
    expect(updatedIncident.orchestration.nextJobType).toBe("patch_execution");
  });
});
