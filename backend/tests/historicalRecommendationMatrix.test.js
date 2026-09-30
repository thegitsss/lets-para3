const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_history_matrix";
process.env.EMAIL_DISABLE = "true";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

jest.mock("../utils/stripe", () => ({
  customers: {
    retrieve: jest.fn(async () => ({
      invoice_settings: { default_payment_method: "pm_history_matrix" },
    })),
  },
  accounts: {
    retrieve: jest.fn(async () => ({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    })),
  },
}));

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const applicationsRouter = require("../routes/applications");
const jobsRouter = require("../routes/jobs");
const casesRouter = require("../routes/cases");
const paralegalDashboardRouter = require("../routes/paralegalDashboard");
const { syncApplicantsCount } = require("../services/applicationService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const APPLICATION_STATUSES = [
  "submitted",
  "viewed",
  "shortlisted",
  "accepted",
  "rejected",
  "withdrawn",
];
const ACTIVE_QUEUE_STATUSES = new Set(["submitted", "viewed", "shortlisted"]);
const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/applications", applicationsRouter);
  instance.use("/api/jobs", jobsRouter);
  instance.use("/api/paralegal/dashboard", paralegalDashboardRouter);
  instance.use("/api/cases", casesRouter);
  instance.use((err, _req, res, _next) => {
    res.status(500).json({ error: err?.message || "Server error" });
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

async function createFixture(status) {
  const attorney = await User.create({
    firstName: "History",
    lastName: "Attorney",
    email: "samanthasider+attorney@gmail.com",
    password: "Password123!",
    role: "attorney",
    status: "approved",
    state: "CA",
  });
  const paralegal = await User.create({
    firstName: "History",
    lastName: "Paralegal",
    email: "history-paralegal@example.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    state: "CA",
    stateExperience: ["CA"],
    practiceAreas: ["Immigration"],
    yearsExperience: 8,
    profileImage: "https://example.com/profile.jpg",
    stripeAccountId: "acct_history_matrix",
    stripeOnboarded: true,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
  });
  const otherParalegal = await User.create({
    firstName: "Other",
    lastName: "Paralegal",
    email: "other-history-paralegal@example.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    state: "CA",
    stateExperience: ["CA"],
    practiceAreas: ["Immigration"],
    yearsExperience: 8,
    profileImage: "https://example.com/other-profile.jpg",
    stripeAccountId: "acct_other_history_matrix",
    stripeOnboarded: true,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
  });
  const caseDoc = await Case.create({
    attorney: attorney._id,
    attorneyId: attorney._id,
    title: `Historical ${status} Matter`,
    details: "Prepare and organize an immigration filing packet for attorney review.",
    practiceArea: "Immigration",
    state: "CA",
    locationState: "CA",
    experiencePreference: "5+ years",
    minimumYearsExperience: 5,
    totalAmount: 60_000,
    status: "open",
    applicants: status === "withdrawn"
      ? []
      : [{
          paralegalId: paralegal._id,
          status: status === "accepted" || status === "rejected" ? status : "pending",
          note: "Historical application fixture cover letter.",
        }],
  });
  const job = await Job.create({
    caseId: caseDoc._id,
    attorneyId: attorney._id,
    title: caseDoc.title,
    practiceArea: caseDoc.practiceArea,
    description: caseDoc.details,
    state: "CA",
    locationState: "CA",
    experiencePreference: "5+ years",
    minimumYearsExperience: 5,
    budget: 600,
    status: "open",
  });
  caseDoc.jobId = job._id;
  await caseDoc.save();
  const application = await Application.create({
    jobId: job._id,
    paralegalId: paralegal._id,
    coverLetter: "Historical application fixture cover letter.",
    status,
    withdrawnAt: status === "withdrawn" ? new Date() : null,
    syncStatus: "synced",
    syncedAt: new Date(),
    statusHistory: [{ to: status, reason: "history_matrix_fixture", at: new Date() }],
  });
  await syncApplicantsCount(job._id);
  return { attorney, paralegal, otherParalegal, caseDoc, job, application };
}

function listingIds(listing = {}) {
  return [listing.id, listing._id, listing.caseId, listing.contextCaseId, listing.jobId]
    .map((value) => String(value || ""))
    .filter(Boolean);
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("historical recommendation surface matrix", () => {
  test.each(APPLICATION_STATUSES)(
    "%s remains excluded from Home Recommendations while other surfaces preserve their own rules",
    async (status) => {
      const fixture = await createFixture(status);
      const paralegalCookie = authCookieFor(fixture.paralegal);
      const attorneyCookie = authCookieFor(fixture.attorney);

      const [exclusions, recommendations, browse, search, details, applications, candidates, dashboard] = await Promise.all([
        request(app).get("/api/applications/recommendation-exclusions").set("Cookie", paralegalCookie),
        request(app).get("/api/jobs/recommended").set("Cookie", paralegalCookie),
        request(app).get("/api/jobs/open").set("Cookie", paralegalCookie),
        request(app).get("/api/cases/search?q=historical&types=matter").set("Cookie", paralegalCookie),
        request(app).get(`/api/cases/${fixture.caseDoc._id}`).set("Cookie", paralegalCookie),
        request(app).get("/api/applications/my").set("Cookie", paralegalCookie),
        request(app).get("/api/applications/my-postings").set("Cookie", attorneyCookie),
        request(app).get("/api/paralegal/dashboard").set("Cookie", paralegalCookie),
      ]);

      expect(exclusions.status).toBe(200);
      expect(exclusions.headers["cache-control"]).toContain("no-store");
      expect(exclusions.body.applicationCount).toBe(1);
      expect(exclusions.body.jobIds).toContain(String(fixture.job._id));
      expect(exclusions.body.caseIds).toContain(String(fixture.caseDoc._id));
      expect(recommendations.status).toBe(200);
      expect(recommendations.headers["cache-control"]).toContain("no-store");
      expect(recommendations.body.items).toEqual([]);

      expect(browse.status).toBe(200);
      const listing = browse.body.find((item) => String(item.id) === String(fixture.caseDoc._id));
      expect(listing).toBeDefined();
      const excludedIds = new Set(exclusions.body.matterIds.map(String));
      const homeRecommendedVisible = !listingIds(listing).some((id) => excludedIds.has(id));
      expect(homeRecommendedVisible).toBe(false);

      expect(search.status).toBe(200);
      expect(search.body.results.matters.map((item) => item.id)).toContain(String(fixture.caseDoc._id));
      expect(details.status).toBe(200);
      expect(String(details.body._id || details.body.id)).toBe(String(fixture.caseDoc._id));

      expect(applications.status).toBe(200);
      const applicationsApiVisible = applications.body.some(
        (entry) => String(entry._id || entry.id) === String(fixture.application._id)
      );
      // The own-application endpoint retains every outcome for Work history.
      expect(applicationsApiVisible).toBe(true);
      const applicationsSectionVisible = applicationsApiVisible && ACTIVE_QUEUE_STATUSES.has(status);
      expect(applicationsSectionVisible).toBe(ACTIVE_QUEUE_STATUSES.has(status));

      expect(candidates.status).toBe(200);
      expect(candidates.body.some((entry) => String(entry.id) === String(fixture.application._id))).toBe(
        ACTIVE_QUEUE_STATUSES.has(status)
      );
      expect(dashboard.status).toBe(200);
      expect(dashboard.body.metrics.pendingApplications).toBe(ACTIVE_QUEUE_STATUSES.has(status) ? 1 : 0);
      expect(dashboard.body.myApplications).toHaveLength(status === "withdrawn" ? 0 : 1);
      expect(listing.applicantsCount).toBe(ACTIVE_QUEUE_STATUSES.has(status) ? 1 : 0);

      const directApplication = await request(app)
        .post(`/api/jobs/${fixture.job._id}/apply`)
        .set("Cookie", paralegalCookie)
        .send({ coverLetter: "This is a sufficiently detailed manual reapplication cover letter." });
      if (status === "withdrawn") {
        expect(directApplication.status).toBe(201);
        expect(await Application.countDocuments({ paralegalId: fixture.paralegal._id })).toBe(1);
        expect((await Application.findById(fixture.application._id).lean()).status).toBe("submitted");
      } else {
        expect(directApplication.status).toBe(400);
        expect(directApplication.body.error).toMatch(/already applied/i);
      }
    }
  );

  test("the same open Matter remains recommended for another eligible paralegal", async () => {
    const fixture = await createFixture("rejected");
    const [applicantExclusions, otherExclusions, browse, otherRecommendations] = await Promise.all([
      request(app)
        .get("/api/applications/recommendation-exclusions")
        .set("Cookie", authCookieFor(fixture.paralegal)),
      request(app)
        .get("/api/applications/recommendation-exclusions")
        .set("Cookie", authCookieFor(fixture.otherParalegal)),
      request(app).get("/api/jobs/open").set("Cookie", authCookieFor(fixture.otherParalegal)),
      request(app).get("/api/jobs/recommended").set("Cookie", authCookieFor(fixture.otherParalegal)),
    ]);
    const listing = browse.body.find((item) => String(item.id) === String(fixture.caseDoc._id));
    expect(listing).toBeDefined();
    expect(listingIds(listing).some((id) => new Set(applicantExclusions.body.matterIds).has(id))).toBe(true);
    expect(listingIds(listing).some((id) => new Set(otherExclusions.body.matterIds).has(id))).toBe(false);
    expect(otherRecommendations.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.caseDoc._id.toString(),
        recommendation: expect.objectContaining({ reason: "state_and_practice" }),
      }),
    ]));
  });

  test("the V2 dashboard retains an active Matter stored only through legacy participant and status aliases", async () => {
    const fixture = await createFixture("accepted");
    await Case.collection.updateOne(
      { _id: fixture.caseDoc._id },
      {
        $set: {
          paralegal: fixture.paralegal._id,
          status: "funded_in_progress",
          archived: false,
          paymentReleased: false,
        },
        $unset: { paralegalId: "", attorneyId: "" },
      }
    );

    const dashboard = await request(app)
      .get("/api/paralegal/dashboard")
      .set("Cookie", authCookieFor(fixture.paralegal));

    expect(dashboard.status).toBe(200);
    expect(dashboard.body.metrics.activeCases).toBe(1);
    expect(dashboard.body.activeCases).toEqual([
      expect.objectContaining({
        caseId: String(fixture.caseDoc._id),
        status: "in progress",
        attorneyName: "History Attorney",
        paralegalId: String(fixture.paralegal._id),
      }),
    ]);
  });

  test.each(["pending", "rejected", "accepted"])(
    "legacy Case.applicants %s evidence excludes recommendations without a canonical Application",
    async (legacyStatus) => {
      const fixture = await createFixture("submitted");
      await Promise.all([
        Application.deleteMany({ paralegalId: fixture.paralegal._id }),
        Case.updateOne(
          { _id: fixture.caseDoc._id, "applicants.paralegalId": fixture.paralegal._id },
          { $set: { "applicants.$.status": legacyStatus } }
        ),
      ]);

      const [exclusions, recommendations, otherRecommendations] = await Promise.all([
        request(app)
          .get("/api/applications/recommendation-exclusions")
          .set("Cookie", authCookieFor(fixture.paralegal)),
        request(app).get("/api/jobs/recommended").set("Cookie", authCookieFor(fixture.paralegal)),
        request(app).get("/api/jobs/recommended").set("Cookie", authCookieFor(fixture.otherParalegal)),
      ]);

      expect(exclusions.status).toBe(200);
      expect(exclusions.body.applicationCount).toBe(0);
      expect(exclusions.body.legacyApplicantEvidenceCount).toBe(1);
      expect(exclusions.body.caseIds).toContain(String(fixture.caseDoc._id));
      expect(exclusions.body.jobIds).toContain(String(fixture.job._id));
      expect(recommendations.body.items).toEqual([]);
      expect(otherRecommendations.body.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: String(fixture.caseDoc._id) }),
      ]));
    }
  );

  test("Case identity excludes a Case-only listing when its historical Job is closed", async () => {
    const fixture = await createFixture("withdrawn");
    await Job.updateOne({ _id: fixture.job._id }, { $set: { status: "closed" } });

    const [exclusions, browse] = await Promise.all([
      request(app)
        .get("/api/applications/recommendation-exclusions")
        .set("Cookie", authCookieFor(fixture.paralegal)),
      request(app).get("/api/jobs/open").set("Cookie", authCookieFor(fixture.paralegal)),
    ]);

    const listing = browse.body.find((item) => String(item.id) === String(fixture.caseDoc._id));
    expect(listing).toEqual(expect.objectContaining({ jobId: null }));
    expect(exclusions.body.caseIds).toContain(String(fixture.caseDoc._id));
    expect(listingIds(listing).some((id) => new Set(exclusions.body.matterIds).has(id))).toBe(true);
  });

  test("a replacement Job identity for the same Case cannot bypass historical exclusion", async () => {
    const fixture = await createFixture("rejected");
    const replacementJob = await Job.create({
      attorneyId: fixture.attorney._id,
      title: fixture.caseDoc.title,
      practiceArea: fixture.caseDoc.practiceArea,
      description: fixture.caseDoc.details,
      state: "CA",
      locationState: "CA",
      experiencePreference: "5+ years",
      minimumYearsExperience: 5,
      budget: 600,
      status: "open",
    });
    await Promise.all([
      Job.updateOne({ _id: fixture.job._id }, { $set: { status: "closed" } }),
      Case.updateOne({ _id: fixture.caseDoc._id }, { $set: { jobId: replacementJob._id } }),
    ]);

    const [exclusions, browse] = await Promise.all([
      request(app)
        .get("/api/applications/recommendation-exclusions")
        .set("Cookie", authCookieFor(fixture.paralegal)),
      request(app).get("/api/jobs/open").set("Cookie", authCookieFor(fixture.paralegal)),
    ]);

    expect(exclusions.body.caseIds).toContain(String(fixture.caseDoc._id));
    expect(exclusions.body.jobIds).toEqual(
      expect.arrayContaining([String(fixture.job._id), String(replacementJob._id)])
    );
    const replacementListing = browse.body.find(
      (item) => String(item.jobId) === String(replacementJob._id)
    );
    expect(replacementListing).toBeDefined();
    expect(
      listingIds(replacementListing).some((id) => new Set(exclusions.body.matterIds).has(id))
    ).toBe(true);
  });

  test("hiring and Job assignment remove the Matter from Browse without erasing history", async () => {
    const fixture = await createFixture("accepted");
    await Promise.all([
      Job.updateOne({ _id: fixture.job._id }, { $set: { status: "assigned" } }),
      Case.updateOne(
        { _id: fixture.caseDoc._id },
        {
          $set: {
            status: "in progress",
            paralegal: fixture.paralegal._id,
            paralegalId: fixture.paralegal._id,
            hiredAt: new Date(),
            escrowStatus: "funded",
            escrowIntentId: "pi_history_matrix",
            fundingIntegrityStatus: "verified",
          },
        }
      ),
    ]);

    const [exclusions, browse] = await Promise.all([
      request(app)
        .get("/api/applications/recommendation-exclusions")
        .set("Cookie", authCookieFor(fixture.paralegal)),
      request(app).get("/api/jobs/open").set("Cookie", authCookieFor(fixture.paralegal)),
    ]);

    expect(browse.body.some((item) => String(item.id) === String(fixture.caseDoc._id))).toBe(false);
    expect(exclusions.body.caseIds).toContain(String(fixture.caseDoc._id));
    expect(exclusions.body.jobIds).toContain(String(fixture.job._id));
  });

  test("active-matter withdrawal and relisting restore Browse only, not Recommendations", async () => {
    const fixture = await createFixture("accepted");
    const finalizedAt = new Date();
    await Promise.all([
      Application.updateOne(
        { _id: fixture.application._id },
        { $set: { status: "withdrawn", withdrawnAt: finalizedAt } }
      ),
      Job.updateOne({ _id: fixture.job._id }, { $set: { status: "open" } }),
      Case.updateOne(
        { _id: fixture.caseDoc._id },
        {
          $set: {
            status: "paused",
            paralegal: null,
            paralegalId: null,
            withdrawnParalegalId: fixture.paralegal._id,
            pausedReason: "paralegal_withdrew",
            payoutFinalizedType: "zero_auto",
            payoutFinalizedAt: finalizedAt,
            relistRequestedAt: finalizedAt,
          },
        }
      ),
    ]);

    const [exclusions, browse] = await Promise.all([
      request(app)
        .get("/api/applications/recommendation-exclusions")
        .set("Cookie", authCookieFor(fixture.paralegal)),
      request(app).get("/api/jobs/open").set("Cookie", authCookieFor(fixture.paralegal)),
    ]);
    const listing = browse.body.find((item) => String(item.id) === String(fixture.caseDoc._id));
    expect(listing).toBeDefined();
    expect(listingIds(listing).some((id) => new Set(exclusions.body.matterIds).has(id))).toBe(true);
  });

  test("a newly submitted application appears in the authoritative exclusions on refresh", async () => {
    const fixture = await createFixture("withdrawn");
    await Application.deleteMany({ paralegalId: fixture.otherParalegal._id });
    const otherCookie = authCookieFor(fixture.otherParalegal);
    const before = await request(app)
      .get("/api/applications/recommendation-exclusions")
      .set("Cookie", otherCookie);
    expect(before.body.matterIds).toEqual([]);

    const applied = await request(app)
      .post(`/api/jobs/${fixture.job._id}/apply`)
      .set("Cookie", otherCookie)
      .send({ coverLetter: "This is a sufficiently detailed first application cover letter." });
    expect(applied.status).toBe(201);

    const after = await request(app)
      .get("/api/applications/recommendation-exclusions")
      .set("Cookie", otherCookie);
    expect(after.body.caseIds).toContain(String(fixture.caseDoc._id));
    expect(after.body.jobIds).toContain(String(fixture.job._id));
  });

  test("the exclusion endpoint is paralegal-only", async () => {
    const fixture = await createFixture("submitted");
    const response = await request(app)
      .get("/api/applications/recommendation-exclusions")
      .set("Cookie", authCookieFor(fixture.attorney));
    expect(response.status).toBe(403);
  });

  test("the discovery version changes without exposing Matter data and remains paralegal-only", async () => {
    const fixture = await createFixture("withdrawn");
    const cookie = authCookieFor(fixture.paralegal);
    const before = await request(app).get("/api/jobs/discovery-version").set("Cookie", cookie);
    expect(before.status).toBe(200);
    expect(before.headers["cache-control"]).toContain("no-store");
    expect(Object.keys(before.body)).toEqual(["version"]);
    expect(typeof before.body.version).toBe("string");

    await Promise.all([
      Case.updateOne({ _id: fixture.caseDoc._id }, { $set: { archived: true } }),
      Job.updateOne({ _id: fixture.job._id }, { $set: { status: "closed" } }),
    ]);
    const after = await request(app).get("/api/jobs/discovery-version").set("Cookie", cookie);
    expect(after.status).toBe(200);
    expect(after.body.version).not.toBe(before.body.version);

    const attorney = await request(app)
      .get("/api/jobs/discovery-version")
      .set("Cookie", authCookieFor(fixture.attorney));
    expect(attorney.status).toBe(403);
  });

  test("published Matter edits stay consistent in the compatibility Job and paralegal discovery projection", async () => {
    const fixture = await createFixture("withdrawn");
    const update = await request(app)
      .patch(`/api/cases/${fixture.caseDoc._id}`)
      .set("Cookie", authCookieFor(fixture.attorney))
      .send({
        title: "Updated immigration evidence review",
        details: "Review, organize, and summarize the updated immigration evidence packet for attorney review.",
        practiceArea: "Immigration",
        budget: 750,
        experiencePreference: "7+ years",
      });
    expect(update.status).toBe(200);

    const mirrored = await Job.findById(fixture.job._id).lean();
    expect(mirrored).toEqual(expect.objectContaining({
      title: "Updated immigration evidence review",
      description: "Review, organize, and summarize the updated immigration evidence packet for attorney review.",
      practiceArea: "immigration",
      budget: 750,
      state: "CA",
      locationState: "CA",
      experiencePreference: "7+ years",
      minimumYearsExperience: 7,
    }));

    const browse = await request(app)
      .get("/api/jobs/open")
      .set("Cookie", authCookieFor(fixture.otherParalegal));
    expect(browse.status).toBe(200);
    expect(browse.body.find((item) => String(item.id) === String(fixture.caseDoc._id))).toEqual(
      expect.objectContaining({
        title: "Updated immigration evidence review",
        description: "Review, organize, and summarize the updated immigration evidence packet for attorney review.",
        practiceArea: "immigration",
        budget: 750,
        state: "CA",
        minimumYearsExperience: 7,
      })
    );
  });
});
