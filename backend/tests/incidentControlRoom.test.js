const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Incident = require("../models/Incident");
const aiAdminRouter = require("../routes/aiAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/ai", aiAdminRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

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
    email: "control-room-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
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

describe("AI Control Room incident focus", () => {
  test("summary route omits fake outbound drafts and exposes engineering as unavailable", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.outboundMessages).toEqual([]);
    expect(res.body.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "cto",
          status: "HEALTHY",
          recommendation: expect.stringMatching(/no engineering work/i),
        }),
      ])
    );
  });

  test("returns an empty-state incident view when no incidents exist", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get("/api/admin/ai/control-room/incidents")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.view.title).toBe("Incident Control Room");
    expect(res.body.view.status).toBe("Healthy");
    expect(res.body.view.primary.body).toMatch(/No incidents are currently visible/i);
  });

  test("surfaces live incident counts and repeated clusters", async () => {
    const admin = await createAdmin();

    await Incident.create([
      {
        publicId: "INC-20260319-100001",
        source: "system_monitor",
        summary: "Hire button stopped opening the modal.",
        originalReportText: "The hire button stopped opening the modal for attorneys.",
        state: "investigating",
        classification: {
          domain: "ui",
          severity: "medium",
          riskLevel: "medium",
          confidence: "high",
          clusterKey: "hire-button-case-detail",
        },
        context: { surface: "attorney", routePath: "/cases/:id" },
      },
      {
        publicId: "INC-20260319-100002",
        source: "help_form",
        summary: "Another report of the same hire button issue.",
        originalReportText: "Same issue on a different matter.",
        state: "patch_planning",
        classification: {
          domain: "ui",
          severity: "medium",
          riskLevel: "medium",
          confidence: "medium",
          clusterKey: "hire-button-case-detail",
        },
        context: { surface: "attorney", routePath: "/cases/:id" },
      },
      {
        publicId: "INC-20260319-100003",
        source: "admin_created",
        summary: "Payout delay needs approval review.",
        originalReportText: "Possible payout delay requires founder visibility.",
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
      },
    ]);

    const res = await request(app)
      .get("/api/admin/ai/control-room/incidents")
      .set("Cookie", authCookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.view.status).toBe("Priority");
    expect(res.body.view.secondary.items).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/3 incidents are currently active/i),
        expect.stringMatching(/1 incident is currently paused/i),
      ])
    );
    expect(res.body.view.quaternary.items).toEqual(
      expect.arrayContaining([expect.stringMatching(/hire-button-case-detail/i)])
    );
  });
});
