const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

const User = require("../models/User");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const casesRouter = require("../routes/cases");
const { buildCaseFileKeyQuery } = require("../utils/dataEncryption");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
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

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Data integrity + idempotency", () => {
  test("Duplicate file attach is idempotent", async () => {
    // Description: Attaching the same case file twice should not create duplicates.
    // Input values: same key twice.
    // Expected result: first 201, second 200, only one CaseFile record exists.

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
      details: "Idempotency test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const key = `cases/${caseDoc._id}/documents/duplicate.pdf`;

    const res1 = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(attorney))
      .send({ key, original: "duplicate.pdf", mime: "application/pdf", size: 1234 });
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(attorney))
      .send({ key, original: "duplicate.pdf", mime: "application/pdf", size: 1234 });
    expect(res2.status).toBe(200);

    const count = await CaseFile.countDocuments(
      buildCaseFileKeyQuery({ caseId: caseDoc._id, storageKey: key })
    );
    expect(count).toBe(1);
  });
});
