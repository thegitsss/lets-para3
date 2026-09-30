const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

const User = require("../models/User");
const Case = require("../models/Case");
const Block = require("../models/Block");
const Notification = require("../models/Notification");
const casesRouter = require("../routes/cases");
const usersRouter = require("../routes/users");
const notificationsRouter = require("../routes/notifications");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json());
  instance.use("/api/cases", casesRouter);
  instance.use("/api/users", usersRouter);
  instance.use("/api/notifications", notificationsRouter);
  instance.use((_err, _req, res, _next) => res.status(500).json({ error: "Server error" }));
  return instance;
})();

function authCookieFor(user) {
  const token = jwt.sign(
    { id: String(user._id), role: user.role, email: user.email, status: user.status },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );
  return `token=${token}`;
}

function userFields(overrides = {}) {
  const marker = Math.random().toString(36).slice(2);
  return {
    firstName: "Context",
    lastName: "User",
    email: `context-${marker}@example.com`,
    password: "Password123!",
    role: "attorney",
    status: "approved",
    ...overrides,
  };
}

function publicParalegal(overrides = {}) {
  return userFields({
    role: "paralegal",
    firstName: "Taylor",
    lastName: "Candidate",
    bio: "Experienced litigation paralegal.",
    resumeURL: "https://private.example/resume.pdf",
    skills: ["Discovery"],
    practiceAreas: ["Civil Litigation"],
    specialties: ["Document review"],
    profilePhotoStatus: "approved",
    profileImage: "https://private.example/photo.jpg",
    pendingProfileImage: "",
    location: "New York, NY",
    phone: "212-555-0100",
    ...overrides,
  });
}

function matterFields(attorney, overrides = {}) {
  return {
    title: "Contract Review Matter",
    details: "Review and organize production documents.",
    status: "open",
    attorney: attorney._id,
    attorneyId: attorney._id,
    practiceArea: "Civil Litigation",
    totalAmount: 120000,
    currency: "usd",
    ...overrides,
  };
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("contextual Application and Profile projections", () => {
  test("Application preview is owner/self-only, cross-Matter safe, and strictly projected", async () => {
    const owner = await User.create(userFields());
    const otherAttorney = await User.create(userFields());
    const candidate = await User.create(publicParalegal({ email: "candidate-private@example.com" }));
    const otherCandidate = await User.create(publicParalegal());
    const matter = await Case.create(matterFields(owner, {
      applicants: [{
        paralegalId: candidate._id,
        status: "pending",
        note: "I can support this discovery schedule.",
        resumeURL: "https://private.example/candidate-resume.pdf",
        linkedInURL: "https://private.example/linkedin",
      }],
    }));

    const anonymous = await request(app).get(`/api/cases/${matter._id}/applications/${candidate._id}/preview`);
    expect(anonymous.status).toBe(401);

    const response = await request(app)
      .get(`/api/cases/${matter._id}/applications/${candidate._id}/preview`)
      .set("Cookie", authCookieFor(owner));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(Object.keys(response.body.application).sort()).toEqual([
      "candidateId", "candidateName", "coverLetter", "fullReviewHref", "id", "matterTitle",
      "preEngagement", "profile", "profileHref", "source", "status", "submittedAt",
    ].sort());
    expect(response.body.application.fullReviewHref).toContain(`caseId=${matter._id}`);
    expect(JSON.stringify(response.body)).not.toMatch(/candidate-private@example|212-555|resume|linkedin|stripe|storage/i);

    const unrelated = await request(app)
      .get(`/api/cases/${matter._id}/applications/${candidate._id}/preview`)
      .set("Cookie", authCookieFor(otherAttorney));
    expect(unrelated.status).toBe(404);

    const self = await request(app)
      .get(`/api/cases/${matter._id}/applications/${candidate._id}/preview`)
      .set("Cookie", authCookieFor(candidate));
    expect(self.status).toBe(200);

    const crossCandidate = await request(app)
      .get(`/api/cases/${matter._id}/applications/${candidate._id}/preview`)
      .set("Cookie", authCookieFor(otherCandidate));
    expect(crossCandidate.status).toBe(404);

    const crossMatterObject = await request(app)
      .get(`/api/cases/${matter._id}/applications/${otherCandidate._id}/preview`)
      .set("Cookie", authCookieFor(owner));
    expect(crossMatterObject.status).toBe(404);
  });

  test("Profile preview honors public completeness, self-only paralegal access, and blocking", async () => {
    const attorney = await User.create(userFields());
    const paralegal = await User.create(publicParalegal({ email: "profile-private@example.com" }));
    const otherParalegal = await User.create(publicParalegal());

    const publicResponse = await request(app)
      .get(`/api/users/profile-preview/${paralegal._id}`)
      .set("Cookie", authCookieFor(attorney));
    expect(publicResponse.status).toBe(200);
    expect(Object.keys(publicResponse.body.profile).sort()).toEqual([
      "availability", "bio", "experience", "fullHref", "id", "location", "name",
      "practiceAreas", "skills", "specialties", "yearsExperience",
    ].sort());
    expect(publicResponse.body.profile.fullHref).toBe(`/profile-paralegal.html?paralegalId=${paralegal._id}`);
    expect(JSON.stringify(publicResponse.body)).not.toMatch(/profile-private@example|212-555|resume|photo\.jpg|stripe|storage/i);

    const crossParalegal = await request(app)
      .get(`/api/users/profile-preview/${paralegal._id}`)
      .set("Cookie", authCookieFor(otherParalegal));
    expect(crossParalegal.status).toBe(404);

    const self = await request(app)
      .get(`/api/users/profile-preview/${paralegal._id}`)
      .set("Cookie", authCookieFor(paralegal));
    expect(self.status).toBe(200);

    await Block.create({
      blockerId: attorney._id,
      blockedId: paralegal._id,
      blockerRole: "attorney",
      blockedRole: "paralegal",
      sourceType: "legacy",
    });
    const blocked = await request(app)
      .get(`/api/users/profile-preview/${paralegal._id}`)
      .set("Cookie", authCookieFor(attorney));
    expect(blocked.status).toBe(404);
  });

  test("notification feed returns only safe current actions and suppresses revoked access", async () => {
    const attorney = await User.create(userFields());
    const paralegal = await User.create(publicParalegal());
    const messageId = "64b555555555555555555555";
    const matter = await Case.create(matterFields(attorney, {
      status: "in progress",
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
    }));
    await Notification.create({
      userId: attorney._id,
      type: "message",
      message: "Raw producer copy with private details",
      link: "https://evil.example/open-redirect",
      actorUserId: paralegal._id,
      actorFirstName: "Taylor",
      actorProfileImage: "https://private.example/photo.jpg",
      payload: {
        caseId: matter._id,
        messageId,
        messageSnippet: "Please review the draft.",
        clientSecret: "pi_secret_private",
        storageKey: "cases/private/file.pdf",
      },
    });
    await Notification.create({
      userId: paralegal._id,
      type: "message",
      payload: { caseId: matter._id, messageId },
    });

    const attorneyFeed = await request(app)
      .get("/api/notifications")
      .set("Cookie", authCookieFor(attorney));
    expect(attorneyFeed.status).toBe(200);
    expect(attorneyFeed.body).toHaveLength(1);
    expect(attorneyFeed.body[0].action).toEqual({
      label: "View message",
      href: `/case-detail.html?caseId=${matter._id}&tab=messages&messageId=${messageId}`,
    });
    expect(JSON.stringify(attorneyFeed.body)).not.toMatch(/evil\.example|pi_secret|storageKey|private\/file|photo\.jpg|Raw producer/i);

    matter.paralegalAccessRevokedAt = new Date();
    await matter.save();
    const revokedFeed = await request(app)
      .get("/api/notifications")
      .set("Cookie", authCookieFor(paralegal));
    expect(revokedFeed.status).toBe(200);
    expect(revokedFeed.body).toEqual([]);
    const unread = await request(app).get("/api/notifications/unread-count").set("Cookie", authCookieFor(paralegal));
    expect(unread.status).toBe(200);
    expect(unread.body.count).toBe(0);
  });
});
