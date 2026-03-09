const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

const User = require("../models/User");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
const messagesRouter = require("../routes/messages");
const casesRouter = require("../routes/cases");
const disputesRouter = require("../routes/disputes");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/messages", messagesRouter);
  instance.use("/api/cases", casesRouter);
  instance.use("/api/disputes", disputesRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
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

async function seedFundedCase({ attorney, paralegal }) {
  return Case.create({
    title: "Audit coverage case",
    practiceArea: "immigration",
    details: "Case details for audit coverage tests.",
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal._id,
    paralegalId: paralegal._id,
    status: "in progress",
    escrowStatus: "funded",
    escrowIntentId: "pi_audit_cov_123",
    totalAmount: 60000,
    currency: "usd",
    tasks: [{ title: "Prepare filing", completed: false }],
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

describe("Audit coverage: messages, documents, disputes", () => {
  test("Message send writes message_sent audit log", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.audit@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.audit@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const res = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Audit coverage message" });

    expect(res.status).toBe(201);

    const log = await AuditLog.findOne({
      action: "message_sent",
      targetId: String(caseDoc._id),
    }).lean();

    expect(log).toBeTruthy();
    expect(log.targetType).toBe("case");
    expect(String(log.actor)).toBe(String(paralegal._id));
  });

  test("Document attach writes case.file.attach audit log", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.audit.docs@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.audit.docs@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });
    const key = `cases/${caseDoc._id}/documents/audit-coverage.pdf`;

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(attorney))
      .send({
        key,
        original: "audit-coverage.pdf",
        mime: "application/pdf",
        size: 1024,
      });

    expect([200, 201]).toContain(res.status);

    const log = await AuditLog.findOne({
      action: "case.file.attach",
      targetId: String(caseDoc._id),
    }).lean();

    expect(log).toBeTruthy();
    expect(log.targetType).toBe("case");
    expect(log.meta?.key).toBe(key);
    expect(String(log.actor)).toBe(String(attorney._id));
  });

  test("Dispute create writes dispute.create audit log", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.audit.disputes@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.audit.disputes@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const res = await request(app)
      .post(`/api/disputes/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ message: "Need review on scope quality.", amount: 250 });

    expect(res.status).toBe(201);

    const log = await AuditLog.findOne({
      action: "dispute.create",
      case: caseDoc._id,
    }).lean();

    expect(log).toBeTruthy();
    expect(log.targetType).toBe("case");
    expect(String(log.actor)).toBe(String(attorney._id));
    expect(String(log.case)).toBe(String(caseDoc._id));
  });
});
