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
  test("Paralegal can decline a pending invitation", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.invite.decline@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.invite.decline@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Invite decline regression",
      details: "Pending invitation should be declinable.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
      pendingParalegalId: paralegal._id,
      pendingParalegalInvitedAt: new Date(),
      invites: [{ paralegalId: paralegal._id, status: "pending", invitedAt: new Date() }],
      tasks: [{ title: "Review file", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/invite/decline`)
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    const updated = await Case.findById(caseDoc._id).lean();
    expect(String(updated?.pendingParalegalId || "")).toBe("");
    expect(Array.isArray(updated?.invites)).toBe(true);
    expect(updated.invites.some((invite) => String(invite?.paralegalId || "") === String(paralegal._id) && invite?.status === "declined")).toBe(true);
  });

  test("Paralegal can revoke an accepted invitation before hire", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.invite.revoke@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.invite.revoke@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Invite revoke regression",
      details: "Accepted invitation should be revocable before hire.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
      invites: [{ paralegalId: paralegal._id, status: "accepted", invitedAt: new Date(), respondedAt: new Date() }],
      applicants: [{ paralegalId: paralegal._id, status: "pending", appliedAt: new Date() }],
      tasks: [{ title: "Review file", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/invite/revoke`)
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    const updated = await Case.findById(caseDoc._id).lean();
    expect(Array.isArray(updated?.invites)).toBe(true);
    expect(
      updated.invites.some(
        (invite) =>
          String(invite?.paralegalId || "") === String(paralegal._id) && invite?.status === "declined"
      )
    ).toBe(true);
    expect(Array.isArray(updated?.applicants)).toBe(true);
    expect(
      updated.applicants.some((applicant) => String(applicant?.paralegalId || "") === String(paralegal._id))
    ).toBe(false);
  });

  test("Attorney can still invite from a legacy case when attorney and attorneyId drift", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.invite.owner@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const staleAttorney = await User.create({
      firstName: "Jordan",
      lastName: "Lake",
      email: "jordan.invite.owner@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "samanthasider+paralegal@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Legacy owner alias case",
      details: "Invite ownership regression test.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Review file", completed: false }],
    });

    await Case.updateOne({ _id: caseDoc._id }, { $set: { attorneyId: staleAttorney._id } });

    const activeRes = await request(app)
      .get("/api/cases/my-active")
      .set("Cookie", authCookieFor(attorney));

    expect(activeRes.status).toBe(200);
    expect(Array.isArray(activeRes.body?.items)).toBe(true);
    expect(activeRes.body.items.some((item) => String(item.id || item._id) === String(caseDoc._id))).toBe(true);

    const inviteRes = await request(app)
      .post(`/api/cases/${caseDoc._id}/invite`)
      .set("Cookie", authCookieFor(attorney))
      .send({ paralegalId: paralegal._id.toString() });

    expect(inviteRes.status).toBe(200);
    expect(inviteRes.body?.success).toBe(true);
  });

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
