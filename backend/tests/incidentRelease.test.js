const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentApproval = require("../models/IncidentApproval");
const IncidentArtifact = require("../models/IncidentArtifact");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentInvestigation = require("../models/IncidentInvestigation");
const IncidentPatch = require("../models/IncidentPatch");
const IncidentRelease = require("../models/IncidentRelease");
const IncidentVerification = require("../models/IncidentVerification");
const IncidentNotification = require("../models/IncidentNotification");
const Notification = require("../models/Notification");
const { createIncidentFromHelpReport } = require("../services/incidents/intakeService");
const { decideIncidentApproval } = require("../services/incidents/releaseService");
const {
  claimNextIncidentJob,
  processClaimedIncidentJob,
  runIncidentSchedulerOnce,
  stopIncidentScheduler,
} = require("../scheduler/incidentScheduler");
const { runIncidentRunnerOnce } = require("../scripts/incident-runner");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

let emailCounter = 0;
const ENV_BACKUPS = new Map();
[
  "INCIDENT_PREVIEW_DEPLOY_MODE",
  "INCIDENT_PREVIEW_BASE_URL",
  "INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL",
  "INCIDENT_PREVIEW_HEALTH_URL",
  "INCIDENT_PREVIEW_SMOKE_URL",
  "INCIDENT_PRODUCTION_DEPLOY_MODE",
  "INCIDENT_PRODUCTION_BASE_URL",
  "INCIDENT_PRODUCTION_DEPLOY_WEBHOOK_URL",
  "INCIDENT_PRODUCTION_HEALTH_URL",
  "INCIDENT_PRODUCTION_SMOKE_URL",
  "INCIDENT_PRODUCTION_LOG_WATCH_URL",
  "INCIDENT_PRODUCTION_ROLLBACK_WEBHOOK_URL",
  "INCIDENT_ROLLBACK_MODE",
  "INCIDENT_AUTO_DEPLOY_ENABLED",
  "INCIDENT_ALLOW_PREVIEW_SKIP",
  "INCIDENT_RELEASE_BASELINE_ID",
  "INCIDENT_WORKSPACE_SYNC_ROOT",
].forEach((name) => {
  ENV_BACKUPS.set(name, process.env[name]);
});

function restoreEnv(name, value) {
  if (typeof value === "undefined") {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function restorePhase7BEnv() {
  ENV_BACKUPS.forEach((value, key) => restoreEnv(key, value));
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function startReleaseHarness(options = {}) {
  const requests = [];
  const previewStatus = Number(options.previewStatus || 200);
  const productionStatus = Number(options.productionStatus || 200);
  const rollbackStatus = Number(options.rollbackStatus || 200);
  const logWatchStatus = Number(options.logWatchStatus || 200);
  const healthStatuses = Array.isArray(options.healthStatuses) ? [...options.healthStatuses] : [200];
  const smokeStatuses = Array.isArray(options.smokeStatuses) ? [...options.smokeStatuses] : [200];
  const logWatchBody = options.logWatchBody || {};
  const previewResponseBody =
    options.previewResponseBody || null;
  const productionResponseBody =
    options.productionResponseBody || null;

  let baseUrl = "";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let parsedBody = {};
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : {};
      } catch (_err) {
        parsedBody = { rawBody };
      }

      const pathname = new URL(req.url, baseUrl || "http://127.0.0.1").pathname;
      requests.push({
        method: req.method,
        pathname,
        body: parsedBody,
      });

      if (pathname === "/preview-deploy") {
        return json(
          res,
          previewStatus,
          previewResponseBody || {
            deployId: "preview-live-001",
            previewUrl: `${baseUrl}/preview/app`,
            commitSha: parsedBody.commitSha || "",
          }
        );
      }
      if (pathname === "/production-deploy") {
        return json(
          res,
          productionStatus,
          productionResponseBody || {
            deployId: "prod-live-001",
            url: baseUrl,
            commitSha: parsedBody.commitSha || "",
          }
        );
      }
      if (pathname === "/api/health") {
        const status = healthStatuses.length ? healthStatuses.shift() : 200;
        return json(res, status, {
          ok: status < 400,
          status,
        });
      }
      if (pathname === "/smoke/notifications") {
        const status = smokeStatuses.length ? smokeStatuses.shift() : 200;
        return json(res, status, {
          ok: status < 400,
          status,
        });
      }
      if (pathname === "/log-watch") {
        return json(res, logWatchStatus, logWatchBody);
      }
      if (pathname === "/rollback") {
        return json(res, rollbackStatus, {
          rolledBack: rollbackStatus < 400,
          rollbackTargetDeployId: parsedBody.rollbackTargetDeployId || "",
        });
      }
      if (pathname.startsWith("/preview")) {
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "Not found" });
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function applyWebhookReleaseEnv(baseUrl, overrides = {}) {
  process.env.INCIDENT_PREVIEW_DEPLOY_MODE = overrides.previewMode || "webhook";
  process.env.INCIDENT_PREVIEW_BASE_URL = `${baseUrl}/preview`;
  process.env.INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL = `${baseUrl}/preview-deploy`;
  process.env.INCIDENT_PREVIEW_HEALTH_URL = `${baseUrl}/api/health`;
  process.env.INCIDENT_PREVIEW_SMOKE_URL = `${baseUrl}/smoke/notifications`;
  process.env.INCIDENT_PRODUCTION_DEPLOY_MODE = overrides.productionMode || "webhook";
  process.env.INCIDENT_PRODUCTION_BASE_URL = baseUrl;
  process.env.INCIDENT_PRODUCTION_DEPLOY_WEBHOOK_URL = `${baseUrl}/production-deploy`;
  process.env.INCIDENT_PRODUCTION_HEALTH_URL = `${baseUrl}/api/health`;
  process.env.INCIDENT_PRODUCTION_SMOKE_URL = `${baseUrl}/smoke/notifications`;
  process.env.INCIDENT_PRODUCTION_LOG_WATCH_URL = `${baseUrl}/log-watch`;
  process.env.INCIDENT_ROLLBACK_MODE = overrides.rollbackMode || "webhook";
  process.env.INCIDENT_PRODUCTION_ROLLBACK_WEBHOOK_URL = `${baseUrl}/rollback`;
  process.env.INCIDENT_AUTO_DEPLOY_ENABLED = overrides.autoDeployEnabled || "true";
  process.env.INCIDENT_RELEASE_BASELINE_ID = overrides.rollbackTarget || "baseline-prod-001";
  if (overrides.allowPreviewSkip) {
    process.env.INCIDENT_ALLOW_PREVIEW_SKIP = "true";
  } else {
    delete process.env.INCIDENT_ALLOW_PREVIEW_SKIP;
  }
}

async function createUser(role) {
  emailCounter += 1;
  return User.create({
    firstName: role === "paralegal" ? "Parker" : "Alex",
    lastName: "Release",
    email: `${role}.${emailCounter}@incident-release.test`,
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

async function createVerifiedReleaseCandidateIncident(user, overrides = {}) {
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
  await runIncidentRunnerOnce({
    maxJobs: 1,
    workerId: "jest:incident-runner",
    jobTypes: ["verification"],
  });

  return Incident.findById(incident._id);
}

async function seedApprovalRequiredReleaseCandidate(user, options = {}) {
  const incident = await createClassifiedIncident(user, {
    summary: options.summary || "Login fails after session refresh",
    description:
      options.description ||
      "After session refresh the login flow loops and access is denied, so the release candidate requires approval.",
    pageUrl: options.pageUrl || "https://www.lets-paraconnect.com/login.html",
    routePath: options.routePath || "/login.html",
    featureKey: options.featureKey || "session-refresh",
  });

  const investigation = await IncidentInvestigation.create({
    incidentId: incident._id,
    attemptNumber: 1,
    status: "completed",
    triggerType: "auto",
    assignedAgent: "engineering_agent",
    rootCauseSummary: options.rootCauseSummary || "Authentication middleware likely regressed during session refresh.",
    rootCauseConfidence: "high",
    reproductionStatus: "reproduced",
    hypotheses: [
      {
        key: "auth-session-regression",
        statement: "Authentication middleware likely regressed during session refresh.",
        confidence: "high",
        selected: true,
        status: "confirmed",
      },
    ],
    impactedDomains: ["auth", "permissions"],
    suspectedRoutes: ["/api/auth"],
    suspectedFiles: ["backend/routes/auth.js", "backend/utils/authz.js"],
    recommendedAction: "patch",
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "incident-release-approval-"));
  const patch = await IncidentPatch.create({
    incidentId: incident._id,
    investigationId: investigation._id,
    attemptNumber: 1,
    status: "ready_for_verification",
    patchStrategy: "backend_only",
    baseCommitSha: "a".repeat(40),
    gitBranch: `incident/${incident.publicId.toLowerCase()}-approval`,
    worktreePath,
    headCommitSha: "b".repeat(40),
    patchSummary: "Prepared a backend authentication patch candidate requiring founder approval before production release.",
    filesTouched: ["backend/routes/auth.js", "backend/utils/authz.js"],
    testsAdded: [],
    testsModified: ["backend/tests/authRoutes.test.js"],
    requiresApproval: true,
    highRiskTouched: true,
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const verification = await IncidentVerification.create({
    incidentId: incident._id,
    patchId: patch._id,
    attemptNumber: 1,
    status: "passed",
    verificationLevel: "release_candidate",
    requiredChecks: [
      {
        key: "build",
        required: true,
        status: "passed",
        attempts: 1,
        details: "Backend syntax and targeted checks passed.",
      },
      {
        key: "api_replay",
        required: true,
        status: "passed",
        attempts: 1,
        details: "Session refresh API replay passed in isolation.",
      },
    ],
    failedCheckKeys: [],
    summary: "Verification passed for the isolated authentication patch.",
    startedAt: new Date(),
    completedAt: new Date(),
    verifierAgent: "verifier_agent",
  });

  incident.state = "verified_release_candidate";
  incident.currentInvestigationId = investigation._id;
  incident.currentPatchId = patch._id;
  incident.currentVerificationId = verification._id;
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  incident.classification.domain = "auth";
  incident.classification.riskLevel = "high";
  incident.classification.severity = "high";
  incident.classification.confidence = "high";
  incident.classification.suspectedRoutes = ["/api/auth"];
  incident.classification.suspectedFiles = ["backend/routes/auth.js", "backend/utils/authz.js"];
  incident.autonomyMode = "approval_required";
  incident.approvalState = "pending";
  incident.orchestration.nextJobType = "deployment";
  incident.orchestration.nextJobRunAt = new Date();
  await incident.save();

  return Incident.findById(incident._id);
}

async function seedProductionReadyIncident(user, overrides = {}) {
  const incident = await createVerifiedReleaseCandidateIncident(user, overrides);
  const patch = await IncidentPatch.findOne({ incidentId: incident._id }).sort({ attemptNumber: -1 });
  const verification = await IncidentVerification.findOne({ incidentId: incident._id }).sort({ attemptNumber: -1 });
  const rollbackTargetDeployId = Object.prototype.hasOwnProperty.call(overrides, "rollbackTargetDeployId")
    ? overrides.rollbackTargetDeployId
    : "prod-live-previous-001";
  const rollbackTargetSource = Object.prototype.hasOwnProperty.call(overrides, "rollbackTargetSource")
    ? overrides.rollbackTargetSource
    : "provider_response";

  if (rollbackTargetDeployId && overrides.seedTrustedRollbackHistory !== false) {
    await IncidentRelease.create({
      incidentId: new Incident()._id,
      verificationId: new IncidentVerification()._id,
      attemptNumber: 1,
      status: "succeeded",
      policyDecision: "auto_allowed",
      deployProvider: "render",
      productionDeployId: rollbackTargetDeployId,
      productionCommitSha: "f".repeat(40),
      productionAttestationStatus: "passed",
      productionAttestationSummary: "Production deploy identity was attested by provider evidence.",
      productionAttestationChecks: [
        { key: "provider_deploy_id", status: "passed", details: "Deploy id was returned by the provider." },
        { key: "provider_commit_sha", status: "passed", details: "Commit sha matched the requested patch." },
      ],
      deployedAt: new Date(Date.now() - 60_000),
      smokeStatus: "passed",
    });
  }

  const release = await IncidentRelease.create({
    incidentId: incident._id,
    verificationId: verification._id,
    attemptNumber: 1,
    status: "preview_verified",
    policyDecision: overrides.policyDecision || "auto_allowed",
    deployProvider: "render",
    previewDeployId: overrides.previewDeployId || "preview-verified-001",
    previewUrl: overrides.previewUrl || "https://preview.example.com",
    previewCommitSha: patch.headCommitSha,
    previewPreparedAt: new Date(),
    previewVerifiedAt: new Date(),
    previewVerificationStatus: "passed",
    previewVerificationSummary: "Preview URL, health, and smoke verification passed.",
    previewVerificationChecks: [
      { key: "provider_evidence", status: "passed", details: "Preview provider deploy evidence is present." },
      { key: "preview_url", status: "passed", details: "Preview URL is valid." },
      { key: "preview_health", status: "passed", details: "Preview health check passed." },
      { key: "preview_smoke", status: "passed", details: "Preview smoke check passed." },
    ],
    rollbackTargetDeployId,
    rollbackTargetSource,
    smokeStatus: "pending",
  });

  incident.state = "deploying_production";
  incident.currentReleaseId = release._id;
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  incident.orchestration.nextJobType = "deployment";
  incident.orchestration.nextJobRunAt = new Date();
  await incident.save();

  return Incident.findById(incident._id);
}

async function seedApprovedProductionIncident(user, overrides = {}) {
  const incident = await seedProductionReadyIncident(user, {
    ...overrides,
    policyDecision: "approval_required",
  });
  const release = await IncidentRelease.findOne({ incidentId: incident._id }).sort({ attemptNumber: -1 });
  const approval = await IncidentApproval.create({
    incidentId: incident._id,
    attemptNumber: 1,
    approvalType: "production_deploy",
    status: "approved",
    requiredByPolicy: true,
    requestedAt: new Date(),
    decidedAt: new Date(),
    decisionScope: {
      allowProductionDeploy:
        Object.prototype.hasOwnProperty.call(overrides, "allowProductionDeploy")
          ? overrides.allowProductionDeploy
          : true,
      allowUserResolution: false,
      allowManualRepair: false,
    },
    releaseId: release._id,
  });

  incident.classification.domain = "auth";
  incident.classification.riskLevel = "high";
  incident.classification.severity = "high";
  incident.autonomyMode = "approval_required";
  incident.approvalState = "approved";
  incident.currentApprovalId = approval._id;
  await incident.save();

  return Incident.findById(incident._id);
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  stopIncidentScheduler();
  restorePhase7BEnv();
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  restorePhase7BEnv();
});

describe("Incident release runner", () => {
  test("trusted preferences save incidents can self-heal through local workspace sync", async () => {
    restorePhase7BEnv();
    const paralegal = await createUser("paralegal");
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "incident-workspace-sync-"));
    process.env.INCIDENT_WORKSPACE_SYNC_ROOT = workspaceRoot;

    const releaseCandidate = await createVerifiedReleaseCandidateIncident(paralegal, {
      summary: "Save preferences button does nothing on settings",
      description: "The save preferences button does nothing and the change is not preserved.",
      pageUrl: "https://www.lets-paraconnect.com/settings",
      routePath: "/settings",
      featureKey: "save-preferences",
    });

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:release-runner",
      jobTypes: ["deployment"],
    });

    const incident = await Incident.findById(releaseCandidate._id).lean();
    const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
    const targetFile = path.join(workspaceRoot, "frontend/assets/scripts/profile-settings.js");
    const syncedSource = fs.readFileSync(targetFile, "utf8");

    expect(incident.state).toBe("resolved");
    expect(incident.userVisibleStatus).toBe("fixed_live");
    expect(incident.adminVisibleStatus).toBe("resolved");
    expect(incident.resolution.code).toBe("fixed_deployed");
    expect(incident.orchestration.nextJobType).toBe("none");
    expect(release.status).toBe("succeeded");
    expect(release.productionEvidenceQuality).toBe("workspace_sync");
    expect(release.smokeStatus).toBe("passed");
    expect(syncedSource).toContain('fetch("/api/account/preferences", {');
    expect(syncedSource).not.toContain("intentional preferences save regression marker");
  });

  test("verified high-risk release candidates move to awaiting_founder_approval with approval packet artifacts", async () => {
    const attorney = await createUser("attorney");
    const founderApprover = await createUser("admin");
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = founderApprover.email;
    const releaseCandidate = await seedApprovalRequiredReleaseCandidate(attorney);

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:release-runner",
      jobTypes: ["deployment"],
    });

    const incident = await Incident.findById(releaseCandidate._id).lean();
    const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
    const approval = await IncidentApproval.findOne({ incidentId: releaseCandidate._id }).lean();
    const packetArtifact = await IncidentArtifact.findById(approval.packetArtifactId).lean();
    const events = await IncidentEvent.find({ incidentId: releaseCandidate._id }).sort({ seq: 1 }).lean();
    const incidentNotifications = await IncidentNotification.find({ incidentId: releaseCandidate._id }).lean();
    const founderNotifications = await Notification.find({ userId: founderApprover._id }).lean();

    expect(incident.state).toBe("awaiting_founder_approval");
    expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(incident.adminVisibleStatus).toBe("awaiting_approval");
    expect(incident.orchestration.nextJobType).toBe("none");
    expect(String(incident.currentReleaseId)).toBe(String(release._id));
    expect(String(incident.currentApprovalId)).toBe(String(approval._id));

    expect(release.status).toBe("awaiting_founder_approval");
    expect(release.policyDecision).toBe("approval_required");
    expect(release.smokeStatus).toBe("pending");

    expect(approval.status).toBe("pending");
    expect(approval.approvalType).toBe("production_deploy");
    expect(approval.requiredByPolicy).toBe(true);
    expect(String(approval.releaseId)).toBe(String(release._id));
    expect(packetArtifact.artifactType).toBe("approval_packet");
    expect(packetArtifact.body).toEqual(
      expect.objectContaining({
        incidentPublicId: incident.publicId,
        riskLevel: "high",
        approvalReasons: expect.arrayContaining(["high-risk incident"]),
      })
    );
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["approval_requested"])
    );
    expect(incidentNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          audience: "reporter",
          templateKey: "awaiting_internal_review",
          status: "sent",
        }),
        expect.objectContaining({
          audience: "founder",
          templateKey: "founder_approval_request",
          status: "sent",
          recipientUserId: founderApprover._id,
        }),
      ])
    );
    expect(founderNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "incident_approval_required",
        }),
      ])
    );
  });

  test("approval grants are auditable and queue deployment continuation", async () => {
    const attorney = await createUser("attorney");
    const releaseCandidate = await seedApprovalRequiredReleaseCandidate(attorney);

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:release-runner",
      jobTypes: ["deployment"],
    });

    const incidentBeforeDecision = await Incident.findById(releaseCandidate._id);
    const approval = await IncidentApproval.findOne({ incidentId: releaseCandidate._id });

    await decideIncidentApproval({
      incidentIdentifier: incidentBeforeDecision.publicId,
      approvalId: approval._id,
      decision: "approve",
      note: "Founder approved production continuation.",
      actor: {
        userId: attorney._id,
        email: "samantha@lets-paraconnect.com",
        decisionRole: "founder_approver",
      },
    });

    const incident = await Incident.findById(releaseCandidate._id).lean();
    const updatedApproval = await IncidentApproval.findById(approval._id).lean();
    const release = await IncidentRelease.findById(updatedApproval.releaseId).lean();
    const events = await IncidentEvent.find({
      incidentId: releaseCandidate._id,
      eventType: "approval_granted",
    }).lean();

    expect(incident.approvalState).toBe("approved");
    expect(incident.state).toBe("verified_release_candidate");
    expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(incident.orchestration.nextJobType).toBe("deployment");
    expect(updatedApproval.status).toBe("approved");
    expect(updatedApproval.decisionRole).toBe("founder_approver");
    expect(updatedApproval.decisionNote).toBe("Founder approved production continuation.");
    expect(release.status).toBe("queued");
    expect(events).toHaveLength(1);
  });

  test("approval grants do not queue deployment when production scope is not allowed", async () => {
    const attorney = await createUser("attorney");
    const releaseCandidate = await seedApprovalRequiredReleaseCandidate(attorney);

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:release-runner",
      jobTypes: ["deployment"],
    });

    const incidentBeforeDecision = await Incident.findById(releaseCandidate._id);
    const approval = await IncidentApproval.findOne({ incidentId: releaseCandidate._id });

    await decideIncidentApproval({
      incidentIdentifier: incidentBeforeDecision.publicId,
      approvalId: approval._id,
      decision: "approve",
      note: "Approved for manual preview review only.",
      scope: {
        allowProductionDeploy: false,
        allowUserResolution: false,
        allowManualRepair: false,
      },
      actor: {
        userId: attorney._id,
        email: "samantha@lets-paraconnect.com",
        decisionRole: "founder_approver",
      },
    });

    const incident = await Incident.findById(releaseCandidate._id).lean();
    const updatedApproval = await IncidentApproval.findById(approval._id).lean();
    const release = await IncidentRelease.findById(updatedApproval.releaseId).lean();

    expect(updatedApproval.status).toBe("approved");
    expect(updatedApproval.decisionScope.allowProductionDeploy).toBe(false);
    expect(incident.state).toBe("needs_human_owner");
    expect(incident.orchestration.nextJobType).toBe("none");
    expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(release.status).toBe("blocked");
  });

  test("preview remains blocked when the provider does not return deploy-specific preview evidence", async () => {
    const harness = await startReleaseHarness({
      previewResponseBody: {
        deployId: "preview-live-001",
      },
    });
    applyWebhookReleaseEnv(harness.baseUrl, { productionMode: "disabled" });

    try {
      const attorney = await createUser("attorney");
      const releaseCandidate = await createVerifiedReleaseCandidateIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(releaseCandidate._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();

      expect(incident.state).toBe("verified_release_candidate");
      expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(release.status).toBe("preview_blocked");
      expect(release.previewUrl).toBe("");
      expect(release.previewDeployRequestedAt).toBeTruthy();
      expect(release.previewDeployAcknowledgedAt).toBeTruthy();
      expect(release.previewEvidenceReceivedAt).toBeTruthy();
      expect(release.previewEvidenceQuality).toBe("deploy_id_only");
      expect(release.previewVerificationStatus).toBe("blocked");
      expect(release.previewVerifiedAt).toBeNull();
      expect(release.previewVerificationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "provider_evidence_quality", status: "blocked" }),
          expect.objectContaining({ key: "preview_url", status: "blocked" }),
        ])
      );
      expect(harness.requests.map((request) => request.pathname)).toContain("/preview-deploy");
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("preview remains blocked when the provider does not return a matching deploy commit attestation", async () => {
    const harness = await startReleaseHarness({
      previewResponseBody: {
        deployId: "preview-live-001",
        previewUrl: "http://127.0.0.1/preview/app",
      },
    });
    applyWebhookReleaseEnv(harness.baseUrl, { productionMode: "disabled" });

    try {
      const attorney = await createUser("attorney");
      const releaseCandidate = await createVerifiedReleaseCandidateIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(releaseCandidate._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();

      expect(incident.state).toBe("verified_release_candidate");
      expect(release.status).toBe("preview_blocked");
      expect(release.previewDeployId).toBe("preview-live-001");
      expect(release.previewDeployRequestedAt).toBeTruthy();
      expect(release.previewDeployAcknowledgedAt).toBeTruthy();
      expect(release.previewEvidenceReceivedAt).toBeTruthy();
      expect(release.previewEvidenceQuality).toBe("deploy_id_and_url");
      expect(release.previewVerificationStatus).toBe("blocked");
      expect(release.previewVerifiedAt).toBeNull();
      expect(release.previewVerificationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "provider_evidence_quality", status: "blocked" }),
          expect.objectContaining({ key: "provider_commit_sha", status: "blocked" }),
        ])
      );
      expect(harness.requests.map((request) => request.pathname)).toContain("/preview-deploy");
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("approved production deploys stay blocked when the rollback target is missing", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const incident = await seedApprovedProductionIncident(attorney, {
        rollbackTargetDeployId: "",
      });

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const updatedIncident = await Incident.findById(incident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: incident._id }).lean();

      expect(updatedIncident.state).toBe("needs_human_owner");
      expect(updatedIncident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(release.status).toBe("preview_verified");
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("preview is blocked in stub mode because no real preview provider evidence exists", async () => {
    process.env.INCIDENT_PREVIEW_DEPLOY_MODE = "stub";
    process.env.INCIDENT_RELEASE_BASELINE_ID = "baseline-preview-001";

    const attorney = await createUser("attorney");
    const releaseCandidate = await createVerifiedReleaseCandidateIncident(attorney);
    expect(releaseCandidate.state).toBe("verified_release_candidate");
    expect(releaseCandidate.orchestration.nextJobType).toBe("deployment");

    await runIncidentRunnerOnce({
      maxJobs: 1,
      workerId: "jest:release-runner",
      jobTypes: ["deployment"],
    });

    const incident = await Incident.findById(releaseCandidate._id).lean();
    const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
    const events = await IncidentEvent.find({ incidentId: releaseCandidate._id }).sort({ seq: 1 }).lean();

    expect(incident.state).toBe("verified_release_candidate");
    expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(incident.adminVisibleStatus).toBe("active");
    expect(incident.userVisibleStatus).not.toBe("fixed_live");
    expect(incident.orchestration.nextJobType).toBe("none");

    expect(release.policyDecision).toBe("auto_allowed");
    expect(release.status).toBe("preview_blocked");
    expect(release.previewDeployId).toMatch(/^preview-stub-inc-/);
    expect(release.previewUrl).toMatch(/^stub-preview:\/\//);
    expect(release.previewCommitSha).toBe("");
    expect(release.previewDeployRequestedAt).toBeTruthy();
    expect(release.previewDeployAcknowledgedAt).toBeTruthy();
    expect(release.previewEvidenceReceivedAt).toBeNull();
    expect(release.previewEvidenceQuality).toBe("stub_only");
    expect(release.previewPreparedAt).toBeTruthy();
    expect(release.previewVerificationStatus).toBe("blocked");
    expect(release.rollbackTargetDeployId).toBe("");
    expect(release.rollbackTargetValidationStatus).toBe("not_started");
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["deploy_started"])
    );
    expect(events.map((event) => event.eventType)).not.toContain("deploy_succeeded");
    expect(events.map((event) => event.toState)).not.toContain("resolved");
  });

  test("preview can be prepared without being verified when preview coverage is unavailable", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const releaseCandidate = await createVerifiedReleaseCandidateIncident(attorney);
      await IncidentPatch.updateOne(
        { incidentId: releaseCandidate._id },
        { $set: { filesTouched: ["frontend/assets/scripts/views/help.js"] } }
      );

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(releaseCandidate._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
      const artifacts = await IncidentArtifact.find({
        incidentId: releaseCandidate._id,
        artifactType: { $in: ["deploy_log", "health_snapshot", "coverage_summary", "preview_url"] },
      }).lean();
      const events = await IncidentEvent.find({ incidentId: releaseCandidate._id }).sort({ seq: 1 }).lean();

      expect(incident.state).toBe("verified_release_candidate");
      expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(incident.adminVisibleStatus).toBe("active");
      expect(incident.resolution.code || null).toBeNull();
      expect(release.status).toBe("preview_prepared");
      expect(release.previewDeployId).toBe("preview-live-001");
      expect(release.previewPreparedAt).toBeTruthy();
      expect(release.previewVerificationStatus).toBe("blocked");
      expect(release.previewVerifiedAt).toBeNull();
      expect(release.productionDeployId).toBe("");
      expect(release.smokeStatus).toBe("pending");
      expect(artifacts.map((artifact) => artifact.artifactType)).toEqual(
        expect.arrayContaining(["deploy_log", "preview_url", "health_snapshot", "coverage_summary"])
      );
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["deploy_started"])
      );
      expect(events.map((event) => event.eventType)).not.toContain("deploy_succeeded");
      expect(events.map((event) => event.eventType)).not.toContain("post_deploy_verification_passed");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ fromState: "verified_release_candidate", toState: "deploying_preview" }),
          expect.objectContaining({ fromState: "deploying_preview", toState: "verified_release_candidate" }),
        ])
      );
      expect(
        harness.requests.map((request) => request.pathname)
      ).toEqual(
        expect.arrayContaining([
          "/preview-deploy",
          "/api/health",
        ])
      );
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/smoke/notifications");
    } finally {
      await harness.close();
    }
  });

  test("preview is verified only after real preview health and smoke checks pass", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl, { productionMode: "disabled" });

    try {
      const attorney = await createUser("attorney");
      const releaseCandidate = await createVerifiedReleaseCandidateIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(releaseCandidate._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
      const artifacts = await IncidentArtifact.find({
        incidentId: releaseCandidate._id,
        artifactType: { $in: ["deploy_log", "health_snapshot", "coverage_summary", "preview_url"] },
      }).lean();

      expect(incident.state).toBe("verified_release_candidate");
      expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(release.status).toBe("preview_verified");
      expect(release.previewDeployRequestedAt).toBeTruthy();
      expect(release.previewDeployAcknowledgedAt).toBeTruthy();
      expect(release.previewEvidenceReceivedAt).toBeTruthy();
      expect(release.previewEvidenceQuality).toBe("deploy_id_url_commit");
      expect(release.previewVerificationStatus).toBe("passed");
      expect(release.previewPreparedAt).toBeTruthy();
      expect(release.previewVerifiedAt).toBeTruthy();
      expect(release.productionDeployId).toBe("");
      expect(release.previewVerificationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "preview_health", status: "passed" }),
          expect.objectContaining({ key: "preview_smoke", status: "passed" }),
        ])
      );
      expect(artifacts.map((artifact) => artifact.artifactType)).toEqual(
        expect.arrayContaining(["deploy_log", "preview_url", "health_snapshot", "coverage_summary"])
      );
      expect(harness.requests.map((request) => request.pathname)).toEqual(
        expect.arrayContaining(["/preview-deploy", "/api/health", "/smoke/notifications"])
      );
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("preview verification fails when preview health or smoke checks fail", async () => {
    const harness = await startReleaseHarness({
      healthStatuses: [500, 500],
    });
    applyWebhookReleaseEnv(harness.baseUrl, { productionMode: "disabled" });

    try {
      const attorney = await createUser("attorney");
      const releaseCandidate = await createVerifiedReleaseCandidateIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(releaseCandidate._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
      const events = await IncidentEvent.find({ incidentId: releaseCandidate._id }).sort({ seq: 1 }).lean();

      expect(incident.state).toBe("verified_release_candidate");
      expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(release.status).toBe("preview_failed");
      expect(release.previewVerificationStatus).toBe("failed");
      expect(release.productionDeployId).toBe("");
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["deploy_started", "deploy_failed"])
      );
      expect(harness.requests.map((request) => request.pathname)).toEqual(
        expect.arrayContaining(["/preview-deploy", "/api/health", "/smoke/notifications"])
      );
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("production continuation remains blocked without a verified preview", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const incident = await seedApprovedProductionIncident(attorney);
      await IncidentRelease.updateOne(
        { incidentId: incident._id },
        {
          $set: {
            status: "preview_prepared",
            previewVerificationStatus: "blocked",
            previewVerificationSummary: "Preview deployed but was not verified.",
            previewVerifiedAt: null,
          },
        }
      );

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const updatedIncident = await Incident.findById(incident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: incident._id }).lean();

      expect(updatedIncident.state).toBe("needs_human_owner");
      expect(updatedIncident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(updatedIncident.userVisibleStatus).not.toBe("fixed_live");
      expect(release.status).toBe("preview_prepared");
      expect(release.previewVerificationStatus).toBe("blocked");
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("production fallback from deploying_production stops in needs_human_owner instead of returning to candidate", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const incident = await seedProductionReadyIncident(attorney);
      await IncidentRelease.updateOne(
        { incidentId: incident._id },
        {
          $set: {
            status: "preview_prepared",
            previewVerificationStatus: "blocked",
            previewVerificationSummary: "Preview deployed but was not verified.",
            previewVerifiedAt: null,
          },
        }
      );

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const updatedIncident = await Incident.findById(incident._id).lean();
      expect(updatedIncident.state).toBe("needs_human_owner");
      expect(updatedIncident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("production deploy remains blocked when the provider does not return a matching deploy commit attestation", async () => {
    const harness = await startReleaseHarness({
      productionResponseBody: {
        deployId: "prod-live-001",
        url: "https://app.lets-paraconnect.com",
      },
    });
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const productionIncident = await seedProductionReadyIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(productionIncident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: productionIncident._id }).lean();
      const events = await IncidentEvent.find({ incidentId: productionIncident._id }).sort({ seq: 1 }).lean();

      expect(incident.state).toBe("needs_human_owner");
      expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(incident.userVisibleStatus).not.toBe("fixed_live");
      expect(release.status).toBe("blocked");
      expect(release.productionDeployId).toBe("prod-live-001");
      expect(release.productionCommitSha).toBe("");
      expect(release.productionDeployRequestedAt).toBeTruthy();
      expect(release.productionDeployAcknowledgedAt).toBeTruthy();
      expect(release.productionEvidenceReceivedAt).toBeTruthy();
      expect(release.productionEvidenceQuality).toBe("deploy_id_and_url");
      expect(release.productionVerifiedAt).toBeNull();
      expect(release.productionAttestationStatus).toBe("blocked");
      expect(release.productionAttestationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "provider_evidence_quality", status: "blocked" }),
          expect.objectContaining({ key: "provider_commit_sha", status: "blocked" }),
        ])
      );
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["deploy_started", "deploy_failed"])
      );
    } finally {
      await harness.close();
    }
  });

  test("manual production-ready incidents resolve only after post-deploy verification passes", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const productionIncident = await seedProductionReadyIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(productionIncident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: productionIncident._id }).lean();
      const incidentNotifications = await IncidentNotification.find({ incidentId: productionIncident._id }).lean();
      const reporterNotifications = await Notification.find({ userId: attorney._id }).lean();

      expect(incident.state).toBe("resolved");
      expect(incident.userVisibleStatus).toBe("fixed_live");
      expect(incident.adminVisibleStatus).toBe("resolved");
      expect(incident.resolution.code).toBe("fixed_deployed");
      expect(release.status).toBe("succeeded");
      expect(release.productionDeployId).toBe("prod-live-001");
      expect(release.productionDeployRequestedAt).toBeTruthy();
      expect(release.productionDeployAcknowledgedAt).toBeTruthy();
      expect(release.productionEvidenceReceivedAt).toBeTruthy();
      expect(release.productionEvidenceQuality).toBe("deploy_id_url_commit");
      expect(release.productionVerifiedAt).toBeTruthy();
      expect(release.smokeStatus).toBe("passed");
      expect(release.rollbackTargetValidationStatus).toBe("passed");
      expect(release.rollbackTargetValidationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "rollback_target_history", status: "passed" }),
          expect.objectContaining({ key: "rollback_target_attested_release", status: "passed" }),
          expect.objectContaining({ key: "rollback_target_smoke", status: "passed" }),
          expect.objectContaining({ key: "rollback_target_latest_trusted", status: "passed" }),
        ])
      );
      expect(incidentNotifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            audience: "reporter",
            templateKey: "fixed_live",
            status: "sent",
          }),
        ])
      );
      expect(reporterNotifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "incident_update",
            message: "We identified the issue, verified the fix, and it is now live.",
          }),
        ])
      );
    } finally {
      await harness.close();
    }
  });

  test("baseline-only rollback targets are rejected as insufficient for production continuation", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl, { rollbackTarget: "baseline-prod-001" });

    try {
      const attorney = await createUser("attorney");
      const incident = await seedApprovedProductionIncident(attorney, {
        rollbackTargetDeployId: "baseline-prod-001",
        rollbackTargetSource: "provider_response",
        seedTrustedRollbackHistory: false,
      });

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const updatedIncident = await Incident.findById(incident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: incident._id }).lean();

      expect(updatedIncident.state).toBe("needs_human_owner");
      expect(updatedIncident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(release.status).toBe("preview_verified");
      expect(release.rollbackTargetValidationStatus).toBe("blocked");
      expect(release.rollbackTargetValidationSummary).toMatch(/not corroborated|baseline/i);
      expect(release.rollbackTargetValidationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "rollback_target_baseline", status: "blocked" }),
          expect.objectContaining({ key: "rollback_target_history", status: "blocked" }),
        ])
      );
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("rollback target is blocked when it does not match the latest known good production release", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl, { rollbackTarget: "prod-live-previous-001" });

    try {
      const attorney = await createUser("attorney");
      const incident = await seedApprovedProductionIncident(attorney, {
        rollbackTargetDeployId: "prod-live-previous-001",
        rollbackTargetSource: "provider_response",
      });

      await IncidentRelease.create({
        incidentId: new Incident()._id,
        verificationId: new IncidentVerification()._id,
        attemptNumber: 1,
        status: "succeeded",
        policyDecision: "auto_allowed",
        deployProvider: "render",
        productionDeployId: "prod-live-newer-001",
        productionCommitSha: "e".repeat(40),
        productionAttestationStatus: "passed",
        productionAttestationSummary: "Production deploy identity was attested by provider evidence.",
        productionAttestationChecks: [
          { key: "provider_deploy_id", status: "passed", details: "Deploy id was returned by the provider." },
          { key: "provider_commit_sha", status: "passed", details: "Commit sha matched the requested patch." },
        ],
        deployedAt: new Date(),
        smokeStatus: "passed",
      });

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const updatedIncident = await Incident.findById(incident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: incident._id }).lean();

      expect(updatedIncident.state).toBe("needs_human_owner");
      expect(release.rollbackTargetValidationStatus).toBe("blocked");
      expect(release.rollbackTargetValidationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "rollback_target_latest_trusted", status: "blocked" }),
        ])
      );
      expect(release.rollbackTargetValidationSummary).toMatch(/latest known good production release/i);
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("rollback target is blocked when the corroborating release lacks passed production attestation", async () => {
    const harness = await startReleaseHarness();
    applyWebhookReleaseEnv(harness.baseUrl, { rollbackTarget: "prod-live-previous-001" });

    try {
      const attorney = await createUser("attorney");
      const incident = await seedApprovedProductionIncident(attorney, {
        rollbackTargetDeployId: "prod-live-previous-001",
        rollbackTargetSource: "provider_response",
        seedTrustedRollbackHistory: false,
      });

      await IncidentRelease.create({
        incidentId: new Incident()._id,
        verificationId: new IncidentVerification()._id,
        attemptNumber: 1,
        status: "succeeded",
        policyDecision: "auto_allowed",
        deployProvider: "render",
        productionDeployId: "prod-live-previous-001",
        productionCommitSha: "d".repeat(40),
        productionAttestationStatus: "blocked",
        productionAttestationSummary: "Provider evidence was incomplete.",
        productionAttestationChecks: [
          { key: "provider_deploy_id", status: "passed", details: "Deploy id was returned by the provider." },
          { key: "provider_commit_sha", status: "blocked", details: "Commit sha was not returned by the provider." },
        ],
        deployedAt: new Date(Date.now() - 60_000),
        smokeStatus: "passed",
      });

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const updatedIncident = await Incident.findById(incident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: incident._id }).lean();

      expect(updatedIncident.state).toBe("needs_human_owner");
      expect(release.rollbackTargetValidationStatus).toBe("blocked");
      expect(release.rollbackTargetValidationChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "rollback_target_attested_release", status: "blocked" }),
        ])
      );
      expect(release.rollbackTargetValidationSummary).toMatch(/passed deploy attestation/i);
      expect(harness.requests.map((request) => request.pathname)).not.toContain("/production-deploy");
    } finally {
      await harness.close();
    }
  });

  test("configured log-watch failures block automatic resolution after production deploy", async () => {
    const harness = await startReleaseHarness({
      logWatchStatus: 500,
      logWatchBody: {
        error: "log stream unavailable",
      },
    });
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const productionIncident = await seedProductionReadyIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(productionIncident._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: productionIncident._id }).lean();
      const events = await IncidentEvent.find({ incidentId: productionIncident._id }).sort({ seq: 1 }).lean();

      expect(incident.state).toBe("needs_human_owner");
      expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(incident.userVisibleStatus).not.toBe("fixed_live");
      expect(release.status).toBe("post_deploy_verifying");
      expect(release.smokeStatus).toBe("failed");
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["deploy_succeeded", "post_deploy_verification_failed"])
      );
    } finally {
      await harness.close();
    }
  });

  test("post-deploy rollback triggers close incidents as rolled back when rollback succeeds", async () => {
    const harness = await startReleaseHarness({
      healthStatuses: [500, 500],
      smokeStatuses: [500, 500],
    });
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const releaseCandidate = await seedProductionReadyIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(releaseCandidate._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
      const rollbackArtifact = await IncidentArtifact.findOne({
        incidentId: releaseCandidate._id,
        artifactType: "rollback_report",
      }).lean();
      const events = await IncidentEvent.find({ incidentId: releaseCandidate._id }).sort({ seq: 1 }).lean();

      expect(incident.state).toBe("closed_rolled_back");
      expect(incident.userVisibleStatus).toBe("closed");
      expect(incident.adminVisibleStatus).toBe("rolled_back");
      expect(incident.resolution.code).toBe("rolled_back");
      expect(release.status).toBe("rolled_back");
      expect(release.rollbackReason).toMatch(/health check failed twice|production smoke failed twice/i);
      expect(rollbackArtifact.artifactType).toBe("rollback_report");
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining([
          "post_deploy_verification_failed",
          "rollback_started",
          "rollback_succeeded",
        ])
      );
    } finally {
      await harness.close();
    }
  });

  test("failed rollback moves the incident into needs_human_owner", async () => {
    const harness = await startReleaseHarness({
      healthStatuses: [500, 500],
      smokeStatuses: [500, 500],
      rollbackStatus: 500,
    });
    applyWebhookReleaseEnv(harness.baseUrl);

    try {
      const attorney = await createUser("attorney");
      const releaseCandidate = await seedProductionReadyIncident(attorney);

      await runIncidentRunnerOnce({
        maxJobs: 1,
        workerId: "jest:release-runner",
        jobTypes: ["deployment"],
      });

      const incident = await Incident.findById(releaseCandidate._id).lean();
      const release = await IncidentRelease.findOne({ incidentId: releaseCandidate._id }).lean();
      const events = await IncidentEvent.find({ incidentId: releaseCandidate._id }).sort({ seq: 1 }).lean();

      expect(incident.state).toBe("needs_human_owner");
      expect(incident.userVisibleStatus).toBe("awaiting_internal_review");
      expect(release.status).toBe("rollback_failed");
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["rollback_started", "rollback_failed"])
      );
    } finally {
      await harness.close();
    }
  });

  test("release-stage claims honor the existing lock semantics", async () => {
    process.env.INCIDENT_PREVIEW_DEPLOY_MODE = "stub";
    process.env.INCIDENT_RELEASE_BASELINE_ID = "baseline-preview-001";

    const attorney = await createUser("attorney");
    const releaseCandidate = await createVerifiedReleaseCandidateIncident(attorney);

    const firstClaim = await claimNextIncidentJob({
      jobTypes: ["deployment"],
      workerId: "jest:release-lock-1",
    });
    const secondClaim = await claimNextIncidentJob({
      jobTypes: ["deployment"],
      workerId: "jest:release-lock-2",
    });

    expect(firstClaim).toEqual(
      expect.objectContaining({
        incidentId: String(releaseCandidate._id),
        jobType: "deployment",
      })
    );
    expect(secondClaim).toBeNull();

    const processed = await processClaimedIncidentJob(firstClaim);
    expect(processed.ok).toBe(true);

    const updatedIncident = await Incident.findById(releaseCandidate._id).lean();
    expect(updatedIncident.orchestration.nextJobType).toBe("none");
  });
});
