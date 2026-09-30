const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Notification = require("../models/Notification");
const usersRouter = require("../routes/users");
const { addSubscriber } = require("../utils/notificationEvents");

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/users", usersRouter);
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

afterAll(async () => {
  await closeDatabase();
});

beforeAll(async () => {
  await connect();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Validation logic (server-side)", () => {
  test("legacy notification reads publish the same immediate refresh event as the current notification routes", async () => {
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.notification-read@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "WA",
    });
    await Notification.create({
      userId: paralegal._id,
      userRole: "paralegal",
      type: "case_update",
      message: "A Matter changed.",
    });
    const writes = [];
    const unsubscribe = addSubscriber(paralegal._id, { write: (value) => writes.push(String(value)) });

    const response = await request(app)
      .post("/api/users/me/notifications/read")
      .set("Cookie", authCookieFor(paralegal))
      .send({ type: "case_update" });
    unsubscribe();

    expect(response.status).toBe(200);
    expect(await Notification.countDocuments({ userId: paralegal._id, read: false })).toBe(0);
    expect(writes.join("\n")).toContain("event: notifications");
    expect(writes.join("\n")).toContain("notification_read_refresh");
  });

  test("Paralegal yearsExperience is clamped to 0..80", async () => {
    // Description: Update paralegal profile with out-of-range yearsExperience values.
    // Input values: yearsExperience=200 then yearsExperience=-5.
    // Expected result: yearsExperience becomes 80 then 0.

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.validation@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "WA",
      bio: "Bio",
      skills: ["Research"],
      practiceAreas: ["Immigration"],
      resumeURL: "paralegal-resumes/p1/resume.pdf",
      profileImage: "paralegal-photos/p1.jpg",
      profilePhotoStatus: "approved",
    });

    const cookie = authCookieFor(paralegal);

    const highRes = await request(app)
      .patch("/api/users/me")
      .set("Cookie", cookie)
      .send({ yearsExperience: 200 });

    expect(highRes.status).toBe(200);
    expect(highRes.body.yearsExperience).toBe(80);

    const lowRes = await request(app)
      .patch("/api/users/me")
      .set("Cookie", cookie)
      .send({ yearsExperience: -5 });

    expect(lowRes.status).toBe(200);
    expect(lowRes.body.yearsExperience).toBe(0);
  });
});
