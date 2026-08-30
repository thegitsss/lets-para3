const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Job = require("../models/Job");
const Case = require("../models/Case");

jest.mock("../utils/stripe", () => ({
  customers: {
    retrieve: jest.fn(async () => ({
      invoice_settings: { default_payment_method: "pm_test_123" },
    })),
  },
}));

const jobsRouter = require("../routes/jobs");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/jobs", jobsRouter);
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

describe("Matching + discovery", () => {
  test("Paralegals can see all posted jobs", async () => {
    // Description: Fetch /api/jobs/open as a paralegal.
    // Input values: two open jobs (CA immigration, NY business law).
    // Expected result: response includes both jobs.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
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

    await Job.create([
      {
        attorneyId: attorney._id,
        title: "Immigration filing support",
        practiceArea: "Immigration",
        description: "Assist with client intake and USCIS packet review for a family-based filing.",
        budget: 600,
        state: "CA",
        experiencePreference: "5+ years",
        minimumYearsExperience: 5,
        status: "open",
      },
      {
        attorneyId: attorney._id,
        title: "Contract review",
        practiceArea: "Business Law",
        description: "Review vendor contracts and summarize key risk areas for counsel.",
        budget: 500,
        state: "NY",
        status: "open",
      },
    ]);

    const cookie = authCookieFor(paralegal);

    const res = await request(app)
      .get("/api/jobs/open")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const titles = res.body.map((job) => job.title).sort();
    expect(titles).toEqual(["Contract review", "Immigration filing support"].sort());
    expect(res.body.find((job) => job.title === "Immigration filing support")).toEqual(
      expect.objectContaining({
        state: "CA",
        experiencePreference: "5+ years",
        minimumYearsExperience: 5,
      })
    );
  });

  test("Non-paralegals are blocked from job discovery", async () => {
    // Description: Fetch /api/jobs/open as an attorney.
    // Input values: role="attorney".
    // Expected result: 403 forbidden.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "samanthasider+attorney2@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const cookie = authCookieFor(attorney);

    const res = await request(app)
      .get("/api/jobs/open")
      .set("Cookie", cookie);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  });

  test("alternate job posting mirrors the linked Matter state and experience minimum", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      attorney: attorney._id,
      attorneyId: attorney._id,
      title: "New York injury records review",
      details: "Organize medical records and prepare a detailed chronology for counsel review.",
      practiceArea: "personal injury",
      state: "NY",
      locationState: "NY",
      experiencePreference: "5+ years",
      minimumYearsExperience: 5,
      totalAmount: 60_000,
      status: "open",
    });

    const res = await request(app)
      .post("/api/jobs")
      .set("Cookie", authCookieFor(attorney))
      .send({
        caseId: String(caseDoc._id),
        title: caseDoc.title,
        description: caseDoc.details,
        practiceArea: caseDoc.practiceArea,
        budget: 600,
        state: "CA",
        experiencePreference: "1+ years",
        minimumYearsExperience: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        state: "NY",
        locationState: "NY",
        experiencePreference: "5+ years",
        minimumYearsExperience: 5,
      })
    );
  });
});
