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
      stripeAccountId: "acct_application_test",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
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
      .send({ coverLetter: "I can provide careful filing and document support." });

    expect(res.status).toBe(201);

    const application = await Application.findById(res.body?._id).lean();
    const job = await Job.findOne({ caseId: caseDoc._id }).lean();
    const mirroredCase = await Case.findById(caseDoc._id).lean();
    expect(application).toEqual(expect.objectContaining({
      status: "submitted",
      syncStatus: "synced",
    }));
    expect(String(application?.jobId || "")).toBe(String(job?._id || ""));
    expect(job?.applicantsCount).toBe(1);
    expect(
      mirroredCase?.applicants?.some(
        (entry) => String(entry?.paralegalId || "") === String(paralegal._id)
      )
    ).toBe(true);

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
      .send({ coverLetter: "I can provide careful probate document support." });

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
      .field("conflictsDetails", "Check ACME Corp, Beta Inc., and opposing counsel list.");

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

  test("Requested paralegal can submit a no-known-conflict response", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "conflicts-none-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "conflicts-none-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "No known conflict response",
      practiceArea: "business law",
      details: "Verify the no-known-conflict response path.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 75000,
      currency: "usd",
      tasks: [{ title: "Prepare issue list", completed: false }],
      preEngagement: {
        status: "requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: false,
        conflictsCheckRequired: true,
        conflictsDetails: "Review ACME Corp and related parties.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
      .set("Cookie", authCookieFor(paralegal))
      .send({
        confidentialityAcknowledged: false,
        conflictsResponseType: "none_known",
        conflictsDisclosureText: "This text should not persist.",
      });

    expect(res.status).toBe(200);
    expect(res.body.preEngagement?.status).toBe("submitted");
    expect(res.body.preEngagement?.conflictsResponseType).toBe("none_known");
    expect(res.body.preEngagement?.conflictsDisclosureText).toBe("");
  });

  test("Attorney cannot request a conflicts check from a non-paralegal user", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "conflicts-role-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const otherAttorney = await User.create({
      firstName: "Taylor",
      lastName: "Stone",
      email: "conflicts-role-target@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Invalid conflicts target",
      practiceArea: "business law",
      details: "Reject a conflicts request sent to a non-paralegal.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 75000,
      currency: "usd",
      tasks: [{ title: "Prepare issue list", completed: false }],
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/${otherAttorney._id}/request`)
      .set("Cookie", authCookieFor(attorney))
      .field("confidentialityAgreementRequired", "false")
      .field("conflictsCheckRequired", "true")
      .field("conflictsDetails", "Review ACME Corp.");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only be requested from a paralegal/i);
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
    expect(match?.status).toBe("submitted");
    expect(match?.applicationSource).toBe("invite_accept");
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

    const revoked = await Application.findById(application._id).lean();
    expect(revoked).toEqual(expect.objectContaining({
      status: "withdrawn",
      syncStatus: "synced",
    }));
    expect(revoked?.withdrawnAt).toBeTruthy();
    expect(revoked?.statusHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "accepted",
          to: "withdrawn",
          reason: "revoked_by_paralegal",
        }),
      ])
    );
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
      fundingIntegrityStatus: "verified",
      payoutFinalizedAt: new Date(Date.now() - 60 * 60 * 1000),
      totalAmount: 100000,
      remainingAmount: 60000,
      currency: "usd",
      tasks: [{ title: "Prepare next filing", completed: false }],
      applicants: [{ paralegalId: paralegal._id, status: "pending", appliedAt: new Date() }],
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

  test("Concurrent invitation accepts are idempotent and create one canonical application", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "concurrent-invite-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "concurrent-invite-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_concurrent_invite",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await Case.create({
      title: "Concurrent invitation acceptance",
      practiceArea: "contracts",
      details: "Only one application should be materialized.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 70000,
      currency: "usd",
      invites: [{ paralegalId: paralegal._id, status: "pending", invitedAt: new Date() }],
      tasks: [{ title: "Review agreement", completed: false }],
    });
    const job = await Job.create({
      caseId: caseDoc._id,
      attorneyId: attorney._id,
      title: caseDoc.title,
      practiceArea: caseDoc.practiceArea,
      description: caseDoc.details,
      budget: caseDoc.totalAmount,
      status: "open",
    });
    await Case.updateOne({ _id: caseDoc._id }, { $set: { jobId: job._id } });

    const [first, second] = await Promise.all([
      request(app).post(`/api/cases/${caseDoc._id}/invite/accept`).set("Cookie", authCookieFor(paralegal)).send({}),
      request(app).post(`/api/cases/${caseDoc._id}/invite/accept`).set("Cookie", authCookieFor(paralegal)).send({}),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body?.alreadyProcessed, second.body?.alreadyProcessed].filter(Boolean)).toHaveLength(1);
    const applications = await Application.find({ jobId: job._id, paralegalId: paralegal._id }).lean();
    expect(applications).toHaveLength(1);
    expect(applications[0].status).toBe("submitted");
    expect(applications[0].statusHistory.filter((entry) => entry.reason === "invitation_accepted")).toHaveLength(1);
    const updatedCase = await Case.findById(caseDoc._id).lean();
    const invite = updatedCase.invites.find((entry) => String(entry.paralegalId) === String(paralegal._id));
    expect(invite.status).toBe("accepted");
    expect(invite.syncStatus).toBe("synced");
  });

  test("Concurrent pre-engagement responses cannot overwrite each other", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "concurrent-pre-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "concurrent-pre-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Concurrent pre-engagement response",
      details: "Only one response may win.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 70000,
      currency: "usd",
      tasks: [{ title: "Review agreement", completed: false }],
      preEngagement: {
        revision: 1,
        status: "requested",
        requestedParalegalId: paralegal._id,
        conflictsCheckRequired: true,
        conflictsDetails: "Review ACME Corp.",
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
        .set("Cookie", authCookieFor(paralegal))
        .send({ conflictsResponseType: "none_known" }),
      request(app)
        .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
        .set("Cookie", authCookieFor(paralegal))
        .send({
          conflictsResponseType: "disclosure",
          conflictsDisclosureText: "Potential prior vendor contact.",
        }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(updatedCase.preEngagement.status).toBe("submitted");
    expect(updatedCase.preEngagement.revision).toBe(2);
  });

  test("Concurrent attorney reviews permit exactly one state transition", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "concurrent-review-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "concurrent-review-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Concurrent pre-engagement review",
      details: "Only one review decision may win.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 70000,
      currency: "usd",
      tasks: [{ title: "Review agreement", completed: false }],
      preEngagement: {
        revision: 4,
        status: "submitted",
        requestedParalegalId: paralegal._id,
        conflictsCheckRequired: true,
        conflictsDetails: "Review ACME Corp.",
        conflictsResponseType: "none_known",
        requestedAt: new Date(),
        requestedBy: attorney._id,
        submittedAt: new Date(),
        submittedBy: paralegal._id,
      },
    });

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/cases/${caseDoc._id}/pre-engagement/review`)
        .set("Cookie", authCookieFor(attorney))
        .send({ action: "approve" }),
      request(app)
        .post(`/api/cases/${caseDoc._id}/pre-engagement/review`)
        .set("Cookie", authCookieFor(attorney))
        .send({ action: "request_changes" }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(["approved", "changes_requested"]).toContain(updatedCase.preEngagement.status);
    expect(updatedCase.preEngagement.revision).toBe(5);
  });

  test("Concurrent termination requests create one linked open review", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Terminate",
      email: "concurrent-termination-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Terminate",
      email: "concurrent-termination-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Concurrent termination",
      details: "Only one termination review may be created.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_concurrent_termination",
      fundingIntegrityStatus: "verified",
      totalAmount: 70000,
      currency: "usd",
      tasks: [{ title: "Review agreement", completed: false }],
    });

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/cases/${caseDoc._id}/terminate`)
        .set("Cookie", authCookieFor(attorney))
        .send({ reason: "Scope relationship ended." }),
      request(app)
        .post(`/api/cases/${caseDoc._id}/terminate`)
        .set("Cookie", authCookieFor(attorney))
        .send({ reason: "Scope relationship ended." }),
    ]);

    expect([first.status, second.status]).toEqual([202, 202]);
    expect([first.body.alreadyRequested, second.body.alreadyRequested].filter(Boolean)).toHaveLength(1);
    const updatedCase = await Case.findById(caseDoc._id).lean();
    const openReviews = updatedCase.disputes.filter((entry) => entry.status === "open");
    expect(openReviews).toHaveLength(1);
    expect(updatedCase.terminationStatus).toBe("disputed");
    expect(updatedCase.terminationDisputeId).toBe(openReviews[0].disputeId);
  });

  test("Concurrent withdrawal requests detach the assignment once and retry idempotently", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Withdraw",
      email: "concurrent-withdrawal-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Withdraw",
      email: "concurrent-withdrawal-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Concurrent withdrawal",
      details: "The assignment must be detached exactly once.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_concurrent_withdrawal",
      fundingIntegrityStatus: "verified",
      lockedTotalAmount: 70000,
      totalAmount: 70000,
      remainingAmount: 70000,
      currency: "usd",
      tasks: [
        { title: "Prepare draft", completed: true },
        { title: "Finalize draft", completed: false },
      ],
    });

    const [first, second] = await Promise.all([
      request(app).post(`/api/cases/${caseDoc._id}/withdraw`).set("Cookie", authCookieFor(paralegal)).send({}),
      request(app).post(`/api/cases/${caseDoc._id}/withdraw`).set("Cookie", authCookieFor(paralegal)).send({}),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.alreadyProcessed, second.body.alreadyProcessed].filter(Boolean)).toHaveLength(1);
    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(updatedCase.status).toBe("paused");
    expect(updatedCase.pausedReason).toBe("paralegal_withdrew");
    expect(String(updatedCase.withdrawnParalegalId)).toBe(String(paralegal._id));
    expect(updatedCase.paralegal).toBeNull();
    expect(updatedCase.paralegalId).toBeNull();
  });

  test("Withdrawal cannot cross an active completion claim", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Claim",
      email: "withdrawal-completion-claim-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Claim",
      email: "withdrawal-completion-claim-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Completion owned matter",
      details: "Withdrawal must yield while completion owns the lifecycle.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      hiredAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_withdrawal_completion_claim",
      fundingIntegrityStatus: "verified",
      totalAmount: 70000,
      currency: "usd",
      tasks: [{ title: "Finalize draft", completed: false }],
      completionClaimToken: "completion-owned",
      completionClaimedAt: new Date(),
      completionClaimStatus: "claimed",
    });

    const result = await request(app)
      .post(`/api/cases/${caseDoc._id}/withdraw`)
      .set("Cookie", authCookieFor(paralegal))
      .send({});

    expect(result.status).toBe(409);
    expect(result.body.code).toBe("WITHDRAWAL_CONFLICT");
    const updatedCase = await Case.findById(caseDoc._id).lean();
    expect(updatedCase.status).toBe("in progress");
    expect(String(updatedCase.paralegalId)).toBe(String(paralegal._id));
  });
});
