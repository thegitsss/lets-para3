const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

const User = require("../models/User");
const Case = require("../models/Case");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

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

function buildCasesApp(router, { handleCsrf = false } = {}) {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", router);
  instance.use((err, _req, res, _next) => {
    if (handleCsrf && err?.code === "EBADCSRFTOKEN") {
      return res.status(403).json({ error: "Invalid CSRF token" });
    }
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return instance;
}

function buildAdminApp(router) {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin", router);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return instance;
}

function loadCasesRouter() {
  const casesPath = require.resolve("../routes/cases");
  delete require.cache[casesPath];
  return require("../routes/cases");
}

function loadAdminRouter() {
  const adminPath = require.resolve("../routes/admin");
  delete require.cache[adminPath];
  return require("../routes/admin");
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

describe("Security edge cases", () => {
  test("Invalid JWT is rejected", async () => {
    // Description: Request with tampered JWT is rejected.
    // Input values: Cookie token="invalid".
    // Expected result: 403 Invalid token.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "Security test case details.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const app = buildCasesApp(loadCasesRouter());

    const res = await request(app)
      .patch(`/api/cases/${caseDoc._id}/archive`)
      .set("Cookie", "token=invalid")
      .send({ archived: true });

    expect(res.status).toBe(403);
    expect(res.body.msg || res.body.error).toMatch(/Invalid token/i);
  });

  test("Non-admin cannot access admin routes", async () => {
    // Description: Attorney attempts admin-only case status update.
    // Input values: role="attorney" for /api/admin/cases/:id/status.
    // Expected result: 403 Forbidden.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone2@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Contract review",
      details: "Admin ACL test case details.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const app = buildAdminApp(loadAdminRouter());

    const res = await request(app)
      .patch(`/api/admin/cases/${caseDoc._id}/status`)
      .set("Cookie", authCookieFor(attorney))
      .send({ status: "assigned" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Forbidden/i);
  });

  test("CSRF token required when enabled", async () => {
    // Description: CSRF protection blocks state-changing request without token.
    // Input values: CSRF cookie present, missing CSRF token.
    // Expected result: 403 Invalid CSRF token.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone3@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "CSRF test",
      details: "CSRF protection test case details.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const csrf = require("csurf");
    const csrfProtection = csrf({
      cookie: { httpOnly: true, sameSite: "strict", secure: true },
    });

    const csrfApp = express();
    csrfApp.set("trust proxy", 1);
    csrfApp.use(cookieParser());
    csrfApp.use(express.json({ limit: "1mb" }));
    csrfApp.get("/api/csrf", csrfProtection, (req, res) => {
      res.json({ csrfToken: req.csrfToken() });
    });
    csrfApp.use(csrfProtection);
    csrfApp.use("/api/cases", loadCasesRouter());
    csrfApp.use((err, _req, res, _next) => {
      if (err?.code === "EBADCSRFTOKEN") {
        return res.status(403).json({ error: "Invalid CSRF token" });
      }
      console.error(err);
      res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
    });

    const tokenRes = await request(csrfApp)
      .get("/api/csrf")
      .set("X-Forwarded-Proto", "https");
    const csrfCookie = (tokenRes.headers["set-cookie"] || []).find((c) => c.startsWith("_csrf="));

    const res = await request(csrfApp)
      .patch(`/api/cases/${caseDoc._id}/archive`)
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", [authCookieFor(attorney), csrfCookie].filter(Boolean))
      .send({ archived: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/i);
  });
});
