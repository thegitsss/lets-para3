const express = require("express");
const cookieParser = require("cookie-parser");
const csrf = require("csurf");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentInvestigation = require("../models/IncidentInvestigation");
const IncidentPatch = require("../models/IncidentPatch");
const IncidentVerification = require("../models/IncidentVerification");
const IncidentRelease = require("../models/IncidentRelease");
const IncidentApproval = require("../models/IncidentApproval");
const IncidentArtifact = require("../models/IncidentArtifact");
const IncidentNotification = require("../models/IncidentNotification");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

function loadIncidentAdminRouter() {
  const routePath = require.resolve("../routes/incidentAdmin");
  delete require.cache[routePath];
  return require("../routes/incidentAdmin");
}

function buildIncidentAdminApp({ withCsrfHarness = false } = {}) {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  if (withCsrfHarness) {
    const csrfProtection = csrf({
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
      },
    });
    instance.get("/api/csrf", csrfProtection, (req, res) => {
      res.json({ csrfToken: req.csrfToken() });
    });
    instance.use(csrfProtection);
  }
  instance.use("/api/admin/incidents", loadIncidentAdminRouter());
  instance.use((err, _req, res, _next) => {
    if (withCsrfHarness && err?.code === "EBADCSRFTOKEN") {
      return res.status(403).json({ error: "Invalid CSRF token" });
    }
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
}

const app = buildIncidentAdminApp();

const FOUNDER_APPROVER_ENV = process.env.INCIDENT_FOUNDER_APPROVER_EMAILS;
const ADMIN_APPROVER_FALLBACK_ENV = process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK;
const NODE_ENV_BACKUP = process.env.NODE_ENV;
const ENABLE_CSRF_BACKUP = process.env.ENABLE_CSRF;

function authCookieFor(user) {
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function createAdmin() {
  return User.create({
    firstName: "Admin",
    lastName: "Owner",
    email: "incident-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

async function seedIncidentGraph() {
  const incident = await Incident.create({
    publicId: "INC-20260319-000001",
    source: "system_monitor",
    summary: "Hire button is not responding on case detail.",
    originalReportText: "The hire button does nothing for attorneys on the case detail page.",
    state: "verification_failed",
    approvalState: "not_needed",
    autonomyMode: "full_auto",
    userVisibleStatus: "investigating",
    adminVisibleStatus: "verification_failed",
    classification: {
      domain: "ui",
      severity: "medium",
      riskLevel: "medium",
      confidence: "high",
      clusterKey: "hire-button-case-detail",
      suspectedRoutes: ["/cases/:id"],
      suspectedFiles: ["frontend/assets/scripts/views/case-detail.js"],
    },
    context: {
      surface: "attorney",
      pageUrl: "/case-detail.html?id=123",
      routePath: "/cases/:id",
    },
    lastEventSeq: 2,
  });

  await IncidentEvent.create([
    {
      incidentId: incident._id,
      seq: 1,
      eventType: "state_changed",
      actor: { type: "system" },
      summary: "Incident reported.",
      fromState: "reported",
      toState: "classified",
    },
    {
      incidentId: incident._id,
      seq: 2,
      eventType: "verification_failed",
      actor: { type: "agent", agentRole: "verifier_agent" },
      summary: "UI flow verification failed in preview.",
      fromState: "awaiting_verification",
      toState: "verification_failed",
      detail: { failedCheck: "ui_flow" },
    },
  ]);

  const investigation = await IncidentInvestigation.create({
    incidentId: incident._id,
    attemptNumber: 1,
    status: "completed",
    triggerType: "auto",
    rootCauseSummary: "Click handler detached after a recent frontend refactor.",
    rootCauseConfidence: "high",
    reproductionStatus: "reproduced",
    suspectedFiles: ["frontend/assets/scripts/views/case-detail.js"],
    suspectedRoutes: ["/cases/:id"],
    recommendedAction: "patch",
  });

  const patch = await IncidentPatch.create({
    incidentId: incident._id,
    investigationId: investigation._id,
    attemptNumber: 1,
    status: "ready_for_verification",
    patchStrategy: "frontend_only",
    baseCommitSha: "abc123def456",
    gitBranch: "incident/inc-20260319-000001",
    patchSummary: "Re-bound the hire action listener after DOM refresh.",
    filesTouched: ["frontend/assets/scripts/views/case-detail.js"],
  });

  const verification = await IncidentVerification.create({
    incidentId: incident._id,
    patchId: patch._id,
    attemptNumber: 1,
    status: "failed",
    verificationLevel: "targeted",
    requiredChecks: [
      { key: "ui_flow", required: true, status: "failed", attempts: 1, details: "Button still inactive in preview." },
    ],
    failedCheckKeys: ["ui_flow"],
    summary: "UI flow did not reach the expected hire modal.",
  });

  const release = await IncidentRelease.create({
    incidentId: incident._id,
    verificationId: verification._id,
    attemptNumber: 1,
    status: "preview_failed",
    policyDecision: "auto_allowed",
    deployProvider: "render",
    previewDeployId: "srv-preview-123",
    previewUrl: "https://preview.example.com",
    previewPreparedAt: new Date("2026-03-19T12:05:00.000Z"),
    previewVerificationStatus: "failed",
    previewVerificationSummary: "Preview health verification failed after deploy.",
    previewVerificationChecks: [
      {
        key: "provider_evidence",
        status: "passed",
        details: "Preview deploy webhook returned deploy evidence.",
      },
      {
        key: "preview_url",
        status: "passed",
        details: "Preview URL is valid.",
      },
      {
        key: "preview_health",
        status: "failed",
        details: "Preview health check failed.",
      },
    ],
    rollbackTargetDeployId: "prod-live-previous-001",
    rollbackTargetSource: "provider_response",
    rollbackTargetValidationStatus: "blocked",
    rollbackTargetValidationSummary: "Rollback target is not corroborated by a prior successful production release.",
    rollbackTargetValidationChecks: [
      {
        key: "rollback_target_history",
        status: "blocked",
        details: "Rollback target does not match any prior successful production release recorded by the incident system.",
      },
    ],
  });

  await IncidentArtifact.create({
    incidentId: incident._id,
    releaseId: release._id,
    artifactType: "preview_url",
    stage: "release",
    label: "Preview deployment reference",
    contentType: "link",
    storageMode: "inline",
    body: "https://preview.example.com",
    createdByAgent: "release_agent",
  });
  await IncidentArtifact.create({
    incidentId: incident._id,
    releaseId: release._id,
    artifactType: "coverage_summary",
    stage: "release",
    label: "Preview verification summary",
    contentType: "json",
    storageMode: "inline",
    body: {
      previewVerificationStatus: "failed",
      reason: "Preview health check failed.",
    },
    createdByAgent: "release_agent",
  });

  const approval = await IncidentApproval.create({
    incidentId: incident._id,
    attemptNumber: 1,
    approvalType: "production_deploy",
    status: "pending",
    requiredByPolicy: false,
    requestedAt: new Date("2026-03-19T12:00:00.000Z"),
  });

  await Incident.findByIdAndUpdate(incident._id, {
    currentInvestigationId: investigation._id,
    currentPatchId: patch._id,
    currentVerificationId: verification._id,
    currentReleaseId: release._id,
    currentApprovalId: approval._id,
  });

  await IncidentNotification.create({
    incidentId: incident._id,
    audience: "reporter",
    channel: "in_app",
    templateKey: "investigating",
    status: "sent",
    bodyPreview: "We validated your report and started technical investigation.",
    recipientEmail: "incident-admin@lets-paraconnect.test",
    payload: {
      dedupeKey: `reporter:investigating:${incident.publicId}`,
      incidentPublicId: incident.publicId,
    },
    sentAt: new Date("2026-03-19T12:06:00.000Z"),
  });

  const secondIncident = await Incident.create({
    publicId: "INC-20260319-000002",
    source: "help_form",
    summary: "Hire button issue still appearing on another case.",
    originalReportText: "Another attorney reported the same Hire button problem.",
    state: "investigating",
    classification: {
      domain: "ui",
      severity: "medium",
      riskLevel: "medium",
      confidence: "medium",
      clusterKey: "hire-button-case-detail",
    },
    context: { surface: "attorney", routePath: "/cases/:id" },
  });

  const thirdIncident = await Incident.create({
    publicId: "INC-20260319-000003",
    source: "admin_created",
    summary: "Stripe payout release appears delayed.",
    originalReportText: "Possible payout delay needs investigation.",
    state: "awaiting_founder_approval",
    approvalState: "pending",
    autonomyMode: "approval_required",
    classification: {
      domain: "payouts",
      severity: "high",
      riskLevel: "high",
      confidence: "high",
      clusterKey: "payout-delay",
      riskFlags: { affectsMoney: true },
    },
    context: { surface: "admin", routePath: "/api/payments/payouts" },
  });

  return { incident, secondIncident, thirdIncident, verification, release };
}

async function seedAwaitingApprovalIncident() {
  const incident = await Incident.create({
    publicId: "INC-20260320-000100",
    source: "help_form",
    summary: "Auth release candidate requires founder approval.",
    originalReportText: "High-risk auth patch is ready but must wait for founder approval.",
    state: "awaiting_founder_approval",
    approvalState: "pending",
    autonomyMode: "approval_required",
    userVisibleStatus: "awaiting_internal_review",
    adminVisibleStatus: "awaiting_approval",
    classification: {
      domain: "auth",
      severity: "high",
      riskLevel: "high",
      confidence: "high",
      clusterKey: "auth-release",
      suspectedRoutes: ["/api/auth"],
      suspectedFiles: ["backend/routes/auth.js"],
    },
    context: {
      surface: "attorney",
      routePath: "/login.html",
    },
    lastEventSeq: 1,
    orchestration: {
      nextJobType: "none",
      nextJobRunAt: new Date(),
    },
  });

  const release = await IncidentRelease.create({
    incidentId: incident._id,
    verificationId: (
      await IncidentVerification.create({
        incidentId: incident._id,
        attemptNumber: 1,
        status: "passed",
        verificationLevel: "release_candidate",
        requiredChecks: [
          { key: "build", required: true, status: "passed", attempts: 1, details: "Targeted checks passed." },
        ],
        summary: "Verification passed for founder approval route testing.",
      })
    )._id,
    attemptNumber: 1,
    status: "awaiting_founder_approval",
    policyDecision: "approval_required",
    deployProvider: "render",
    rollbackTargetDeployId: "baseline-prod-001",
    smokeStatus: "pending",
  });

  const approval = await IncidentApproval.create({
    incidentId: incident._id,
    attemptNumber: 1,
    approvalType: "production_deploy",
    status: "pending",
    requiredByPolicy: true,
    requestedAt: new Date("2026-03-20T12:00:00.000Z"),
    releaseId: release._id,
  });

  await Incident.findByIdAndUpdate(incident._id, {
    currentReleaseId: release._id,
    currentApprovalId: approval._id,
  });

  return { incident, release, approval };
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  if (typeof FOUNDER_APPROVER_ENV === "undefined") {
    delete process.env.INCIDENT_FOUNDER_APPROVER_EMAILS;
  } else {
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = FOUNDER_APPROVER_ENV;
  }
  if (typeof ADMIN_APPROVER_FALLBACK_ENV === "undefined") {
    delete process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK;
  } else {
    process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK = ADMIN_APPROVER_FALLBACK_ENV;
  }
  if (typeof NODE_ENV_BACKUP === "undefined") {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = NODE_ENV_BACKUP;
  }
  if (typeof ENABLE_CSRF_BACKUP === "undefined") {
    delete process.env.ENABLE_CSRF;
  } else {
    process.env.ENABLE_CSRF = ENABLE_CSRF_BACKUP;
  }
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  delete process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK;
  delete process.env.INCIDENT_FOUNDER_APPROVER_EMAILS;
  delete process.env.ENABLE_CSRF;
  process.env.NODE_ENV = "test";
});

describe("Incident admin read routes", () => {
  test("require admin authentication", async () => {
    const res = await request(app).get("/api/admin/incidents");
    expect(res.status).toBe(401);
  });

  test("list endpoint returns incident summaries and pagination", async () => {
    const admin = await createAdmin();
    await seedIncidentGraph();

    const res = await request(app)
      .get("/api/admin/incidents?riskLevel=medium&limit=5")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toEqual(
      expect.objectContaining({
        publicId: expect.stringMatching(/^INC-/),
        state: expect.any(String),
        classification: expect.objectContaining({ riskLevel: "medium" }),
      })
    );
  });

  test("detail route hydrates the latest investigation, patch, verification, release, and approval", async () => {
    const admin = await createAdmin();
    const { incident } = await seedIncidentGraph();

    const res = await request(app)
      .get(`/api/admin/incidents/${incident.publicId}`)
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.incident.publicId).toBe(incident.publicId);
    expect(res.body.latestInvestigation.rootCauseSummary).toMatch(/Click handler detached/i);
    expect(res.body.latestPatch.patchSummary).toMatch(/Re-bound/i);
    expect(res.body.latestVerification.status).toBe("failed");
    expect(res.body.latestRelease.status).toBe("preview_failed");
    expect(res.body.latestRelease.previewVerificationStatus).toBe("failed");
    expect(res.body.latestRelease.previewVerificationChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "preview_health", status: "failed" }),
      ])
    );
    expect(res.body.latestRelease.rollbackTargetValidationStatus).toBe("blocked");
    expect(res.body.latestRelease.rollbackTargetValidationChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "rollback_target_history", status: "blocked" }),
      ])
    );
    expect(res.body.latestReleaseArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactType: "preview_url" }),
        expect.objectContaining({ artifactType: "coverage_summary" }),
      ])
    );
    expect(res.body.latestApproval.status).toBe("pending");
    expect(res.body.latestNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateKey: "investigating",
          status: "sent",
          bodyPreview: "We validated your report and started technical investigation.",
        }),
      ])
    );
  });

  test("timeline route returns events in chronological order", async () => {
    const admin = await createAdmin();
    const { incident } = await seedIncidentGraph();

    const res = await request(app)
      .get(`/api/admin/incidents/${incident._id}/timeline`)
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].seq).toBe(1);
    expect(res.body.events[1].seq).toBe(2);
  });

  test("verification and release routes return the latest records", async () => {
    const admin = await createAdmin();
    const { incident } = await seedIncidentGraph();

    const verificationRes = await request(app)
      .get(`/api/admin/incidents/${incident.publicId}/verification`)
      .set("Cookie", authCookieFor(admin));
    expect(verificationRes.status).toBe(200);
    expect(verificationRes.body.verification.failedCheckKeys).toEqual(["ui_flow"]);

    const releaseRes = await request(app)
      .get(`/api/admin/incidents/${incident.publicId}/release`)
      .set("Cookie", authCookieFor(admin));
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.release.previewDeployId).toBe("srv-preview-123");
  });

  test("cluster route returns grouped repeated issues", async () => {
    const admin = await createAdmin();
    await seedIncidentGraph();

    const res = await request(app)
      .get("/api/admin/incidents/clusters?windowHours=720")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clusterKey: "hire-button-case-detail",
          count: 2,
        }),
      ])
    );
  });

  test("approval decision route records an approval grant and queues deployment", async () => {
    const admin = await createAdmin();
    const { incident, approval } = await seedAwaitingApprovalIncident();
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = admin.email;

    const res = await request(app)
      .post(`/api/admin/incidents/${incident.publicId}/approvals/${approval._id}/decision`)
      .set("Cookie", authCookieFor(admin))
      .send({ decision: "approve", note: "Approved for production continuation." });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.approval.status).toBe("approved");
    expect(res.body.approval.decisionNote).toBe("Approved for production continuation.");
    expect(res.body.incident.approvalState).toBe("approved");
    expect(res.body.incident.state).toBe("verified_release_candidate");
    expect(res.body.incident.orchestration.nextJobType).toBe("deployment");
    expect(res.body.release.status).toBe("queued");

    const event = await IncidentEvent.findOne({
      incidentId: incident._id,
      eventType: "approval_granted",
    }).lean();
    expect(event).toEqual(
      expect.objectContaining({
        summary: expect.stringMatching(/approval granted/i),
      })
    );
  });

  test("approval decision route records a rejection and closes the release candidate truthfully", async () => {
    const admin = await createAdmin();
    const { incident, approval } = await seedAwaitingApprovalIncident();
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = admin.email;

    const res = await request(app)
      .post(`/api/admin/incidents/${incident.publicId}/approvals/${approval._id}/decision`)
      .set("Cookie", authCookieFor(admin))
      .send({ decision: "reject", note: "Do not ship this auth patch yet." });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.approval.status).toBe("rejected");
    expect(res.body.incident.state).toBe("needs_human_owner");
    expect(res.body.incident.userVisibleStatus).toBe("awaiting_internal_review");
    expect(res.body.incident.approvalState).toBe("rejected");

    const event = await IncidentEvent.findOne({
      incidentId: incident._id,
      eventType: "approval_rejected",
    }).lean();
    expect(event).toEqual(
      expect.objectContaining({
        summary: expect.stringMatching(/approval rejected/i),
      })
    );
  });

  test("approval decision route denies admin fallback unless explicitly enabled", async () => {
    const admin = await createAdmin();
    const { incident, approval } = await seedAwaitingApprovalIncident();

    const res = await request(app)
      .post(`/api/admin/incidents/${incident.publicId}/approvals/${approval._id}/decision`)
      .set("Cookie", authCookieFor(admin))
      .send({ decision: "approve", note: "Approved for production continuation." });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/founder approval access/i);
  });

  test("approval decision route does not allow admin fallback in production runtime even when explicitly enabled", async () => {
    const admin = await createAdmin();
    const { incident, approval } = await seedAwaitingApprovalIncident();
    process.env.NODE_ENV = "production";
    process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK = "true";

    const res = await request(app)
      .post(`/api/admin/incidents/${incident.publicId}/approvals/${approval._id}/decision`)
      .set("Cookie", authCookieFor(admin))
      .send({ decision: "approve", note: "Should still be denied in production runtime." });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/founder approval access/i);
  });

  test("detail route deprecates legacy preview_passed release status instead of exposing it as verified", async () => {
    const admin = await createAdmin();
    const { incident, release } = await seedIncidentGraph();
    await IncidentRelease.updateOne(
      { _id: release._id },
      {
        $set: {
          status: "preview_passed",
          previewVerificationStatus: "passed",
          previewVerificationSummary: "Legacy preview pass value.",
          previewVerificationChecks: [],
        },
      }
    );

    const res = await request(app)
      .get(`/api/admin/incidents/${incident.publicId}`)
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.latestRelease.status).toBe("preview_blocked");
    expect(res.body.latestRelease.previewVerificationStatus).toBe("blocked");
    expect(res.body.latestRelease.previewVerificationChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "legacy_preview_status", status: "blocked" }),
      ])
    );
  });

  test("approval decision route is blocked without a valid CSRF token when CSRF protection is enabled", async () => {
    process.env.ENABLE_CSRF = "true";
    const csrfApp = buildIncidentAdminApp({ withCsrfHarness: true });
    const agent = request.agent(csrfApp);
    const admin = await createAdmin();
    const { incident, approval } = await seedAwaitingApprovalIncident();
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = admin.email;

    const csrfRes = await agent.get("/api/csrf");
    expect(csrfRes.status).toBe(200);

    const res = await agent
      .post(`/api/admin/incidents/${incident.publicId}/approvals/${approval._id}/decision`)
      .set("Cookie", authCookieFor(admin))
      .send({ decision: "approve", note: "Missing CSRF token should block this write." });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  test("approval decision route allows valid auth plus CSRF protection", async () => {
    process.env.ENABLE_CSRF = "true";
    const csrfApp = buildIncidentAdminApp({ withCsrfHarness: true });
    const admin = await createAdmin();
    const { incident, approval } = await seedAwaitingApprovalIncident();
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = admin.email;

    const csrfRes = await request(csrfApp).get("/api/csrf");
    expect(csrfRes.status).toBe(200);
    const csrfToken = csrfRes.body.csrfToken;
    const csrfCookie = (csrfRes.headers["set-cookie"] || []).find((cookie) => cookie.startsWith("_csrf="));

    const res = await request(csrfApp)
      .post(`/api/admin/incidents/${incident.publicId}/approvals/${approval._id}/decision`)
      .set("Cookie", [authCookieFor(admin), csrfCookie].filter(Boolean))
      .set("x-csrf-token", csrfToken)
      .send({ decision: "approve", note: "Approved with valid CSRF token." });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.approval.status).toBe("approved");
    expect(res.body.incident.state).toBe("verified_release_candidate");
  });

  test("approval decision route still denies non-founder approvers even with a valid CSRF token", async () => {
    process.env.ENABLE_CSRF = "true";
    const csrfApp = buildIncidentAdminApp({ withCsrfHarness: true });
    const admin = await createAdmin();
    const { incident, approval } = await seedAwaitingApprovalIncident();

    const csrfRes = await request(csrfApp).get("/api/csrf");
    expect(csrfRes.status).toBe(200);
    const csrfCookie = (csrfRes.headers["set-cookie"] || []).find((cookie) => cookie.startsWith("_csrf="));

    const res = await request(csrfApp)
      .post(`/api/admin/incidents/${incident.publicId}/approvals/${approval._id}/decision`)
      .set("Cookie", [authCookieFor(admin), csrfCookie].filter(Boolean))
      .set("x-csrf-token", csrfRes.body.csrfToken)
      .send({ decision: "approve", note: "CSRF token should not bypass founder approver checks." });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/founder approval access/i);
  });
});
