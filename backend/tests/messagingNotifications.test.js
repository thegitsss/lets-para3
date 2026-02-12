const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Message = require("../models/Message");
const Notification = require("../models/Notification");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const sendEmail = require("../utils/email");

const messagesRouter = require("../routes/messages");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
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

async function seedFundedCase({ attorney, paralegal }) {
  return Case.create({
    title: "Messaging case",
    practiceArea: "immigration",
    details: "Case details for messaging tests.",
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal._id,
    paralegalId: paralegal._id,
    status: "in progress",
    escrowStatus: "funded",
    escrowIntentId: "pi_test_123",
    totalAmount: 40000,
    currency: "usd",
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
  sendEmail.mockClear();
});

describe("Messaging + notifications", () => {
  test("Paralegal sends message to attorney and notification email is sent", async () => {
    // Description: Paralegal sends a message on a funded case.
    // Input values: text="Draft is ready for review".
    // Expected result: message stored, notification created, email sent to attorney.

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

    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const res = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Draft is ready for review" });

    expect(res.status).toBe(201);
    expect(res.body.message?.text).toBe("Draft is ready for review");
    expect(res.body.message?.senderRole).toBe("paralegal");

    const stored = await Message.find({ caseId: caseDoc._id }).lean();
    expect(stored).toHaveLength(1);

    const notif = await Notification.findOne({ userId: attorney._id, type: "message" }).lean();
    expect(notif).toBeTruthy();

    expect(sendEmail).toHaveBeenCalled();
    const [to, subject] = sendEmail.mock.calls[0];
    expect(to).toBe(attorney.email);
    expect(String(subject)).toMatch(/new message/i);
  });

  test("Attorney sees message, marks read, and read state persists", async () => {
    // Description: Attorney fetches messages, marks as read, then re-fetches.
    // Input values: message text="Status update".
    // Expected result: message returned, readBy contains attorney id after marking read.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "samanthasider+attorney2@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "samanthasider+paralegal2@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });

    await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Status update" });

    const listRes = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney));

    expect(listRes.status).toBe(200);
    expect(listRes.body.messages).toHaveLength(1);
    expect(listRes.body.messages[0].text).toBe("Status update");

    const readRes = await request(app)
      .post(`/api/messages/${caseDoc._id}/read`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(readRes.status).toBe(200);

    const updated = await Message.findOne({ caseId: caseDoc._id }).lean();
    expect(updated.readBy.map(String)).toContain(String(attorney._id));
    expect(updated.readReceipts.map((r) => String(r.user))).toContain(String(attorney._id));

    // Simulate new login (fresh JWT)
    const listRes2 = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney));

    expect(listRes2.status).toBe(200);
    expect(listRes2.body.messages[0].readBy.map(String)).toContain(String(attorney._id));
  });

  test("Messaging is blocked when escrow is not funded", async () => {
    // Description: Paralegal attempts to send message on unfunded case.
    // Input values: escrowStatus="pending", escrowIntentId missing.
    // Expected result: 403 error.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "samanthasider+attorney3@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "samanthasider+paralegal3@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Unfunded case",
      practiceArea: "immigration",
      details: "Case details for unfunded messaging test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "open",
      escrowStatus: "pending",
      totalAmount: 40000,
      currency: "usd",
    });

    const res = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Hello" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/payment|funded|work begins/i);
  });

  test("Notification email respects user preferences", async () => {
    // Description: Attorney with emailMessages disabled should not receive email.
    // Input values: notificationPrefs.emailMessages=false.
    // Expected result: in-app notification created, no email sent.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "samanthasider+attorney4@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      notificationPrefs: { emailMessages: false, inAppMessages: true },
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "samanthasider+paralegal4@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const res = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Message without email" });

    expect(res.status).toBe(201);

    const notif = await Notification.findOne({ userId: attorney._id, type: "message" }).lean();
    expect(notif).toBeTruthy();

    expect(sendEmail).not.toHaveBeenCalled();
  });
});
