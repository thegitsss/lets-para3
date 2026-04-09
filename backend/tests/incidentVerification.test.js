const fs = require("fs");
const os = require("os");
const path = require("path");

const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentArtifact = require("../models/IncidentArtifact");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentInvestigation = require("../models/IncidentInvestigation");
const IncidentPatch = require("../models/IncidentPatch");
const IncidentVerification = require("../models/IncidentVerification");
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
    lastName: "Verify",
    email: `${role}.${emailCounter}@incident-verification.test`,
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

async function createAwaitingVerificationIncident(user, overrides = {}) {
  const incident = await createClassifiedIncident(user, overrides);

  await runIncidentRunnerOnce({
    maxJobs: 1,
    workerId: "jest:incident-runner",
    jobTypes: ["investigation"],
  });

  await runIncidentRunnerOnce({
    maxJobs: 2,
    workerId: "jest:incident-runner",
    jobTypes: ["patch_planning", "patch_execution"],
  });

  return Incident.findById(incident._id);
}

async function seedUnsupportedAwaitingVerificationIncident(user, options = {}) {
  const incident = await createClassifiedIncident(user, {
    summary: options.summary || "Documents filter still shows stale results",
    description:
      options.description ||
      "The documents filter still shows stale results after refresh and needs a targeted patch.",
    pageUrl: options.pageUrl || "https://www.lets-paraconnect.com/documents.html",
    routePath: options.routePath || "/documents.html",
    featureKey: options.featureKey || "documents-filter",
  });

  const investigation = await IncidentInvestigation.create({
    incidentId: incident._id,
    attemptNumber: 1,
    status: "completed",
    triggerType: "auto",
    assignedAgent: "engineering_agent",
    rootCauseSummary: options.rootCauseSummary || "Investigation identified a likely frontend document filter issue.",
    rootCauseConfidence: options.rootCauseConfidence || "medium",
    reproductionStatus: "partially_reproduced",
    hypotheses: [
      {
        key: "unsupported-verification",
        statement: "Manual seeded hypothesis for unsupported verification coverage.",
        confidence: options.rootCauseConfidence || "medium",
        selected: true,
        status: "pending",
      },
    ],
    impactedDomains: options.impactedDomains || ["documents"],
    suspectedRoutes: options.suspectedRoutes || ["/documents"],
    suspectedFiles: options.suspectedFiles || ["frontend/assets/scripts/views/documents.js"],
    recommendedAction: "patch",
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "incident-verification-unsupported-"));
  const patch = await IncidentPatch.create({
    incidentId: incident._id,
    investigationId: investigation._id,
    attemptNumber: 1,
    status: "ready_for_verification",
    patchStrategy: "frontend_only",
    baseCommitSha: "a".repeat(40),
    gitBranch: `incident/${incident.publicId.toLowerCase()}-unsupported`,
    worktreePath,
    headCommitSha: "b".repeat(40),
    patchSummary: "Unsupported patch candidate awaiting safe verification coverage.",
    filesTouched: options.suspectedFiles || ["frontend/assets/scripts/views/documents.js"],
    testsAdded: [],
    testsModified: [],
    requiresApproval: false,
    highRiskTouched: false,
    startedAt: new Date(),
    completedAt: new Date(),
  });

  incident.state = "awaiting_verification";
  incident.currentInvestigationId = investigation._id;
  incident.currentPatchId = patch._id;
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  incident.classification.domain = options.domain || "documents";
  incident.classification.riskLevel = options.riskLevel || "low";
  incident.classification.severity = options.severity || "medium";
  incident.classification.confidence = options.confidence || "medium";
  incident.classification.suspectedRoutes = options.suspectedRoutes || ["/documents"];
  incident.classification.suspectedFiles = options.suspectedFiles || ["frontend/assets/scripts/views/documents.js"];
  incident.autonomyMode = "full_auto";
  incident.approvalState = "not_needed";
  incident.orchestration.nextJobType = "verification";
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

describe("Incident verification runner", () => {
  test("passing verification advances an isolated patch candidate to verified_release_candidate", async () => {
    const attorney = await createUser("attorney");
    const awaitingVerification = await createAwaitingVerificationIncident(attorney);
    expect(awaitingVerification.state).toBe("awaiting_verification");

    const run = await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:verification-runner",
      jobTypes: ["verification"],
    });
    expect(run.ok).toBe(true);
    expect(run.processed).toBe(1);

    const incident = await Incident.findById(awaitingVerification._id).lean();
    const verification = await IncidentVerification.findOne({ incidentId: awaitingVerification._id }).lean();
    const events = await IncidentEvent.find({ incidentId: awaitingVerification._id }).sort({ seq: 1 }).lean();
    const artifacts = await IncidentArtifact.find({
      incidentId: awaitingVerification._id,
      stage: "verification",
    }).lean();

    expect(incident.state).toBe("verified_release_candidate");
    expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(incident.orchestration.nextJobType).toBe("deployment");
    expect(String(incident.currentVerificationId)).toBe(String(verification._id));

    expect(verification.status).toBe("passed");
    expect(verification.verificationLevel).toBe("release_candidate");
    expect(verification.verifierAgent).toBe("verifier_agent");
    expect(verification.failedCheckKeys).toEqual([]);
    expect(verification.summary).toMatch(/verification passed/i);
    expect(verification.requiredChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "build", status: "passed", required: true }),
        expect.objectContaining({ key: "ui_flow", status: "passed", required: true }),
      ])
    );

    const buildCheck = verification.requiredChecks.find((check) => check.key === "build");
    const uiFlowCheck = verification.requiredChecks.find((check) => check.key === "ui_flow");
    expect(buildCheck.artifactId).toBeTruthy();
    expect(uiFlowCheck.artifactId).toBeTruthy();

    expect(artifacts.map((artifact) => artifact.artifactType)).toEqual(
      expect.arrayContaining(["test_output", "coverage_summary"])
    );
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["verification_started", "verification_passed"])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromState: "awaiting_verification",
          toState: "verified_release_candidate",
        }),
      ])
    );
  });

  test("preferences save recipe passes verification for the protected settings file", async () => {
    const paralegal = await createUser("paralegal");
    const awaitingVerification = await createAwaitingVerificationIncident(paralegal, {
      summary: "Save preferences button does nothing on settings",
      description: "The save preferences button does nothing and the change is not preserved.",
      pageUrl: "https://www.lets-paraconnect.com/settings",
      routePath: "/settings",
      featureKey: "save-preferences",
    });

    const run = await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:verification-runner",
      jobTypes: ["verification"],
    });
    expect(run.ok).toBe(true);
    expect(run.processed).toBe(1);

    const incident = await Incident.findById(awaitingVerification._id).lean();
    const verification = await IncidentVerification.findOne({ incidentId: awaitingVerification._id }).lean();

    expect(incident.state).toBe("verified_release_candidate");
    expect(incident.orchestration.nextJobType).toBe("deployment");
    expect(verification.status).toBe("passed");
    expect(verification.summary).toMatch(/preferences save patch candidate/i);
    expect(verification.requiredChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "build", status: "passed", required: true }),
        expect.objectContaining({ key: "ui_flow", status: "passed", required: true }),
      ])
    );
  });

  test("failing verification routes the incident to verification_failed", async () => {
    const attorney = await createUser("attorney");
    const awaitingVerification = await createAwaitingVerificationIncident(attorney);
    const patch = await IncidentPatch.findOne({ incidentId: awaitingVerification._id });
    const targetFile = path.join(patch.worktreePath, "frontend/assets/scripts/utils/notifications.js");
    const source = fs.readFileSync(targetFile, "utf8");
    fs.writeFileSync(targetFile, `${source}\nfunction brokenVerification(\n`, "utf8");

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:verification-runner",
      jobTypes: ["verification"],
    });

    const incident = await Incident.findById(awaitingVerification._id).lean();
    const verification = await IncidentVerification.findOne({ incidentId: awaitingVerification._id }).lean();
    const events = await IncidentEvent.find({ incidentId: awaitingVerification._id }).sort({ seq: 1 }).lean();

    expect(incident.state).toBe("verification_failed");
    expect(incident.adminVisibleStatus).toBe("verification_failed");
    expect(incident.userVisibleStatus).toBe("investigating");
    expect(incident.orchestration.nextJobType).toBe("none");

    expect(verification.status).toBe("failed");
    expect(verification.failedCheckKeys).toEqual(expect.arrayContaining(["build", "ui_flow"]));
    expect(verification.requiredChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "build", status: "failed" }),
        expect.objectContaining({ key: "ui_flow", status: "failed" }),
      ])
    );
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["verification_started", "verification_failed"])
    );
  });

  test("insufficient verification coverage routes the incident to needs_human_owner", async () => {
    const attorney = await createUser("attorney");
    const awaitingVerification = await seedUnsupportedAwaitingVerificationIncident(attorney);

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:verification-runner",
      jobTypes: ["verification"],
    });

    const incident = await Incident.findById(awaitingVerification._id).lean();
    const verification = await IncidentVerification.findOne({ incidentId: awaitingVerification._id }).lean();

    expect(incident.state).toBe("needs_human_owner");
    expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(incident.orchestration.nextJobType).toBe("none");

    expect(verification.status).toBe("blocked");
    expect(verification.summary).toMatch(/coverage is unavailable/i);
    expect(verification.failedCheckKeys).toEqual(expect.arrayContaining(["build", "ui_flow"]));
    expect(verification.requiredChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "build", status: "failed", attempts: 0 }),
        expect.objectContaining({ key: "ui_flow", status: "failed", attempts: 0 }),
      ])
    );
  });

  test("verification persists artifacts and check matrix evidence", async () => {
    const attorney = await createUser("attorney");
    const awaitingVerification = await createAwaitingVerificationIncident(attorney);

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:verification-runner",
      jobTypes: ["verification"],
    });

    const verification = await IncidentVerification.findOne({ incidentId: awaitingVerification._id }).lean();
    const artifacts = await IncidentArtifact.find({
      incidentId: awaitingVerification._id,
      verificationId: verification._id,
    }).lean();
    const coverageArtifact = artifacts.find((artifact) => artifact.artifactType === "coverage_summary");

    expect(artifacts.length).toBeGreaterThanOrEqual(3);
    expect(coverageArtifact).toBeTruthy();
    expect(coverageArtifact.body).toEqual(
      expect.objectContaining({
        status: "passed",
        failedCheckKeys: [],
      })
    );
    expect(coverageArtifact.body.requiredChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "build", status: "passed" }),
        expect.objectContaining({ key: "ui_flow", status: "passed" }),
      ])
    );
  });

  test("verification claims honor the existing lock semantics", async () => {
    const attorney = await createUser("attorney");
    const awaitingVerification = await createAwaitingVerificationIncident(attorney);

    const firstClaim = await claimNextIncidentJob({
      jobTypes: ["verification"],
      workerId: "jest:verification-lock-1",
    });
    const secondClaim = await claimNextIncidentJob({
      jobTypes: ["verification"],
      workerId: "jest:verification-lock-2",
    });

    expect(firstClaim).toEqual(
      expect.objectContaining({
        incidentId: String(awaitingVerification._id),
        jobType: "verification",
      })
    );
    expect(secondClaim).toBeNull();

    const processed = await processClaimedIncidentJob(firstClaim);
    expect(processed.ok).toBe(true);
    expect(processed.state).toBe("verified_release_candidate");

    const updatedIncident = await Incident.findById(awaitingVerification._id).lean();
    expect(updatedIncident.orchestration.nextJobType).toBe("deployment");
  });
});
