const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const accountRouter = require("../routes/account");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/account", accountRouter);
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

async function createApprovedUser({ email, role, firstName = "Test", lastName = "User" }) {
  return User.create({
    firstName,
    lastName,
    email,
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

describe("Account deactivation", () => {
  test("paralegal cannot deactivate while assigned to an active case", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+deactivate-attorney-active@gmail.com",
      role: "attorney",
    });
    const paralegal = await createApprovedUser({
      email: "samanthasider+deactivate-paralegal-active@gmail.com",
      role: "paralegal",
    });

    await Case.create({
      title: "Active matter",
      practiceArea: "immigration",
      details: "Live matter should block deactivation.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_deactivate_block",
      totalAmount: 50000,
      currency: "usd",
    });

    const res = await request(app)
      .delete("/api/account/deactivate")
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active matters|financial/i);

    const refreshed = await User.findById(paralegal._id).lean();
    expect(refreshed.deleted).toBe(false);
    expect(refreshed.disabled).toBe(false);
  });

  test("attorney cannot deactivate while open jobs remain live", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+deactivate-attorney-job@gmail.com",
      role: "attorney",
    });

    await Job.create({
      attorneyId: attorney._id,
      title: "Open posting",
      practiceArea: "probate",
      description: "This job is still active.",
      budget: 300,
      status: "open",
    });

    const res = await request(app)
      .delete("/api/account/deactivate")
      .set("Cookie", authCookieFor(attorney));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/open or in-review jobs/i);
  });

  test("deactivation preserves historical cases and blocks further access with the same token", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+deactivate-attorney-complete@gmail.com",
      role: "attorney",
    });
    const paralegal = await createApprovedUser({
      email: "samanthasider+deactivate-paralegal-complete@gmail.com",
      role: "paralegal",
    });

    const completedCase = await Case.create({
      title: "Completed matter",
      practiceArea: "estate planning",
      details: "Historical case must remain after self-serve deactivation.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "completed",
      paymentReleased: true,
      paidOutAt: new Date(),
      completedAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_deactivate_complete",
      totalAmount: 62000,
      currency: "usd",
    });

    const cookie = authCookieFor(attorney);
    const deactivateRes = await request(app)
      .delete("/api/account/deactivate")
      .set("Cookie", cookie);

    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body).toMatchObject({ ok: true, deactivated: true });

    const refreshedUser = await User.findById(attorney._id).lean();
    expect(refreshedUser).toBeTruthy();
    expect(refreshedUser.deleted).toBe(true);
    expect(refreshedUser.disabled).toBe(true);

    const preservedCase = await Case.findById(completedCase._id).lean();
    expect(preservedCase).toBeTruthy();
    expect(preservedCase.title).toBe("Completed matter");

    const preferencesRes = await request(app)
      .get("/api/account/preferences")
      .set("Cookie", cookie);

    expect(preferencesRes.status).toBe(403);
    expect(preferencesRes.body.error || preferencesRes.body.msg).toMatch(/deactivated/i);
  });

  test("legacy /delete alias performs the same deactivation flow", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+deactivate-attorney-alias@gmail.com",
      role: "attorney",
    });

    const res = await request(app)
      .delete("/api/account/delete")
      .set("Cookie", authCookieFor(attorney));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deactivated: true });

    const refreshed = await User.findById(attorney._id).lean();
    expect(refreshed.deleted).toBe(true);
    expect(refreshed.disabled).toBe(true);
  });

  test("paralegal deactivation rejects pending applications so they leave active participation", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+deactivate-attorney-app@gmail.com",
      role: "attorney",
    });
    const paralegal = await createApprovedUser({
      email: "samanthasider+deactivate-paralegal-app@gmail.com",
      role: "paralegal",
    });

    const caseDoc = await Case.create({
      title: "Open case",
      practiceArea: "family law",
      details: "Open application should be cleaned up on deactivation.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      escrowStatus: null,
      totalAmount: 24000,
      currency: "usd",
      applicants: [{ paralegalId: paralegal._id, status: "pending" }],
    });

    const job = await Job.create({
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      title: "Open case",
      practiceArea: "family law",
      description: "Job linked to pending application.",
      budget: 240,
      status: "closed",
    });

    await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "Interested in helping.",
      status: "submitted",
    });

    const res = await request(app)
      .delete("/api/account/deactivate")
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(200);

    const application = await Application.findOne({ jobId: job._id, paralegalId: paralegal._id }).lean();
    expect(application.status).toBe("rejected");

    const refreshedCase = await Case.findById(caseDoc._id).lean();
    const applicantEntry = (refreshedCase.applicants || []).find(
      (entry) => String(entry.paralegalId) === String(paralegal._id)
    );
    expect(applicantEntry?.status).toBe("rejected");
  });
});
