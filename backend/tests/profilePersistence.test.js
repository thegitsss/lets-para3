const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Message = require("../models/Message");
const WeeklyNote = require("../models/WeeklyNote");

const usersRouter = require("../routes/users");
const messagesRouter = require("../routes/messages");

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/users", usersRouter);
  instance.use("/api/messages", messagesRouter);
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

describe("Profile persistence + cross-device state", () => {
  test("Attorney profile persists after logout/login", async () => {
    // Description: Save attorney profile fields and confirm they persist when a new session loads the profile.
    // Input values: firstName=Ava, lastName=Stone, lawFirm=Stone & Co, practiceAreas=["Litigation"], bio="Trial counsel".
    // Expected result: PATCH saves the fields and a new session retrieves identical values.

    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Original",
      email: "ava.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const cookie = authCookieFor(attorney);
    const updatePayload = {
      firstName: "Ava",
      lastName: "Stone",
      lawFirm: "Stone & Co",
      practiceAreas: ["Litigation"],
      bio: "Trial counsel",
    };

    const patchRes = await request(app)
      .patch("/api/users/me")
      .set("Cookie", cookie)
      .send(updatePayload);

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.firstName).toBe("Ava");
    expect(patchRes.body.lastName).toBe("Stone");
    expect(patchRes.body.lawFirm).toBe("Stone & Co");
    expect(patchRes.body.practiceAreas).toContain("Litigation");

    const secondSession = await request(app)
      .get("/api/users/me")
      .set("Cookie", cookie);

    expect(secondSession.status).toBe(200);
    expect(secondSession.body.lastName).toBe("Stone");
    expect(secondSession.body.lawFirm).toBe("Stone & Co");
    expect(secondSession.body.practiceAreas).toContain("Litigation");

    const fromDb = await User.findById(attorney._id).lean();
    expect(fromDb.lastName).toBe("Stone");
    expect(fromDb.lawFirm).toBe("Stone & Co");
  });

  test("Paralegal profile persists after logout/login", async () => {
    // Description: Save paralegal profile fields and confirm they persist in a new session.
    // Input values: bio, skills, practiceAreas, resumeURL.
    // Expected result: PATCH saves the fields and a new session retrieves identical values.

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "WA",
      profileImage: "paralegal-photos/p1.jpg",
      profilePhotoStatus: "approved",
    });

    const cookie = authCookieFor(paralegal);
    const updatePayload = {
      bio: "Immigration paralegal with 8 years of experience.",
      skills: ["Research", "Drafting"],
      practiceAreas: ["Immigration"],
      resumeURL: "paralegal-resumes/p1/resume.pdf",
    };

    const patchRes = await request(app)
      .patch("/api/users/me")
      .set("Cookie", cookie)
      .send(updatePayload);

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.bio).toMatch(/Immigration paralegal/);
    expect(patchRes.body.skills).toContain("Research");
    expect(patchRes.body.practiceAreas).toContain("Immigration");
    expect(patchRes.body.resumeURL).toBe("paralegal-resumes/p1/resume.pdf");

    const secondSession = await request(app)
      .get("/api/users/me")
      .set("Cookie", cookie);

    expect(secondSession.status).toBe(200);
    expect(secondSession.body.bio).toMatch(/Immigration paralegal/);
    expect(secondSession.body.skills).toContain("Research");
    expect(secondSession.body.practiceAreas).toContain("Immigration");
  });

  test("Weekly notes are stored server-side (not localStorage)", async () => {
    // Description: Save weekly notes and verify a fresh session can load them (server-side persistence).
    // Input values: weekStart=2026-02-09, notes[0]="Draft motion outline".
    // Expected result: WeeklyNote document exists in DB and a new session receives the same notes.

    const attorney = await User.create({
      firstName: "Renee",
      lastName: "Miles",
      email: "renee.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "NY",
    });

    const cookie = authCookieFor(attorney);
    const weekStart = "2026-02-09";
    const notes = ["Draft motion outline", "", "", "", "", "", ""]; // Monday note

    const putRes = await request(app)
      .put(`/api/users/me/weekly-notes`)
      .set("Cookie", cookie)
      .send({ weekStart, notes });

    expect(putRes.status).toBe(200);
    expect(putRes.body.notes[0]).toBe("Draft motion outline");

    const doc = await WeeklyNote.findOne({ userId: attorney._id });
    expect(doc).toBeTruthy();
    expect(doc.notes[0]).toBe("Draft motion outline");

    const secondSession = await request(app)
      .get(`/api/users/me/weekly-notes?weekStart=${weekStart}`)
      .set("Cookie", cookie);

    expect(secondSession.status).toBe(200);
    expect(secondSession.body.notes[0]).toBe("Draft motion outline");
  });

  test("Message read status persists across devices", async () => {
    // Description: Mark messages as read in one session and verify a fresh session sees them as read.
    // Input values: case with funded status, message in case, POST /api/messages/:caseId/read.
    // Expected result: message.readBy includes the reader and persists when fetched from another session.

    const attorney = await User.create({
      firstName: "Morgan",
      lastName: "Hall",
      email: "morgan.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "TX",
    });

    const paralegal = await User.create({
      firstName: "Jamie",
      lastName: "Lopez",
      email: "jamie.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "TX",
    });

    const caseDoc = await Case.create({
      title: "Test matter",
      details: "Case details",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "active",
      escrowStatus: "funded",
      escrowIntentId: "pi_test_123",
    });

    const msg = await Message.create({
      caseId: caseDoc._id,
      senderId: paralegal._id,
      senderRole: "paralegal",
      type: "text",
      text: "Update on filings",
      content: "Update on filings",
      createdAt: new Date(Date.now() - 1000),
    });

    const cookie = authCookieFor(attorney);

    const readRes = await request(app)
      .post(`/api/messages/${caseDoc._id}/read`)
      .set("Cookie", cookie)
      .send({});

    expect(readRes.status).toBe(200);

    const secondSession = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", cookie);

    expect(secondSession.status).toBe(200);
    const updated = secondSession.body.messages.find((m) => String(m._id) === String(msg._id));
    expect(updated.readBy.map(String)).toContain(String(attorney._id));
  });
});
