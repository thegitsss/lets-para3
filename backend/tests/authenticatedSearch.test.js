const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

const User = require("../models/User");
const Case = require("../models/Case");
const Block = require("../models/Block");
const CaseFile = require("../models/CaseFile");
const casesRouter = require("../routes/cases");
const uploadsRouter = require("../routes/uploads");
const { assertCaseParticipant } = require("../middleware/ensureCaseParticipant");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { SEARCH_QUERY_MAX, SEARCH_RESULT_LIMIT } = require("../services/authenticatedSearch");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/uploads", uploadsRouter);
  instance.use("/api/cases", casesRouter);
  instance.use((err, _req, res, _next) => {
    res.status(500).json({ error: "Server error", code: err?.code || null });
  });
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
    firstName: "Search",
    lastName: "User",
    email: `search-${marker}@example.com`,
    password: "Password123!",
    role: "attorney",
    status: "approved",
    ...overrides,
  };
}

function publicProfileFields(overrides = {}) {
  return userFields({
    firstName: "Taylor",
    lastName: "Searchable",
    role: "paralegal",
    bio: "Experienced litigation paralegal supporting complex case teams.",
    resumeURL: "https://example.com/resume.pdf",
    skills: ["Discovery"],
    practiceAreas: ["Civil Litigation"],
    specialties: ["Document review"],
    profilePhotoStatus: "approved",
    profileImage: "https://example.com/profile.jpg",
    pendingProfileImage: "",
    location: "New York, NY",
    ...overrides,
  });
}

function matterFields(attorney, overrides = {}) {
  return {
    title: "Search Matter",
    details: "Matter details used for authorization-aware search tests.",
    status: "open",
    attorney: attorney._id,
    attorneyId: attorney._id,
    practiceArea: "Civil Litigation",
    totalAmount: 100000,
    currency: "usd",
    ...overrides,
  };
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("authenticated Matter and Profile search", () => {
  test("requires a current approved authenticated attorney or paralegal", async () => {
    const anonymous = await request(app).get("/api/cases/search?q=search");
    expect(anonymous.status).toBe(401);

    const pending = await User.create(userFields({ status: "pending" }));
    const pendingResponse = await request(app)
      .get("/api/cases/search?q=search")
      .set("Cookie", authCookieFor(pending));
    expect(pendingResponse.status).toBe(403);

    const admin = await User.create(userFields({ role: "admin" }));
    const adminResponse = await request(app)
      .get("/api/cases/search?q=search")
      .set("Cookie", authCookieFor(admin));
    expect(adminResponse.status).toBe(403);
  });

  test("returns only the attorney's Matters and eligible unblocked public Profiles", async () => {
    const attorney = await User.create(userFields({ firstName: "Avery" }));
    const otherAttorney = await User.create(userFields({ firstName: "Other" }));
    const visibleProfile = await User.create(publicProfileFields());
    const hiddenProfile = await User.create(publicProfileFields({ firstName: "Search Hidden", preferences: { hideProfile: true } }));
    const incompleteProfile = await User.create(publicProfileFields({ firstName: "Search Incomplete", resumeURL: "" }));
    const unapprovedProfile = await User.create(publicProfileFields({ firstName: "Search Pending", status: "pending" }));
    const blockedProfile = await User.create(publicProfileFields({ firstName: "Search Blocked" }));
    const ownMatter = await Case.create(matterFields(attorney, { title: "Search Own Matter" }));
    await Case.create(matterFields(otherAttorney, { title: "Search Other Matter" }));
    await Block.create({
      blockerId: attorney._id,
      blockedId: blockedProfile._id,
      blockerRole: "attorney",
      blockedRole: "paralegal",
      sourceType: "legacy",
    });

    const response = await request(app)
      .get("/api/cases/search?q=search")
      .set("Cookie", authCookieFor(attorney));

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.results.matters.map((item) => item.id)).toEqual([String(ownMatter._id)]);
    expect(response.body.results.profiles.map((item) => item.id)).toEqual([String(visibleProfile._id)]);
    expect(response.body.results.profiles.map((item) => item.id)).not.toEqual(
      expect.arrayContaining([
        String(hiddenProfile._id),
        String(incompleteProfile._id),
        String(unapprovedProfile._id),
        String(blockedProfile._id),
      ])
    );

    const matter = response.body.results.matters[0];
    expect(Object.keys(matter).sort()).toEqual(
      ["attention", "id", "nextAction", "practiceArea", "relationship", "status", "title", "type"].sort()
    );
    expect(matter.nextAction.href).toBe(`/case-detail.html?caseId=${ownMatter._id}`);
    expect(JSON.stringify(response.body)).not.toMatch(/stripe|escrow|applicants|email|resume|client|internal/i);

    const fullName = await request(app)
      .get(`/api/cases/search?q=${encodeURIComponent("Taylor Searchable")}&types=profile`)
      .set("Cookie", authCookieFor(attorney));
    expect(fullName.status).toBe(200);
    expect(fullName.body.results.profiles.map((item) => item.id)).toEqual([String(visibleProfile._id)]);
  });

  test("paralegal results mirror assigned, applicant, and discoverable access without leaking private or stale Matters", async () => {
    const paralegal = await User.create(publicProfileFields({ firstName: "Pat" }));
    const attorney = await User.create(userFields({ firstName: "Owner" }));
    const blockedAttorney = await User.create(userFields({ firstName: "Blocked Owner" }));
    const assigned = await Case.create(matterFields(attorney, {
      title: "Access Assigned Search",
      status: "in progress",
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
    }));
    const applicant = await Case.create(matterFields(attorney, {
      title: "Access Applicant Search",
      status: "open",
      applicants: [{ paralegalId: paralegal._id, status: "pending" }],
    }));
    const discoverable = await Case.create(matterFields(attorney, { title: "Access Discoverable Search" }));
    await Case.create(matterFields(attorney, { title: "Access Private Search", status: "in progress" }));
    await Case.create(matterFields(attorney, {
      title: "Access Completed Search",
      status: "completed",
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
    }));
    await Case.create(matterFields(attorney, {
      title: "Access Revoked Search",
      status: "in progress",
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      paralegalAccessRevokedAt: new Date(),
      applicants: [{ paralegalId: paralegal._id, status: "pending" }],
    }));
    await Case.create(matterFields(attorney, {
      title: "Access Invite Only Search",
      status: "in progress",
      pendingParalegalId: paralegal._id,
      invites: [{ paralegalId: paralegal._id, status: "pending" }],
    }));
    await Case.create(matterFields(blockedAttorney, { title: "Access Blocked Search" }));
    await Block.create({
      blockerId: blockedAttorney._id,
      blockedId: paralegal._id,
      blockerRole: "attorney",
      blockedRole: "paralegal",
      sourceType: "legacy",
    });

    const response = await request(app)
      .get("/api/cases/search?q=access")
      .set("Cookie", authCookieFor(paralegal));

    expect(response.status).toBe(200);
    const ids = response.body.results.matters.map((item) => item.id);
    expect(ids.sort()).toEqual([String(assigned._id), String(applicant._id), String(discoverable._id)].sort());
    expect(response.body.results.profiles).toEqual([]);
    const assignedResult = response.body.results.matters.find((item) => item.id === String(assigned._id));
    const discoverableResult = response.body.results.matters.find((item) => item.id === String(discoverable._id));
    expect(assignedResult.nextAction.href).toBe(`/case-detail.html?caseId=${assigned._id}`);
    expect(discoverableResult.nextAction.href).toBe(`/browse-jobs.html?caseId=${discoverable._id}`);
  });

  test("normalizes input, rejects invalid bounds/types, and keeps each query bounded", async () => {
    const attorney = await User.create(userFields());
    await Case.create(matterFields(attorney, { title: "AB Matter Search" }));
    for (let index = 0; index < SEARCH_RESULT_LIMIT + 2; index += 1) {
      await Case.create(matterFields(attorney, { title: `Bounded Search ${index}` }));
    }

    const normalized = await request(app)
      .get(`/api/cases/search?q=${encodeURIComponent("  ＡＢ\t  Matter  ")}&types=matter`)
      .set("Cookie", authCookieFor(attorney));
    expect(normalized.status).toBe(200);
    expect(normalized.body.query).toBe("AB Matter");
    expect(normalized.body.results.matters).toHaveLength(1);

    const regexCharacters = await request(app)
      .get(`/api/cases/search?q=${encodeURIComponent("Matter (")}&types=matter`)
      .set("Cookie", authCookieFor(attorney));
    expect(regexCharacters.status).toBe(200);
    expect(regexCharacters.body.results.matters).toEqual([]);

    const tooShort = await request(app)
      .get("/api/cases/search?q=a")
      .set("Cookie", authCookieFor(attorney));
    expect(tooShort.status).toBe(400);

    const tooLong = await request(app)
      .get(`/api/cases/search?q=${"x".repeat(SEARCH_QUERY_MAX + 1)}`)
      .set("Cookie", authCookieFor(attorney));
    expect(tooLong.status).toBe(400);

    const invalidType = await request(app)
      .get("/api/cases/search?q=search&types=financial")
      .set("Cookie", authCookieFor(attorney));
    expect(invalidType.status).toBe(400);

    const bounded = await request(app)
      .get("/api/cases/search?q=bounded&types=matter")
      .set("Cookie", authCookieFor(attorney));
    expect(bounded.status).toBe(200);
    expect(bounded.body.results.matters).toHaveLength(SEARCH_RESULT_LIMIT);
  });

  test("ranks exact title, prefix, strong token, then recency before applying the result cap", async () => {
    const attorney = await User.create(userFields());
    const tokenOnly = await Case.create(matterFields(attorney, { title: "Matter litigation", practiceArea: "Civil Search" }));
    const prefix = await Case.create(matterFields(attorney, { title: "Search Matter extension" }));
    const exact = await Case.create(matterFields(attorney, { title: "Search Matter" }));
    await Case.updateOne({ _id: tokenOnly._id }, { $set: { updatedAt: new Date("2030-01-01T00:00:00Z") } });
    await Case.updateOne({ _id: prefix._id }, { $set: { updatedAt: new Date("2029-01-01T00:00:00Z") } });
    await Case.updateOne({ _id: exact._id }, { $set: { updatedAt: new Date("2020-01-01T00:00:00Z") } });

    const response = await request(app)
      .get(`/api/cases/search?q=${encodeURIComponent("Search Matter")}&types=matter`)
      .set("Cookie", authCookieFor(attorney));

    expect(response.status).toBe(200);
    expect(response.body.results.matters.map((item) => item.id).slice(0, 2)).toEqual([
      String(exact._id),
      String(prefix._id),
    ]);
  });

  test("suppresses rejected, revoked, and blocked applicant relationships", async () => {
    const viewer = await User.create(publicProfileFields({ firstName: "Boundary" }));
    const attorney = await User.create(userFields({ firstName: "Visible" }));
    const blockedAttorney = await User.create(userFields({ firstName: "Blocked" }));
    await Case.create(matterFields(attorney, {
      title: "Boundary Rejected",
      status: "in progress",
      applicants: [{ paralegalId: viewer._id, status: "rejected" }],
    }));
    await Case.create(matterFields(attorney, {
      title: "Boundary Revoked",
      status: "in progress",
      paralegalAccessRevokedAt: new Date(),
      applicants: [{ paralegalId: viewer._id, status: "pending" }],
    }));
    await Case.create(matterFields(blockedAttorney, {
      title: "Boundary Blocked",
      applicants: [{ paralegalId: viewer._id, status: "pending" }],
    }));
    await Block.create({
      blockerId: blockedAttorney._id,
      blockedId: viewer._id,
      blockerRole: "attorney",
      blockedRole: "paralegal",
      sourceType: "legacy",
    });

    const response = await request(app)
      .get("/api/cases/search?q=boundary&types=matter")
      .set("Cookie", authCookieFor(viewer));

    expect(response.status).toBe(200);
    expect(response.body.results.matters).toEqual([]);
  });

  test("open Matter detail suppresses other candidates for a paralegal viewer", async () => {
    const attorney = await User.create(userFields());
    const viewer = await User.create(publicProfileFields({ firstName: "Viewer" }));
    const other = await User.create(publicProfileFields({ firstName: "Other" }));
    const matter = await Case.create(matterFields(attorney, {
      title: "Candidate Privacy Matter",
      escrowIntentId: "pi_private_candidate",
      escrowStatus: "funded",
      tasks: [{ title: "Private assigned task", completed: true }],
      files: [{ filename: "private.pdf", key: "cases/private/storage-key", uploadedBy: attorney._id }],
      applicants: [
        { paralegalId: viewer._id, status: "pending", note: "Viewer cover letter" },
        { paralegalId: other._id, status: "pending", note: "Private cover letter" },
      ],
    }));

    const response = await request(app)
      .get(`/api/cases/${matter._id}`)
      .set("Cookie", authCookieFor(viewer));

    expect(response.status).toBe(200);
    expect(response.body.applicants).toHaveLength(1);
    expect(response.body.applicants[0].paralegalId).toBe(String(viewer._id));
    expect(JSON.stringify(response.body.applicants)).not.toContain("Private cover letter");
    expect(response.body.matterContext.relationship).toEqual({ code: "applicant", label: "You applied" });
    expect(response.body.matterContext.nextAction.href).toBe(`/case-detail.html?caseId=${matter._id}&tab=applications`);
    expect(response.body.tasks).toEqual([]);
    expect(response.body.paralegal).toBeNull();
    expect(response.body.hiredAt).toBeNull();
    expect(response.body.completedAt).toBeNull();
    expect(response.body.paralegalAccessRevokedAt).toBeNull();
    expect(response.body.tasksLocked).toBe(false);
    expect(response.body.escrowIntentId).toBeUndefined();
    expect(response.body.files).toEqual([]);
    expect(response.body.matterExperience.overview.hiredAt).toBeNull();
    expect(response.body.matterExperience.sections.map((item) => item.id)).toEqual([
      "overview", "applications", "activity",
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/pi_private_candidate|storage-key|Private assigned task/);

    const applicantsResponse = await request(app)
      .get(`/api/cases/${matter._id}/applicants`)
      .set("Cookie", authCookieFor(viewer));
    expect(applicantsResponse.status).toBe(200);
    expect(applicantsResponse.body.applicants).toHaveLength(1);
    expect(applicantsResponse.body.applicants[0].paralegalId).toBe(String(viewer._id));
    expect(JSON.stringify(applicantsResponse.body)).not.toContain("Private cover letter");
  });

  test("revoked participants are denied shared Matter middleware and safe file manifests omit storage evidence", async () => {
    const attorney = await User.create(userFields());
    const paralegal = await User.create(publicProfileFields({ firstName: "Revoked" }));
    const matter = await Case.create(matterFields(attorney, {
      title: "Revoked workspace",
      status: "in progress",
      escrowIntentId: "pi_private_funded",
      escrowStatus: "funded",
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      paralegalAccessRevokedAt: new Date(),
    }));
    await expect(assertCaseParticipant({
      user: { id: String(paralegal._id), role: "paralegal" },
      baseUrl: "/api/messages",
      path: `/${matter._id}`,
      method: "GET",
    }, String(matter._id))).rejects.toMatchObject({ statusCode: 403 });

    const active = await User.create(publicProfileFields({ firstName: "Active" }));
    matter.paralegal = active._id;
    matter.paralegalId = active._id;
    matter.paralegalAccessRevokedAt = null;
    await matter.save();
    await CaseFile.create({
      caseId: matter._id,
      userId: active._id,
      originalName: "work-product.pdf",
      storageKey: `cases/${matter._id}/private/work-product.pdf`,
      previewKey: `cases/${matter._id}/private/work-product-preview.pdf`,
      mimeType: "application/pdf",
      uploadedByRole: "paralegal",
    });

    const response = await request(app)
      .get(`/api/uploads/case/${matter._id}?presentation=matter`)
      .set("Cookie", authCookieFor(active));
    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0]).toEqual(expect.objectContaining({
      originalName: "work-product.pdf",
      uploadedByRole: "paralegal",
    }));
    expect(JSON.stringify(response.body)).not.toMatch(/storageKey|previewKey|private\/work-product|userId/);
  });
});
