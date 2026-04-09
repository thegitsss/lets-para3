process.env.JWT_SECRET = process.env.JWT_SECRET || "incident-route-test-secret";

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");

const User = require("../models/User");
const Incident = require("../models/Incident");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentArtifact = require("../models/IncidentArtifact");
const IncidentNotification = require("../models/IncidentNotification");
const Notification = require("../models/Notification");
const incidentsRouter = require("../routes/incidents");
const { INCIDENT_ACCESS_TOKEN_HEADER } = require("../utils/incidentAccess");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/incidents", incidentsRouter);
  instance.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      error: err?.message || "Server error",
      ...(err?.fields ? { fields: err.fields } : {}),
    });
  });
  return instance;
})();

function authCookieFor(user) {
  const payload = {
    id: String(user._id),
    role: user.role,
    email: user.email,
    status: user.status,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

let emailCounter = 0;

async function createUser(role) {
  emailCounter += 1;
  return User.create({
    firstName: role === "paralegal" ? "Parker" : "Alex",
    lastName: "Reporter",
    email: `${role}.${emailCounter}@incident-routes.test`,
    password: "Password123!",
    role,
    status: "approved",
    state: "CA",
  });
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Incident intake routes", () => {
  test("reject unauthenticated intake requests", async () => {
    const res = await request(app).post("/api/incidents").send({
      summary: "Hire button is not working",
      description: "The hire button does nothing.",
    });

    expect(res.status).toBe(401);
  });

  test("reject admin intake requests outside the signed-in attorney/paralegal scope", async () => {
    const admin = await createUser("admin");

    const res = await request(app)
      .post("/api/incidents")
      .set("Cookie", authCookieFor(admin))
      .send({
        summary: "Admin trying to report through help intake",
        description: "This should stay limited to attorney/paralegal help in Phase 3.",
      });

    expect(res.status).toBe(403);
  });

  test("create an incident, initial event, and both intake artifacts for an attorney report", async () => {
    const attorney = await createUser("attorney");
    const caseId = new mongoose.Types.ObjectId();
    const jobId = new mongoose.Types.ObjectId();
    const applicationId = new mongoose.Types.ObjectId();

    const res = await request(app)
      .post("/api/incidents")
      .set("Cookie", authCookieFor(attorney))
      .send({
        summary: "Hire button is not working on case detail",
        description: "I click Hire and nothing happens on the workspace page.",
        pageUrl: "https://www.lets-paraconnect.com/case-detail.html?id=123",
        routePath: "/case-detail.html",
        featureKey: "hire-button",
        caseId: String(caseId),
        jobId: String(jobId),
        applicationId: String(applicationId),
        diagnostics: {
          browserName: "Chrome",
          deviceType: "desktop",
          viewport: { width: 1440, height: 900 },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.incident).toEqual(
      expect.objectContaining({
        publicId: expect.stringMatching(/^INC-\d{8}-\d{6}$/),
        state: "reported",
        userVisibleStatus: "received",
        summary: "Hire button is not working on case detail",
      })
    );
    expect(typeof res.body.reporterAccessToken).toBe("string");
    expect(res.body.reporterAccessToken).toHaveLength(48);

    const incident = await Incident.findOne({ publicId: res.body.incident.publicId }).lean();
    const events = await IncidentEvent.find({ incidentId: incident._id }).sort({ seq: 1 }).lean();
    const artifacts = await IncidentArtifact.find({ incidentId: incident._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const incidentNotifications = await IncidentNotification.find({ incidentId: incident._id }).lean();
    const appNotifications = await Notification.find({ userId: attorney._id }).lean();

    expect(incident.reporter.role).toBe("attorney");
    expect(String(incident.reporter.userId)).toBe(String(attorney._id));
    expect(incident.reporter.accessTokenHash).toBeTruthy();
    expect(incident.reporter.accessTokenHash).not.toBe(res.body.reporterAccessToken);
    expect(incident.reporter.accessTokenIssuedAt).toBeTruthy();
    expect(incident.context.surface).toBe("attorney");
    expect(incident.context.pageUrl).toBe("https://www.lets-paraconnect.com/case-detail.html?id=123");
    expect(incident.context.routePath).toBe("/case-detail.html");
    expect(incident.context.featureKey).toBe("hire-button");
    expect(String(incident.context.caseId)).toBe(String(caseId));
    expect(String(incident.context.jobId)).toBe(String(jobId));
    expect(String(incident.context.applicationId)).toBe(String(applicationId));
    expect(incident.context.browser).toBe("Chrome");
    expect(incident.context.device).toBe("desktop");
    expect(incident.userVisibleStatus).toBe("received");
    expect(incident.adminVisibleStatus).toBe("new");
    expect(incident.orchestration.nextJobType).toBe("intake_validation");
    expect(incident.lastEventSeq).toBe(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        seq: 1,
        eventType: "state_changed",
        summary: "We received your report.",
        toState: "reported",
      })
    );
    expect(events[0].artifactIds).toHaveLength(2);

    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.artifactType).sort()).toEqual([
      "browser_diagnostics",
      "user_report",
    ]);
    expect(artifacts.every((artifact) => artifact.stage === "intake")).toBe(true);
    expect(incidentNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          audience: "reporter",
          channel: "in_app",
          templateKey: "received",
          status: "sent",
        }),
      ])
    );
    expect(appNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "incident_update",
          message: "We received your report and logged it for review.",
        }),
      ])
    );
  });

  test("paralegal intake works without diagnostics and keeps reporter-safe access via token", async () => {
    const paralegal = await createUser("paralegal");

    const createRes = await request(app)
      .post("/api/incidents")
      .set("Cookie", authCookieFor(paralegal))
      .send({
        summary: "Application screen froze after submit",
        description: "The application screen froze after I pressed submit once.",
        pageUrl: "https://www.lets-paraconnect.com/paralegalhelp.html",
      });

    expect(createRes.status).toBe(201);

    const incident = await Incident.findOne({ publicId: createRes.body.incident.publicId }).lean();
    const artifacts = await IncidentArtifact.find({ incidentId: incident._id }).lean();

    expect(incident.reporter.role).toBe("paralegal");
    expect(incident.context.surface).toBe("paralegal");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactType).toBe("user_report");

    const statusRes = await request(app)
      .get(`/api/incidents/${incident.publicId}`)
      .set(INCIDENT_ACCESS_TOKEN_HEADER, createRes.body.reporterAccessToken);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.ok).toBe(true);
    expect(statusRes.body.incident).toEqual(
      expect.objectContaining({
        publicId: incident.publicId,
        state: "reported",
        userVisibleStatus: "received",
      })
    );
    expect(statusRes.body.incident.adminVisibleStatus).toBeUndefined();
    expect(statusRes.body.incident.classification).toBeUndefined();
  });

  test("incident reads are limited to the reporter, admin, or a valid reporter access token", async () => {
    const attorney = await createUser("attorney");
    const otherAttorney = await createUser("attorney");
    const admin = await createUser("admin");

    const createRes = await request(app)
      .post("/api/incidents")
      .set("Cookie", authCookieFor(attorney))
      .send({
        summary: "Messages are not loading",
        description: "The workspace message list is blank after refresh.",
      });

    const publicId = createRes.body.incident.publicId;

    const reporterRes = await request(app)
      .get(`/api/incidents/${publicId}`)
      .set("Cookie", authCookieFor(attorney));
    expect(reporterRes.status).toBe(200);

    const otherRes = await request(app)
      .get(`/api/incidents/${publicId}`)
      .set("Cookie", authCookieFor(otherAttorney));
    expect(otherRes.status).toBe(404);

    const adminRes = await request(app)
      .get(`/api/incidents/${publicId}`)
      .set("Cookie", authCookieFor(admin));
    expect(adminRes.status).toBe(200);

    const tokenRes = await request(app)
      .get(`/api/incidents/${publicId}`)
      .set(INCIDENT_ACCESS_TOKEN_HEADER, createRes.body.reporterAccessToken);
    expect(tokenRes.status).toBe(200);
  });

  test("reporter timeline returns only safe state events and excludes internal detail", async () => {
    const attorney = await createUser("attorney");

    const createRes = await request(app)
      .post("/api/incidents")
      .set("Cookie", authCookieFor(attorney))
      .send({
        summary: "Upload button stopped responding",
        description: "The upload button stopped responding in the case workspace.",
      });

    const incident = await Incident.findOne({ publicId: createRes.body.incident.publicId });

    await IncidentEvent.create([
      {
        incidentId: incident._id,
        seq: 2,
        eventType: "state_changed",
        actor: { type: "system" },
        summary: "Investigating frontend/assets/scripts/case-detail.js click handler regression.",
        fromState: "reported",
        toState: "investigating",
        detail: { filePath: "frontend/assets/scripts/case-detail.js" },
      },
      {
        incidentId: incident._id,
        seq: 3,
        eventType: "verification_failed",
        actor: { type: "agent", agentRole: "verifier_agent" },
        summary: "Verification failed in preview.",
        fromState: "awaiting_verification",
        toState: "verification_failed",
        detail: { failedCheck: "ui_flow" },
      },
    ]);

    incident.lastEventSeq = 3;
    incident.state = "investigating";
    incident.userVisibleStatus = "investigating";
    await incident.save();

    const timelineRes = await request(app)
      .get(`/api/incidents/${incident.publicId}/timeline`)
      .set("Cookie", authCookieFor(attorney));

    expect(timelineRes.status).toBe(200);
    expect(timelineRes.body.ok).toBe(true);
    expect(timelineRes.body.events).toHaveLength(2);
    expect(timelineRes.body.events[0]).toEqual(
      expect.objectContaining({
        seq: 1,
        eventType: "state_changed",
        summary: "We received your report.",
      })
    );
    expect(timelineRes.body.events[1]).toEqual(
      expect.objectContaining({
        seq: 2,
        eventType: "state_changed",
        summary: "We’re reviewing your report.",
        toState: "investigating",
      })
    );
    expect(JSON.stringify(timelineRes.body.events)).not.toMatch(/case-detail\.js/i);
    expect(timelineRes.body.events.every((event) => event.detail === undefined)).toBe(true);
    expect(timelineRes.body.events.every((event) => event.artifactIds === undefined)).toBe(true);
  });
});
