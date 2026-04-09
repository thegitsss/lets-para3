const fs = require("fs");
const os = require("os");
const path = require("path");

const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentNotification = require("../models/IncidentNotification");
const { createIncidentFromHelpReport } = require("../services/incidents/intakeService");
const {
  claimNextIncidentJob,
  runIncidentSchedulerOnce,
  stopIncidentScheduler,
} = require("../scheduler/incidentScheduler");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

let emailCounter = 0;

async function createUser(role) {
  emailCounter += 1;
  return User.create({
    firstName: role === "paralegal" ? "Parker" : "Alex",
    lastName: "Scheduler",
    email: `${role}.${emailCounter}@incident-scheduler.test`,
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

describe("Incident scheduler workflow", () => {
  test("automates reported -> intake_validated -> classified and schedules investigation", async () => {
    const attorney = await createUser("attorney");
    const created = await createHelpIncident(attorney);

    const run = await runIncidentSchedulerOnce({ maxJobs: 2, workerId: "jest:incident-scheduler" });
    expect(run.ok).toBe(true);
    expect(run.processed).toBe(2);

    const incident = await Incident.findOne({ publicId: created.incident.publicId }).lean();
    const events = await IncidentEvent.find({ incidentId: incident._id }).sort({ seq: 1 }).lean();
    const notifications = await IncidentNotification.find({ incidentId: incident._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    expect(incident.state).toBe("classified");
    expect(incident.userVisibleStatus).toBe("investigating");
    expect(incident.adminVisibleStatus).toBe("active");
    expect(incident.orchestration.nextJobType).toBe("investigation");
    expect(incident.orchestration.lockToken).toBe("");
    expect(incident.orchestration.lockExpiresAt).toBeNull();
    expect(incident.orchestration.stageAttempts.intakeValidation).toBe(1);
    expect(incident.orchestration.stageAttempts.classification).toBe(1);
    expect(incident.classification.domain).toBe("matching");
    expect(incident.classification.severity).toBe("medium");
    expect(incident.classification.riskLevel).toBe("low");
    expect(incident.classification.confidence).toBe("high");
    expect(incident.classification.issueFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(incident.classification.clusterKey).toMatch(/case-detail/);
    expect(incident.autonomyMode).toBe("full_auto");
    expect(incident.approvalState).toBe("not_needed");

    expect(events.map((event) => event.eventType)).toEqual([
      "state_changed",
      "cluster_linked",
      "state_changed",
      "classification_written",
      "state_changed",
    ]);
    expect(events[2]).toEqual(
      expect.objectContaining({
        fromState: "reported",
        toState: "intake_validated",
      })
    );
    expect(events[4]).toEqual(
      expect.objectContaining({
        fromState: "intake_validated",
        toState: "classified",
      })
    );
    expect(notifications.map((notification) => notification.templateKey)).toEqual([
      "received",
      "investigating",
    ]);
  });

  test("low-signal reports move to needs_more_context during intake validation", async () => {
    const attorney = await createUser("attorney");
    const created = await createHelpIncident(attorney, {
      summary: "test",
      description: "asdf",
      featureKey: "",
    });

    const run = await runIncidentSchedulerOnce({ maxJobs: 1, workerId: "jest:incident-scheduler" });
    expect(run.processed).toBe(1);

    const incident = await Incident.findOne({ publicId: created.incident.publicId }).lean();
    const notifications = await IncidentNotification.find({ incidentId: incident._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    expect(incident.state).toBe("needs_more_context");
    expect(incident.userVisibleStatus).toBe("needs_more_info");
    expect(incident.adminVisibleStatus).toBe("active");
    expect(incident.orchestration.nextJobType).toBe("none");
    expect(incident.orchestration.stageAttempts.intakeValidation).toBe(1);
    expect(notifications.map((notification) => notification.templateKey)).toEqual([
      "received",
      "needs_more_info",
    ]);
  });

  test("duplicate reports from the same reporter close as duplicates during intake validation", async () => {
    const attorney = await createUser("attorney");
    const first = await createHelpIncident(attorney);
    await runIncidentSchedulerOnce({ maxJobs: 2, workerId: "jest:incident-scheduler" });

    const second = await createHelpIncident(attorney);
    await runIncidentSchedulerOnce({ maxJobs: 1, workerId: "jest:incident-scheduler" });

    const original = await Incident.findOne({ publicId: first.incident.publicId }).lean();
    const duplicate = await Incident.findOne({ publicId: second.incident.publicId }).lean();

    expect(original.state).toBe("classified");
    expect(duplicate.state).toBe("closed_duplicate");
    expect(String(duplicate.duplicateOfIncidentId)).toBe(String(original._id));
    expect(duplicate.userVisibleStatus).toBe("closed");
    expect(duplicate.adminVisibleStatus).toBe("closed");
    expect(duplicate.resolution.code).toBe("duplicate");
    expect(duplicate.orchestration.nextJobType).toBe("none");
  });

  test("similar reports from different users share a cluster and repeated volume raises risk", async () => {
    const attorneyOne = await createUser("attorney");
    const attorneyTwo = await createUser("attorney");
    const attorneyThree = await createUser("attorney");

    const first = await createHelpIncident(attorneyOne);
    const second = await createHelpIncident(attorneyTwo);
    const third = await createHelpIncident(attorneyThree);

    await runIncidentSchedulerOnce({ maxJobs: 6, workerId: "jest:incident-scheduler" });

    const incidents = await Incident.find({
      publicId: {
        $in: [first.incident.publicId, second.incident.publicId, third.incident.publicId],
      },
    })
      .sort({ createdAt: 1 })
      .lean();

    const clusterKeys = new Set(incidents.map((incident) => incident.classification.clusterKey));
    const riskLevels = incidents.map((incident) => incident.classification.riskLevel).sort();
    expect(clusterKeys.size).toBe(1);
    expect(riskLevels).toEqual(["medium", "medium", "medium"]);
    expect(incidents.every((incident) => incident.autonomyMode === "full_auto")).toBe(true);
    expect(incidents.every((incident) => incident.approvalState === "not_needed")).toBe(true);
  });

  test("high-risk payment incidents receive high risk, approval-required autonomy, and pending approval", async () => {
    const paralegal = await createUser("paralegal");
    const created = await createHelpIncident(paralegal, {
      summary: "Stripe payout failed after withdrawal review",
      description: "My payout is blocked after a withdrawal review and the Stripe release is missing.",
      pageUrl: "https://www.lets-paraconnect.com/dashboard-paralegal.html#billing",
      routePath: "/api/payments/payouts",
      featureKey: "payout-status",
    });

    await runIncidentSchedulerOnce({ maxJobs: 2, workerId: "jest:incident-scheduler" });

    const incident = await Incident.findOne({ publicId: created.incident.publicId }).lean();
    const events = await IncidentEvent.find({ incidentId: incident._id }).sort({ seq: 1 }).lean();

    expect(incident.state).toBe("classified");
    expect(incident.classification.domain).toBe("payouts");
    expect(incident.classification.riskLevel).toBe("high");
    expect(incident.classification.severity).toBe("critical");
    expect(incident.classification.confidence).toBe("high");
    expect(incident.classification.riskFlags).toEqual(
      expect.objectContaining({
        affectsMoney: true,
        affectsWithdrawals: true,
      })
    );
    expect(incident.autonomyMode).toBe("approval_required");
    expect(incident.approvalState).toBe("pending");
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["classification_written", "risk_reclassified"])
    );
  });

  test("scheduler can carry a trusted preferences-save incident through autonomous local resolution", async () => {
    const previousWorkspaceRoot = process.env.INCIDENT_WORKSPACE_SYNC_ROOT;
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "incident-scheduler-workspace-sync-"));
    process.env.INCIDENT_WORKSPACE_SYNC_ROOT = workspaceRoot;

    try {
      const paralegal = await createUser("paralegal");
      const created = await createHelpIncident(paralegal, {
        summary: "Save preferences button does nothing on settings",
        description: "The save preferences button does nothing and the change is not preserved.",
        pageUrl: "https://www.lets-paraconnect.com/settings",
        routePath: "/settings",
        featureKey: "save-preferences",
      });

      const run = await runIncidentSchedulerOnce({ maxJobs: 7, workerId: "jest:incident-scheduler" });
      expect(run.ok).toBe(true);
      expect(run.processed).toBe(7);

      const incident = await Incident.findOne({ publicId: created.incident.publicId }).lean();
      const syncedSource = fs.readFileSync(
        path.join(workspaceRoot, "frontend/assets/scripts/profile-settings.js"),
        "utf8"
      );

      expect(incident.state).toBe("resolved");
      expect(incident.userVisibleStatus).toBe("fixed_live");
      expect(incident.adminVisibleStatus).toBe("resolved");
      expect(incident.resolution.code).toBe("fixed_deployed");
      expect(incident.orchestration.nextJobType).toBe("none");
      expect(syncedSource).toContain('fetch("/api/account/preferences", {');
      expect(syncedSource).not.toContain("intentional preferences save regression marker");
    } finally {
      if (typeof previousWorkspaceRoot === "undefined") {
        delete process.env.INCIDENT_WORKSPACE_SYNC_ROOT;
      } else {
        process.env.INCIDENT_WORKSPACE_SYNC_ROOT = previousWorkspaceRoot;
      }
    }
  });

  test("claim/lock prevents the same due incident from being claimed twice before processing", async () => {
    const attorney = await createUser("attorney");
    await createHelpIncident(attorney);

    const firstClaim = await claimNextIncidentJob({ workerId: "jest:lock-1" });
    const secondClaim = await claimNextIncidentJob({ workerId: "jest:lock-2" });

    expect(firstClaim).toEqual(
      expect.objectContaining({
        jobType: "intake_validation",
      })
    );
    expect(secondClaim).toBeNull();
  });
});
