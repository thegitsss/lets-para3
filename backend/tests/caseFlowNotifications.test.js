const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Notification = require("../models/Notification");
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";
const casesRouter = require("../routes/cases");
const applicationsRouter = require("../routes/applications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
  instance.use("/api/applications", applicationsRouter);
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

describe("Case flow notifications", () => {
  test("Paralegal application creates application_submitted notification for attorney", async () => {
    // Description: Paralegal applies to an open case.
    // Input values: attorney + paralegal, open case with at least one scope task.
    // Expected result: Notification type application_submitted is created for the attorney.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      profileImage: "https://example.com/paralegal-photo.jpg",
    });

    const caseDoc = await Case.create({
      title: "Immigration support",
      practiceArea: "immigration",
      details: "Case details for application notification test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 60000,
      currency: "usd",
      tasks: [{ title: "Draft initial filing", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/apply`)
      .set("Cookie", authCookieFor(paralegal))
      .send({});

    expect(res.status).toBe(201);

    const notif = await Notification.findOne({
      userId: attorney._id,
      type: "application_submitted",
    }).lean();
    expect(notif).toBeTruthy();
    expect(String(notif.payload?.caseId || "")).toBe(String(caseDoc._id));
  });

  test("Paralegal application is blocked when no profile photo is present", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Jamie",
      lastName: "Lee",
      email: "samanthasider+paralegal@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      profileImage: "",
      avatarURL: "",
    });

    const caseDoc = await Case.create({
      title: "Probate support",
      practiceArea: "trusts & estates",
      details: "Case details for profile photo requirement test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 60000,
      currency: "usd",
      tasks: [{ title: "Prepare initial summary", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/apply`)
      .set("Cookie", authCookieFor(paralegal))
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Complete your profile before applying.");

    const notif = await Notification.findOne({
      userId: attorney._id,
      type: "application_submitted",
    }).lean();
    expect(notif).toBeFalsy();
  });

  test("Attorney can persist a requested pre-engagement draft without hiring the paralegal", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      title: "Trademark filing support",
      practiceArea: "intellectual property",
      details: "Case details for pre-engagement persistence test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 90000,
      currency: "usd",
      tasks: [{ title: "Prepare filing packet", completed: false }],
    });

    const job = await Job.create({
      title: "Trademark filing support",
      description: "Help prepare a filing packet.",
      practiceArea: "intellectual property",
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      status: "open",
      budget: 90000,
    });

    const application = await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "Ready to help with pre-engagement review.",
      status: "submitted",
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/${paralegal._id}/request`)
      .set("Cookie", authCookieFor(attorney))
      .field("confidentialityAgreementRequired", "false")
      .field("conflictsCheckRequired", "true")
      .field("conflictsDetails", "Check ACME Corp, Beta LLC, and opposing counsel list.");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preEngagement?.status).toBe("requested");
    expect(res.body.preEngagement?.requestedParalegalId).toBe(String(paralegal._id));
    expect(res.body.preEngagement?.confidentialityAgreementRequired).toBe(false);
    expect(res.body.preEngagement?.conflictsCheckRequired).toBe(true);

    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(updatedCase?.preEngagement).toBeTruthy();
    expect(updatedCase?.preEngagement?.status).toBe("requested");
    expect(String(updatedCase?.preEngagement?.requestedParalegalId || "")).toBe(String(paralegal._id));
    expect(updatedCase?.preEngagement?.confidentialityAgreementRequired).toBe(false);
    expect(updatedCase?.preEngagement?.conflictsCheckRequired).toBe(true);
    expect(updatedCase?.preEngagement?.conflictsDetails).toContain("ACME Corp");
    expect(String(updatedCase?.paralegalId || "")).toBe("");
    expect(updatedCase?.hiredAt).toBeFalsy();

    const notif = await Notification.findOne({
      userId: paralegal._id,
      type: "pre_engagement_requested",
    }).lean();
    expect(notif).toBeTruthy();
    expect(String(notif?.payload?.caseId || "")).toBe(String(caseDoc._id));
    expect(String(notif?.payload?.applicationId || "")).toBe(String(application._id));
  });

  test("Requested paralegal can submit a pre-engagement response", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      title: "Employment intake support",
      practiceArea: "employment law",
      details: "Case details for pre-engagement response test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 75000,
      currency: "usd",
      tasks: [{ title: "Prepare initial issue log", completed: false }],
      applicants: [
        {
          paralegalId: paralegal._id,
          status: "pending",
          appliedAt: new Date(),
          note: "Ready to help.",
        },
      ],
      preEngagement: {
        status: "requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: false,
        conflictsCheckRequired: true,
        conflictsDetails: "Review ABC Inc. and Smith & Co.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
      .set("Cookie", authCookieFor(paralegal))
      .send({
        confidentialityAcknowledged: false,
        conflictsResponseType: "disclosure",
        conflictsDisclosureText: "I previously supported a related vendor matter in 2024.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preEngagement?.status).toBe("submitted");
    expect(res.body.preEngagement?.conflictsResponseType).toBe("disclosure");

    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(updatedCase?.preEngagement?.status).toBe("submitted");
    expect(updatedCase?.preEngagement?.conflictsResponseType).toBe("disclosure");
    expect(updatedCase?.preEngagement?.conflictsDisclosureText).toContain("related vendor matter");
    expect(String(updatedCase?.preEngagement?.submittedBy || "")).toBe(String(paralegal._id));

    const notif = await Notification.findOne({
      userId: attorney._id,
      type: "pre_engagement_submitted",
    }).lean();
    expect(notif).toBeTruthy();
    expect(String(notif?.payload?.caseId || "")).toBe(String(caseDoc._id));
    expect(String(notif?.payload?.paralegalId || "")).toBe(String(paralegal._id));
  });

  test("Accepted invitation notifies the attorney but does not create a self-notification for the paralegal", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.invite.accept@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.invite.accept@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_123",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await Case.create({
      title: "Invitation acceptance flow",
      practiceArea: "contracts",
      details: "Invitation acceptance should notify only the attorney.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 70000,
      currency: "usd",
      pendingParalegalId: paralegal._id,
      pendingParalegalInvitedAt: new Date(),
      invites: [{ paralegalId: paralegal._id, status: "pending", invitedAt: new Date() }],
      tasks: [{ title: "Review contract", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/invite/accept`)
      .set("Cookie", authCookieFor(paralegal))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    const attorneyNotif = await Notification.findOne({
      userId: attorney._id,
      type: "case_invite_response",
      "payload.response": "accepted",
    }).lean();
    expect(attorneyNotif).toBeTruthy();
    expect(String(attorneyNotif?.payload?.paralegalId || "")).toBe(String(paralegal._id));

    const paralegalNotif = await Notification.findOne({
      userId: paralegal._id,
      type: "case_invite_response",
      "payload.response": "accepted",
    }).lean();
    expect(paralegalNotif).toBeFalsy();
  });

  test("Revoking an accepted invitation creates a paralegal self-notification", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.invite.revoke.notify@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.invite.revoke.notify@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Revoked invitation flow",
      practiceArea: "contracts",
      details: "Revoking an accepted invitation should notify the paralegal.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 70000,
      currency: "usd",
      invites: [{ paralegalId: paralegal._id, status: "accepted", invitedAt: new Date(), respondedAt: new Date() }],
      applicants: [{ paralegalId: paralegal._id, status: "pending", appliedAt: new Date() }],
      tasks: [{ title: "Review contract", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/invite/revoke`)
      .set("Cookie", authCookieFor(paralegal))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    const paralegalNotif = await Notification.findOne({
      userId: paralegal._id,
      type: "case_invite_response",
      "payload.caseId": caseDoc._id,
      "payload.message": `You revoked your application for ${caseDoc.title}.`,
    }).lean();
    expect(paralegalNotif).toBeTruthy();
  });

  test("Attorney can approve a submitted pre-engagement response", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      title: "Pre-engagement review approval",
      practiceArea: "employment law",
      details: "Case details for attorney pre-engagement review test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 75000,
      currency: "usd",
      tasks: [{ title: "Prepare initial issue log", completed: false }],
      preEngagement: {
        status: "submitted",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: true,
        conflictsCheckRequired: true,
        conflictsDetails: "Review ABC Inc. and Smith & Co.",
        confidentialityAcknowledged: true,
        confidentialityAcknowledgedAt: new Date(),
        conflictsResponseType: "none_known",
        conflictsDisclosureText: "",
        requestedAt: new Date(),
        requestedBy: attorney._id,
        submittedAt: new Date(),
        submittedBy: paralegal._id,
      },
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/review`)
      .set("Cookie", authCookieFor(attorney))
      .send({ action: "approve" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preEngagement?.status).toBe("approved");
    expect(res.body.preEngagement?.reviewedBy).toBe(String(attorney._id));

    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(updatedCase?.preEngagement?.status).toBe("approved");
    expect(String(updatedCase?.preEngagement?.reviewedBy || "")).toBe(String(attorney._id));
    expect(updatedCase?.preEngagement?.reviewedAt).toBeTruthy();
  });

  test("Requested paralegal can revise and resubmit after attorney requests changes", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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

    const reviewedAt = new Date();
    const caseDoc = await Case.create({
      title: "Pre-engagement changes requested",
      practiceArea: "employment law",
      details: "Case details for pre-engagement changes-requested resubmit test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 75000,
      currency: "usd",
      tasks: [{ title: "Prepare initial issue log", completed: false }],
      preEngagement: {
        status: "changes_requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: false,
        conflictsCheckRequired: true,
        conflictsDetails: "Review ABC Inc. and Smith & Co.",
        conflictsResponseType: "disclosure",
        conflictsDisclosureText: "Initial disclosure details.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
        submittedAt: new Date(),
        submittedBy: paralegal._id,
        reviewedAt,
        reviewedBy: attorney._id,
      },
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
      .set("Cookie", authCookieFor(paralegal))
      .send({
        confidentialityAcknowledged: false,
        conflictsResponseType: "disclosure",
        conflictsDisclosureText: "Updated disclosure details after attorney feedback.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preEngagement?.status).toBe("submitted");
    expect(res.body.preEngagement?.reviewedAt).toBeNull();
    expect(res.body.preEngagement?.reviewedBy).toBeNull();

    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(updatedCase?.preEngagement?.status).toBe("submitted");
    expect(updatedCase?.preEngagement?.conflictsDisclosureText).toContain("attorney feedback");
    expect(updatedCase?.preEngagement?.reviewedAt).toBeFalsy();
    expect(updatedCase?.preEngagement?.reviewedBy).toBeFalsy();
  });

  test("Attorney request changes notifies the requested paralegal with application routing data", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      profileImage: "https://example.com/paralegal-photo.jpg",
    });

    const caseDoc = await Case.create({
      title: "Pre-engagement request changes notice",
      practiceArea: "employment law",
      details: "Case details for pre-engagement changes notification test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 75000,
      currency: "usd",
      tasks: [{ title: "Prepare initial issue log", completed: false }],
      preEngagement: {
        status: "submitted",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: false,
        conflictsCheckRequired: true,
        conflictsDetails: "Review ABC Inc. and Smith & Co.",
        conflictsResponseType: "disclosure",
        conflictsDisclosureText: "Initial disclosure details.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
        submittedAt: new Date(),
        submittedBy: paralegal._id,
      },
    });

    const job = await Job.create({
      title: "Pre-engagement request changes notice",
      description: "Help prepare an issue outline.",
      practiceArea: "employment law",
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      status: "open",
      budget: 75000,
    });

    const application = await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "Ready to revise as needed.",
      status: "submitted",
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/review`)
      .set("Cookie", authCookieFor(attorney))
      .send({ action: "request_changes" });

    expect(res.status).toBe(200);
    expect(res.body.preEngagement?.status).toBe("changes_requested");

    const notif = await Notification.findOne({
      userId: paralegal._id,
      type: "pre_engagement_changes_requested",
    }).lean();
    expect(notif).toBeTruthy();
    expect(String(notif?.payload?.caseId || "")).toBe(String(caseDoc._id));
    expect(String(notif?.payload?.applicationId || "")).toBe(String(application._id));
  });

  test("Paralegal applications list includes matching requested pre-engagement data", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      profileImage: "https://example.com/paralegal-photo.jpg",
    });

    const caseDoc = await Case.create({
      title: "Business intake support",
      practiceArea: "business law",
      details: "Case details for applications pre-engagement list test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 80000,
      currency: "usd",
      tasks: [{ title: "Prepare intake summary", completed: false }],
      preEngagement: {
        status: "requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: false,
        conflictsCheckRequired: true,
        conflictsDetails: "Check ACME Corp and all related subsidiaries.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const job = await Job.create({
      title: "Business intake support",
      description: "Help organize intake details.",
      practiceArea: "business law",
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      status: "open",
      budget: 80000,
    });

    await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "I can help with this intake.",
      status: "submitted",
    });

    const res = await request(app)
      .get("/api/applications/my")
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(String(res.body[0]?.caseId || "")).toBe(String(caseDoc._id));
    expect(res.body[0]?.preEngagement).toBeTruthy();
    expect(res.body[0]?.preEngagement?.status).toBe("requested");
    expect(res.body[0]?.preEngagement?.conflictsCheckRequired).toBe(true);
    expect(res.body[0]?.preEngagement?.conflictsDetails).toContain("ACME Corp");
  });

  test("Accepted invited paralegal sees requested pre-engagement in applications list", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      profileImage: "https://example.com/paralegal-photo.jpg",
    });

    const caseDoc = await Case.create({
      title: "Invited case pre-engagement support",
      practiceArea: "business law",
      details: "Case details for invited pre-engagement list test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 80000,
      currency: "usd",
      applicants: [{ paralegalId: paralegal._id, status: "pending", appliedAt: new Date() }],
      invites: [{ paralegalId: paralegal._id, status: "accepted", invitedAt: new Date(), respondedAt: new Date() }],
      tasks: [{ title: "Prepare intake summary", completed: false }],
      preEngagement: {
        status: "requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: true,
        conflictsCheckRequired: true,
        conflictsDetails: "Check ACME Corp and all related subsidiaries.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const res = await request(app)
      .get("/api/applications/my")
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const match = res.body.find((entry) => String(entry?.caseId || "") === String(caseDoc._id));
    expect(match).toBeTruthy();
    expect(match?.coverLetter).toBe("Accepted invitation");
    expect(match?.preEngagement).toBeTruthy();
    expect(match?.preEngagement?.status).toBe("requested");
    expect(match?.preEngagement?.confidentialityAgreementRequired).toBe(true);
    expect(match?.preEngagement?.conflictsCheckRequired).toBe(true);
  });

  test("Accepted application can be revoked before the case is funded", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      profileImage: "https://example.com/paralegal-photo.jpg",
    });

    const caseDoc = await Case.create({
      title: "Accepted application revoke",
      practiceArea: "business law",
      details: "Accepted application should still be revocable before funding.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 80000,
      currency: "usd",
      applicants: [{ paralegalId: paralegal._id, status: "accepted", appliedAt: new Date() }],
      tasks: [{ title: "Prepare intake summary", completed: false }],
    });

    const job = await Job.create({
      title: "Accepted application revoke",
      description: "Help organize intake details.",
      practiceArea: "business law",
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      status: "open",
      budget: 80000,
    });

    const application = await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "I can help with this intake.",
      status: "accepted",
    });

    const res = await request(app)
      .post(`/api/applications/${application._id}/revoke`)
      .set("Cookie", authCookieFor(paralegal))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    const deleted = await Application.findById(application._id).lean();
    expect(deleted).toBeFalsy();
    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(Array.isArray(updatedCase?.applicants)).toBe(true);
    expect(updatedCase.applicants.some((entry) => String(entry?.paralegalId || "") === String(paralegal._id))).toBe(false);
  });

  test("Paralegal applications list includes matching changes-requested pre-engagement data", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1@gmail.com",
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
      profileImage: "https://example.com/paralegal-photo.jpg",
    });

    const caseDoc = await Case.create({
      title: "Business intake support follow-up",
      practiceArea: "business law",
      details: "Case details for applications changes-requested list test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 80000,
      currency: "usd",
      tasks: [{ title: "Prepare intake summary", completed: false }],
      preEngagement: {
        status: "changes_requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: false,
        conflictsCheckRequired: true,
        conflictsDetails: "Check ACME Corp and all related subsidiaries.",
        conflictsResponseType: "disclosure",
        conflictsDisclosureText: "Initial draft response.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
        submittedAt: new Date(),
        submittedBy: paralegal._id,
        reviewedAt: new Date(),
        reviewedBy: attorney._id,
      },
    });

    const job = await Job.create({
      title: "Business intake support follow-up",
      description: "Help organize intake details.",
      practiceArea: "business law",
      attorneyId: attorney._id,
      caseId: caseDoc._id,
      status: "open",
      budget: 80000,
    });

    await Application.create({
      jobId: job._id,
      paralegalId: paralegal._id,
      coverLetter: "I can help with this intake.",
      status: "submitted",
    });

    const res = await request(app)
      .get("/api/applications/my")
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]?.preEngagement).toBeTruthy();
    expect(res.body[0]?.preEngagement?.status).toBe("changes_requested");
    expect(res.body[0]?.preEngagement?.conflictsDisclosureText).toContain("Initial draft response");
    expect(res.body[0]?.preEngagement?.reviewedAt).toBeTruthy();
  });

  test("Attorney hire creates case_work_ready notification for paralegal", async () => {
    // Description: Attorney hires a paralegal on a relisted funded case.
    // Input values: paused case with payout finalized and remaining amount > 0.
    // Expected result: Notification type case_work_ready is created for the hired paralegal.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "game4funwithme1+1@gmail.com",
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
      title: "Relist and hire notification",
      practiceArea: "immigration",
      details: "Case details for hire notification test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "paused",
      pausedReason: "paralegal_withdrew",
      escrowStatus: "funded",
      escrowIntentId: "pi_relist_test",
      payoutFinalizedAt: new Date(Date.now() - 60 * 60 * 1000),
      totalAmount: 100000,
      remainingAmount: 60000,
      currency: "usd",
      tasks: [{ title: "Prepare next filing", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/hire/${paralegal._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const notif = await Notification.findOne({
      userId: paralegal._id,
      type: "case_work_ready",
    }).lean();
    expect(notif).toBeTruthy();
    expect(String(notif.payload?.caseId || "")).toBe(String(caseDoc._id));
  });
});
