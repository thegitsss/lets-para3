const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const FounderDailyLog = require("../models/FounderDailyLog");
const User = require("../models/User");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const {
  FOUNDER_DAILY_LOG_TIMEZONE,
  prepareFounderDailyLogIfDue,
} = require("../services/marketing/founderDailyLogService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "founder-daily-log-service-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
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
    email: "founder-daily-log-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
    status: "approved",
    state: "CA",
  });
}

async function seedKnowledge(admin) {
  const res = await request(app)
    .post("/api/admin/knowledge/sync")
    .set("Cookie", authCookieFor(admin))
    .send({});
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED = "false";
  await clearDatabase();
});

describe("Founder daily log service", () => {
  test("9 AM America/New_York prep waits until due and stores one log for the day", async () => {
    const admin = await createAdmin();
    await seedKnowledge(admin);

    const beforeDue = await prepareFounderDailyLogIfDue({
      now: new Date("2026-03-24T12:30:00.000Z"),
    });

    expect(beforeDue).toEqual(
      expect.objectContaining({
        prepared: false,
        reason: "before_9am",
      })
    );
    expect(await FounderDailyLog.countDocuments({})).toBe(0);

    const afterDue = await prepareFounderDailyLogIfDue({
      now: new Date("2026-03-24T13:05:00.000Z"),
      schedulerState: {
        marketingPublishing: { created: false, reason: "no_due_slot" },
        generatedFromScheduler: true,
      },
    });

    expect(afterDue).toEqual(
      expect.objectContaining({
        prepared: true,
        reason: "prepared",
        log: expect.objectContaining({
          dateKey: "2026-03-24",
          timezone: FOUNDER_DAILY_LOG_TIMEZONE,
          summary: expect.any(String),
          quickActions: expect.any(Array),
          readyPosts: expect.any(Array),
        }),
      })
    );
    expect(afterDue.log.sourceMetadata).toEqual(
      expect.objectContaining({
        generatedFromScheduler: true,
        scheduledReason: "no_due_slot",
      })
    );

    const secondPass = await prepareFounderDailyLogIfDue({
      now: new Date("2026-03-24T15:00:00.000Z"),
    });

    expect(secondPass).toEqual(
      expect.objectContaining({
        prepared: false,
        reason: "already_prepared_today",
      })
    );
    expect(await FounderDailyLog.countDocuments({ dateKey: "2026-03-24" })).toBe(1);
  });
});
