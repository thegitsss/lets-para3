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

describe("Permissions / ACL", () => {
  test("Attorney cannot access another attorney's case files", async () => {
    // Description: Attorney B attempts to attach a file to Attorney A's case.
    // Input values: case owned by attorney A, actor attorney B.
    // Expected result: 404 (hidden).

    const attorneyA = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const attorneyB = await User.create({
      firstName: "Taylor",
      lastName: "Reed",
      email: "taylor.reed@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "ACL test case details.",
      status: "in progress",
      attorney: attorneyA._id,
      attorneyId: attorneyA._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(attorneyB))
      .send({ key: `cases/${caseDoc._id}/documents/a.pdf`, original: "a.pdf", mime: "application/pdf", size: 123 });
    expect([403, 404]).toContain(res.status);
  });

  test("Paralegal access limited to assigned cases", async () => {
    // Description: Paralegal not assigned attempts to attach a file.
    // Input values: case assigned to different paralegal.
    // Expected result: 404 (hidden).

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone2@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const assigned = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const outsider = await User.create({
      firstName: "Casey",
      lastName: "Doe",
      email: "casey.doe@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Contract review",
      details: "ACL test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: assigned._id,
      paralegalId: assigned._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(outsider))
      .send({ key: `cases/${caseDoc._id}/documents/b.pdf`, original: "b.pdf", mime: "application/pdf", size: 123 });
    expect([403, 404]).toContain(res.status);
  });

  test("Assigned paralegal can attach file metadata", async () => {
    // Description: Assigned paralegal attaches file metadata.
    // Input values: key="cases/<id>/documents/assigned.pdf".
    // Expected result: 201 and CaseFile record created.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone3@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng3@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "ACL test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      totalAmount: 100000,
      currency: "usd",
    });

    const key = `cases/${caseDoc._id}/documents/assigned.pdf`;
    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ key, original: "assigned.pdf", mime: "application/pdf", size: 123 });
    expect(res.status).toBe(201);

    const record = await CaseFile.findOne(buildCaseFileKeyQuery({ caseId: caseDoc._id, storageKey: key })).lean();
    expect(record).toBeTruthy();
  });
});
