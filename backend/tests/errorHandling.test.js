const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../utils/stripe", () => ({
  paymentIntents: { create: jest.fn(), retrieve: jest.fn() },
  customers: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() },
  paymentMethods: { retrieve: jest.fn(), attach: jest.fn() },
  setupIntents: { create: jest.fn() },
  accounts: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  isTransferablePaymentIntent: jest.fn(() => ({
    transferable: true,
    charge: { receipt_url: "https://stripe.test/receipt" },
  })),
  getPaymentIntentCharge: jest.fn(() => ({ receipt_url: "https://stripe.test/receipt" })),
}));

const authRouter = require("../routes/auth");
const casesRouter = require("../routes/cases");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/auth", authRouter);
  instance.use("/api/cases", casesRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return instance;
})();

function authCookieFor(payload) {
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
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

describe("Error handling", () => {
  test("Backend returns 400 for invalid login request", async () => {
    // Description: Missing password during login.
    // Input values: email="bad@example.com", password missing.
    // Expected result: 400 Bad Request with msg about invalid credentials.

    const res = await request(app).post("/api/auth/login").send({ email: "bad@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/invalid credentials/i);
  });

  test("Backend returns 401 for unauthenticated case post", async () => {
    // Description: Create case without authentication.
    // Input values: minimal case payload without cookie.
    // Expected result: 401 Not authenticated.

    const res = await request(app).post("/api/cases").send({
      title: "Test Case",
      practiceArea: "immigration",
      description: "A short description that meets length requirements.",
      totalAmount: 400,
      state: "CA",
    });
    expect(res.status).toBe(401);
    expect(res.body.message || res.body.msg).toMatch(/not authenticated/i);
  });

  test("Backend returns 400 for invalid case payload", async () => {
    // Description: Admin submits an invalid case (missing title/description).
    // Input values: admin auth cookie, empty payload.
    // Expected result: 400 Bad Request with validation error.

    const adminCookie = authCookieFor({
      id: "507f1f77bcf86cd799439011",
      role: "admin",
      email: "owner@lets-paraconnect.com",
      status: "approved",
    });

    const res = await request(app)
      .post("/api/cases")
      .set("Cookie", adminCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title and a short description are required/i);
  });
});
