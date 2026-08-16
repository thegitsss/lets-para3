const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const authRouter = require("../routes/auth");
const accountRouter = require("../routes/account");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  applyCurrentLegalAcceptance,
  hasCurrentLegalAcceptance,
  serializeLegalAcceptance,
} = require("../utils/legalDocuments");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);
app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error?.message || "Server error" });
});

function authCookie(user) {
  const token = jwt.sign({
    id: String(user._id),
    role: user.role,
    email: user.email,
    status: user.status,
  }, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function approvedUser(overrides = {}) {
  return User.create({
    firstName: "Legal",
    lastName: "Tester",
    email: `legal-${Date.now()}-${Math.random()}@example.com`,
    password: "a sufficiently long test passphrase",
    role: "attorney",
    status: "approved",
    state: "DE",
    emailVerified: true,
    ...overrides,
  });
}

const originalRequireLegalAcceptance = process.env.REQUIRE_LEGAL_ACCEPTANCE;

beforeAll(async () => {
  process.env.REQUIRE_LEGAL_ACCEPTANCE = "true";
  await connect();
});
afterAll(async () => {
  if (typeof originalRequireLegalAcceptance === "undefined") {
    delete process.env.REQUIRE_LEGAL_ACCEPTANCE;
  } else {
    process.env.REQUIRE_LEGAL_ACCEPTANCE = originalRequireLegalAcceptance;
  }
  await closeDatabase();
});
beforeEach(clearDatabase);

describe("versioned legal acceptance", () => {
  test("does not treat a legacy boolean as current acceptance", () => {
    const legacy = { termsAccepted: true };
    expect(hasCurrentLegalAcceptance(legacy)).toBe(false);
    expect(serializeLegalAcceptance(legacy)).toEqual({
      required: true,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
    });
  });

  test("records both versions and timestamps as one explicit event", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const user = {};
    applyCurrentLegalAcceptance(user, { now, source: "signup" });
    expect(user).toMatchObject({
      termsAccepted: true,
      termsVersion: CURRENT_TERMS_VERSION,
      termsAcceptedAt: now,
      privacyVersion: CURRENT_PRIVACY_VERSION,
      privacyAcknowledgedAt: now,
      legalAcceptanceSource: "signup",
    });
    expect(hasCurrentLegalAcceptance(user)).toBe(true);
  });

  test("/me tells legacy users that re-acceptance is required", async () => {
    const user = await approvedUser({ termsAccepted: true });
    const response = await request(app).get("/api/auth/me").set("Cookie", authCookie(user));

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      legalAcceptanceRequired: true,
      legalAcceptance: {
        required: true,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyVersion: CURRENT_PRIVACY_VERSION,
      },
    });
  });

  test("requires two strict, explicit choices", async () => {
    const user = await approvedUser();
    const response = await request(app)
      .post("/api/account/legal-acceptance")
      .set("Cookie", authCookie(user))
      .send({ termsAccepted: "true", privacyAcknowledged: true });

    expect(response.status).toBe(400);
    const refreshed = await User.findById(user._id).lean();
    expect(hasCurrentLegalAcceptance(refreshed)).toBe(false);
  });

  test("server-side authorization blocks protected APIs until acceptance", async () => {
    const user = await approvedUser({ termsAccepted: true });
    const response = await request(app)
      .get("/api/account/preferences")
      .set("Cookie", authCookie(user));

    expect(response.status).toBe(428);
    expect(response.body).toMatchObject({
      code: "LEGAL_ACCEPTANCE_REQUIRED",
      legalAcceptance: { required: true },
    });
  });

  test("persists current acceptance and an audit event idempotently", async () => {
    const user = await approvedUser();
    const cookie = authCookie(user);
    const body = { termsAccepted: true, privacyAcknowledged: true };

    const first = await request(app)
      .post("/api/account/legal-acceptance")
      .set("Cookie", cookie)
      .send(body);
    const second = await request(app)
      .post("/api/account/legal-acceptance")
      .set("Cookie", cookie)
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, legalAcceptanceRequired: false });
    expect(second.status).toBe(200);

    const refreshed = await User.findById(user._id).lean();
    expect(hasCurrentLegalAcceptance(refreshed)).toBe(true);
    expect(refreshed.legalAcceptanceSource).toBe("reacceptance");
    expect(await AuditLog.countDocuments({
      action: "account.legal.accept",
      targetId: user._id,
    })).toBe(1);
  });
});
