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
  test("attorney profiles expose only the purposeful approved-member contract", async () => {
    const attorney = await User.create({
      firstName: "Avery",
      lastName: "Counsel",
      email: "private-attorney-email@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "NY",
      lawFirm: "Counsel Law",
    });
    const paralegal = await User.create({
      firstName: "Parker",
      lastName: "Member",
      email: "approved-member@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "NY",
    });
    const otherAttorney = await User.create({
      firstName: "Other",
      lastName: "Attorney",
      email: "other-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "NY",
    });

    const memberView = await request(app)
      .get(`/api/users/attorneys/${attorney._id}`)
      .set("Cookie", authCookieFor(paralegal));
    expect(memberView.status).toBe(200);
    expect(memberView.body).toEqual(expect.objectContaining({
      id: String(attorney._id),
      firstName: "Avery",
      lawFirm: "Counsel Law",
    }));
    expect(memberView.body).not.toHaveProperty("email");
    expect(JSON.stringify(memberView.body)).not.toContain(attorney.email);

    const unsupportedContext = await request(app)
      .get(`/api/users/attorneys/${attorney._id}?job=legacy-context`)
      .set("Cookie", authCookieFor(paralegal));
    expect(unsupportedContext.status).toBe(400);

    const peerView = await request(app)
      .get(`/api/users/attorneys/${attorney._id}`)
      .set("Cookie", authCookieFor(otherAttorney));
    expect(peerView.status).toBe(403);
  });

  test("pending members and non-attorney targets cannot use the attorney profile endpoint", async () => {
    const pendingAttorney = await User.create({
      firstName: "Pending",
      lastName: "Counsel",
      email: "pending-counsel@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });
    const approvedParalegal = await User.create({
      firstName: "Approved",
      lastName: "Paralegal",
      email: "approved-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const pendingParalegal = await User.create({
      firstName: "Pending",
      lastName: "Paralegal",
      email: "pending-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "pending",
      state: "CA",
    });

    const [pendingTarget, wrongTarget, pendingRequester] = await Promise.all([
      request(app)
        .get(`/api/users/attorneys/${pendingAttorney._id}`)
        .set("Cookie", authCookieFor(approvedParalegal)),
      request(app)
        .get(`/api/users/attorneys/${approvedParalegal._id}`)
        .set("Cookie", authCookieFor(approvedParalegal)),
      request(app)
        .get(`/api/users/attorneys/${pendingAttorney._id}`)
        .set("Cookie", authCookieFor(pendingParalegal)),
    ]);

    expect(pendingTarget.status).toBe(404);
    expect(wrongTarget.status).toBe(404);
    expect(pendingRequester.status).toBe(403);
  });

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
    expect(secondSession.body.onboarding?.attorneyProfileCompleted).toBe(true);

    const fromDb = await User.findById(attorney._id).lean();
    expect(fromDb.lastName).toBe("Stone");
    expect(fromDb.lawFirm).toBe("Stone & Co");
    expect(fromDb.onboarding?.attorneyProfileCompleted).toBe(true);
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
    const storedResumeKey = `paralegal-resumes/${paralegal._id}/resume-1760000000000.pdf`;
    paralegal.resumeURL = storedResumeKey;
    await paralegal.save();

    const cookie = authCookieFor(paralegal);
    const updatePayload = {
      bio: "Immigration paralegal with 8 years of experience.",
      skills: ["Research", "Drafting"],
      practiceAreas: ["Immigration"],
      resumeURL: storedResumeKey,
      linkedInURL: "https://www.linkedin.com/in/priya-ng",
    };

    const patchRes = await request(app)
      .patch("/api/users/me")
      .set("Cookie", cookie)
      .send(updatePayload);

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.bio).toMatch(/Immigration paralegal/);
    expect(patchRes.body.skills).toContain("Research");
    expect(patchRes.body.practiceAreas).toContain("Immigration");
    expect(patchRes.body.resumeURL).toBe(storedResumeKey);
    expect(patchRes.body.linkedInURL).toBe("https://www.linkedin.com/in/priya-ng");

    const secondSession = await request(app)
      .get("/api/users/me")
      .set("Cookie", cookie);

    expect(secondSession.status).toBe(200);
    expect(secondSession.body.bio).toMatch(/Immigration paralegal/);
    expect(secondSession.body.skills).toContain("Research");
    expect(secondSession.body.practiceAreas).toContain("Immigration");
    expect(secondSession.body.linkedInURL).toBe("https://www.linkedin.com/in/priya-ng");
  });

  test("Paralegal profile rejects non-LinkedIn and executable profile URLs", async () => {
    const paralegal = await User.create({
      firstName: "Secure",
      lastName: "Link",
      email: "secure.link@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "WA",
    });
    const cookie = authCookieFor(paralegal);

    for (const linkedInURL of ["javascript:alert(1)", "https://example.com/not-linkedin"]) {
      const response = await request(app)
        .patch("/api/users/me")
        .set("Cookie", cookie)
        .send({ linkedInURL });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/LinkedIn URL/i);
    }

    const stored = await User.findById(paralegal._id).lean();
    expect(stored.linkedInURL || "").toBe("");
  });

  test("User model rejects unsafe URLs even when a write bypasses the profile route", async () => {
    await expect(
      User.create({
        firstName: "Unsafe",
        lastName: "Model",
        email: "unsafe.model@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        state: "WA",
        linkedInURL: "javascript:alert(1)",
      })
    ).rejects.toThrow(/LinkedIn URL/);
  });

  test("Paralegal profile cannot forge or expose an external admission document", async () => {
    const paralegal = await User.create({
      firstName: "Secure",
      lastName: "Profile",
      email: "secure.profile@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "WA",
    });
    const cookie = authCookieFor(paralegal);

    const response = await request(app)
      .patch("/api/users/me")
      .set("Cookie", cookie)
      .send({ resumeURL: "https://evil.example/unscanned-resume.pdf" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/protected document uploader/i);
    const stored = await User.findById(paralegal._id).lean();
    expect(stored.resumeURL || "").toBe("");
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

  test("Matter messaging rejects admins and stale pending invitees", async () => {
    const attorney = await User.create({
      firstName: "Owner",
      lastName: "Attorney",
      email: "message-owner@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const assigned = await User.create({
      firstName: "Assigned",
      lastName: "Paralegal",
      email: "message-assigned@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const staleInvitee = await User.create({
      firstName: "Stale",
      lastName: "Invitee",
      email: "message-stale@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const admin = await User.create({
      firstName: "Platform",
      lastName: "Admin",
      email: "message-admin@example.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Private participant thread",
      details: "Only the owner and active assignment may access messages.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: assigned._id,
      paralegalId: assigned._id,
      pendingParalegalId: staleInvitee._id,
      invites: [{ paralegalId: staleInvitee._id, status: "pending", invitedAt: new Date() }],
      status: "active",
      escrowStatus: "funded",
      escrowIntentId: "pi_private_messages",
    });
    await Message.create({
      caseId: caseDoc._id,
      senderId: attorney._id,
      senderRole: "attorney",
      type: "text",
      text: "Privileged work update",
      content: "Privileged work update",
    });

    const adminResponse = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(admin));
    expect(adminResponse.status).toBe(403);
    expect(JSON.stringify(adminResponse.body)).not.toContain("Privileged work update");

    const inviteeResponse = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(staleInvitee));
    expect(inviteeResponse.status).toBe(403);
    expect(JSON.stringify(inviteeResponse.body)).not.toContain("Privileged work update");
  });

  test("A valid Message id cannot be replayed against a different Matter", async () => {
    const attorney = await User.create({
      firstName: "Message",
      lastName: "Owner",
      email: "cross-message-owner@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Message",
      lastName: "Assignee",
      email: "cross-message-assignee@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const common = {
      details: "Cross-Matter Message binding regression fixture.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "active",
      escrowStatus: "funded",
    };
    const firstMatter = await Case.create({ ...common, title: "First private thread", escrowIntentId: "pi_first_message" });
    const secondMatter = await Case.create({ ...common, title: "Second private thread", escrowIntentId: "pi_second_message" });
    const message = await Message.create({
      caseId: secondMatter._id,
      senderId: attorney._id,
      senderRole: "attorney",
      type: "text",
      text: "Second Matter private message",
      content: "Second Matter private message",
    });

    const response = await request(app)
      .patch(`/api/messages/${firstMatter._id}/${message._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ content: "Cross-Matter overwrite attempt" });

    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain("Second Matter private message");
    const unchanged = await Message.findById(message._id).lean();
    expect(unchanged.text).not.toBe("Cross-Matter overwrite attempt");
  });
});
