const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const notificationsRouter = require("../routes/notifications");
const { resetWorkspacePresence } = require("../utils/workspacePresence");
const { addSubscriber: addCaseSubscriber } = require("../utils/caseEvents");
const { addSubscriber: addNotificationSubscriber } = require("../utils/notificationEvents");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const sendEmail = require("../utils/email");

const messagesRouter = require("../routes/messages");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/messages", messagesRouter);
  instance.use("/api/notifications", notificationsRouter);
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
  await resetWorkspacePresence();
});

describe("Messaging + notifications", () => {
  test("attorney threads identify the assigned paralegal independently of the latest sender", async () => {
    const create = (name, role) => User.create({firstName:name,lastName:"Inbox",email:`${name.toLowerCase()}-inbox@example.com`,password:"Password123!",role,status:"approved",state:"CA"});
    const attorney = await create("Alex", "attorney"), assigned = await create("Priya", "paralegal"), previous = await create("Former", "paralegal"), unrelated = await create("Other", "attorney");
    const matter = await seedFundedCase({attorney,paralegal:assigned});
    // The canonical assigned relationship wins over an older mirrored ID.
    await Case.collection.updateOne({_id:matter._id},{$set:{paralegalId:previous._id}});
    await seedFundedCase({attorney:unrelated,paralegal:previous});
    await Message.create({caseId:matter._id,senderId:attorney._id,senderRole:"attorney",type:"text",text:"My latest reply",readBy:[attorney._id]});
    const response = await request(app).get("/api/messages/threads?limit=100").set("Cookie",authCookieFor(attorney));
    expect(response.status).toBe(200);
    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]).toMatchObject({id:String(matter._id),lastSenderName:"You",participant:{id:String(assigned._id),name:"Priya Inbox",role:"paralegal"}});
    await Case.collection.updateOne({_id:matter._id},{$unset:{paralegal:""},$set:{paralegalId:assigned._id}});
    const earlierFormat = await request(app).get("/api/messages/threads").set("Cookie",authCookieFor(attorney));
    expect(earlierFormat.status).toBe(200);
    expect(earlierFormat.body.threads[0].participant.name).toBe("Priya Inbox");
  });

  test("Retired case-summary probes do not return placeholder content", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Summary",
      email: "attorney-summary@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Summary",
      email: "paralegal-summary@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const response = await request(app)
      .post(`/api/messages/${caseDoc._id}/summary`)
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(response.status).toBe(404);
    expect(response.text).not.toMatch(/placeholder/i);
  });

  test("Unread notification count remains exact beyond the 100-item presentation window", async () => {
    const user = await User.create({
      firstName: "Dana",
      lastName: "Notifications",
      email: "notification-count@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    await Notification.insertMany(Array.from({ length: 105 }, (_, index) => ({
      userId: user._id,
      type: "profile_approved",
      message: `Update ${index + 1}`,
      read: false,
      isRead: false,
      createdAt: new Date(Date.now() - index),
    })));

    // Newer inaccessible records span more than one batch. Valid alerts must
    // still fill the list, and hidden records must not contribute to its badge.
    await Notification.insertMany(Array.from({ length: 110 }, (_, index) => ({
      userId: user._id, type: "case_update", read: false, isRead: false,
      payload: { caseId: "64b444444444444444444444" },
      message: "Private deleted matter", createdAt: new Date(Date.now() + index + 1000),
    })));
    const list = await request(app).get("/api/notifications").set("Cookie", authCookieFor(user));
    const count = await request(app).get("/api/notifications/unread-count").set("Cookie", authCookieFor(user));

    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(100);
    expect(count.status).toBe(200);
    expect(count.body.count).toBe(105);
    expect(list.body.every(item => item.type === "profile_approved")).toBe(true);
    expect(await Notification.countDocuments({ userId: user._id })).toBe(215);
  });

  test("Availability lookup failures remain retryable failures, not empty notification feeds", async () => {
    const user = await User.create({ firstName: "Dana", lastName: "Retry", email: "notification-retry@example.com", password: "Password123!", role: "paralegal", status: "approved", state: "CA" });
    await Notification.create({ userId: user._id, type: "message", payload: { caseId: "64b444444444444444444444" }, read: false, isRead: false });
    const lookup = jest.spyOn(Case, "find").mockImplementation(() => { throw new Error("Synthetic lookup failure"); });
    try {
      for (const endpoint of ["/api/notifications", "/api/notifications/unread-count"]) {
        const response = await request(app).get(endpoint).set("Cookie", authCookieFor(user));
        expect(response.status).toBe(500);
        expect(response.body).toHaveProperty("message");
        expect(response.body).not.toHaveProperty("count");
      }
    } finally {
      lookup.mockRestore();
    }
    expect(await Notification.countDocuments({ userId: user._id })).toBe(1);
  });

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

  test("A retried client message creates one message and one recipient notification", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Retry",
      email: "attorney-message-retry@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Retry",
      email: "paralegal-message-retry@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await seedFundedCase({ attorney, paralegal });
    const body = {
      text: "This should only be delivered once",
      clientMessageId: "message-retry-1234567890",
    };

    const first = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send(body);
    const retry = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send(body);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.message._id).toBe(first.body.message._id);
    // The original workspace's accepted send-receipt contract returns the
    // sending caller's own request ID so an interrupted reply can be confirmed.
    expect(first.body.message.clientMessageId).toBe(body.clientMessageId);
    expect(retry.body.message.clientMessageId).toBe(body.clientMessageId);
    await expect(Message.countDocuments({ caseId: caseDoc._id })).resolves.toBe(1);
    await expect(Notification.countDocuments({ userId: attorney._id, type: "message" })).resolves.toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    for (const viewer of [attorney, paralegal]) {
      const feed = await request(app).get(`/api/messages/${caseDoc._id}`).set("Cookie", authCookieFor(viewer));
      expect(feed.status).toBe(200);
      expect(JSON.stringify(feed.body)).not.toContain(body.clientMessageId);
      expect(feed.body.messages[0]).not.toHaveProperty("clientMessageId");
    }
  });

  test("Attorney message reaches the assigned paralegal and clears from unread after acknowledgement", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Crossrole",
      email: "attorney-crossrole@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Crossrole",
      email: "paralegal-crossrole@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const caseEvents = [];
    const recipientEvents = [];
    const unsubscribeCase = addCaseSubscriber(caseDoc._id, { write: (value) => caseEvents.push(String(value)) });
    const unsubscribeRecipient = addNotificationSubscriber(paralegal._id, { write: (value) => recipientEvents.push(String(value)) });

    const sendRes = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ text: "Please review the updated instructions" });
    unsubscribeCase();
    unsubscribeRecipient();
    expect(sendRes.status).toBe(201);
    expect(caseEvents.join("\n")).toContain("event: messages");
    expect(recipientEvents.join("\n")).toContain("message_refresh");

    const unreadBefore = await request(app)
      .get("/api/messages/unread-count")
      .set("Cookie", authCookieFor(paralegal));
    expect(unreadBefore.status).toBe(200);
    expect(unreadBefore.body.count).toBe(1);

    const summaryBefore = await request(app)
      .get("/api/messages/summary")
      .set("Cookie", authCookieFor(paralegal));
    expect(summaryBefore.status).toBe(200);
    expect(summaryBefore.body.items).toEqual([
      expect.objectContaining({ caseId: String(caseDoc._id), unread: 1 }),
    ]);

    const threadsBefore = await request(app)
      .get("/api/messages/threads?limit=50")
      .set("Cookie", authCookieFor(paralegal));
    expect(threadsBefore.status).toBe(200);
    expect(threadsBefore.body.threads).toEqual([
      expect.objectContaining({ id: String(caseDoc._id), unread: 1 }),
    ]);

    const thread = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal));
    expect(thread.status).toBe(200);
    expect(thread.body.messages).toEqual([
      expect.objectContaining({ text: "Please review the updated instructions", senderRole: "attorney" }),
    ]);

    const notification = await Notification.findOne({ userId: paralegal._id, type: "message" }).lean();
    expect(notification).toBeTruthy();
    const recipientEmail = sendEmail.mock.calls.find(([to]) => to === paralegal.email);
    expect(recipientEmail).toBeTruthy();
    expect(String(recipientEmail[1])).toMatch(/new message/i);

    const readRes = await request(app)
      .post(`/api/messages/${caseDoc._id}/read`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ upTo: thread.body.messages[0].createdAt });
    expect(readRes.status).toBe(200);

    const unreadAfter = await request(app)
      .get("/api/messages/unread-count")
      .set("Cookie", authCookieFor(paralegal));
    expect(unreadAfter.status).toBe(200);
    expect(unreadAfter.body.count).toBe(0);

    const [summaryAfter, threadsAfter] = await Promise.all([
      request(app).get("/api/messages/summary").set("Cookie", authCookieFor(paralegal)),
      request(app).get("/api/messages/threads?limit=50").set("Cookie", authCookieFor(paralegal)),
    ]);
    expect(summaryAfter.body.items).toEqual([
      expect.objectContaining({ caseId: String(caseDoc._id), unread: 0 }),
    ]);
    expect(threadsAfter.body.threads).toEqual([
      expect.objectContaining({ id: String(caseDoc._id), unread: 0 }),
    ]);
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

    const refreshedAttorney = await User.findById(attorney._id).select("messageLastViewedAt");
    expect(refreshedAttorney?.messageLastViewedAt?.get(String(caseDoc._id))).toBeTruthy();

    // Simulate new login (fresh JWT)
    const listRes2 = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney));

    expect(listRes2.status).toBe(200);
    expect(listRes2.body.messages[0].readBy.map(String)).toContain(String(attorney._id));
  });

  test("Workspace unread summary excludes the viewer's own messages", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Unread",
      email: "samanthasider+attorney-unread@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Unread",
      email: "samanthasider+paralegal-unread@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });

    await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ text: "My own update" });

    await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Update from the other participant" });

    const summaryRes = await request(app)
      .get("/api/messages/summary")
      .set("Cookie", authCookieFor(attorney));

    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.items).toEqual([
      expect.objectContaining({
        caseId: String(caseDoc._id),
        unread: 1,
      }),
    ]);
  });

  test("Alias-only case participants retain all workspace messaging access", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Alias",
      email: "samanthasider+attorney-alias@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Alias",
      email: "samanthasider+paralegal-alias@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });
    await Case.updateOne(
      { _id: caseDoc._id },
      { $unset: { attorney: 1, paralegal: 1 } }
    );

    const sendRes = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Alias participant update" });
    expect(sendRes.status).toBe(201);

    const summaryRes = await request(app)
      .get("/api/messages/summary")
      .set("Cookie", authCookieFor(attorney));
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.items).toEqual([
      expect.objectContaining({
        caseId: String(caseDoc._id),
        unread: 1,
      }),
    ]);

    const readRes = await request(app)
      .post(`/api/messages/${caseDoc._id}/read`)
      .set("Cookie", authCookieFor(attorney))
      .send({});
    expect(readRes.status).toBe(200);
  });

  test("A replacement paralegal receives only the current assignment's messages and unread state", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Reassignment",
      email: "attorney-reassignment-messages@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const priorParalegal = await User.create({
      firstName: "Prior",
      lastName: "Paralegal",
      email: "prior-reassignment-messages@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const replacement = await User.create({
      firstName: "Replacement",
      lastName: "Paralegal",
      email: "replacement-reassignment-messages@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const hiredAt = new Date("2026-09-02T12:00:00.000Z");
    const caseDoc = await Case.create({
      title: "Reassigned messaging case",
      practiceArea: "immigration",
      details: "Assignment-scoped messaging fixture.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: replacement._id,
      paralegalId: replacement._id,
      withdrawnParalegalId: priorParalegal._id,
      hiredAt,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_reassigned_messages",
      totalAmount: 40000,
      currency: "usd",
    });
    const oldMessage = await Message.create({
      caseId: caseDoc._id,
      senderId: attorney._id,
      senderRole: "attorney",
      type: "text",
      text: "Prior assignment confidential context",
      content: "Prior assignment confidential context",
      createdAt: new Date("2026-09-01T12:00:00.000Z"),
    });
    const currentMessage = await Message.create({
      caseId: caseDoc._id,
      senderId: attorney._id,
      senderRole: "attorney",
      type: "text",
      text: "Current assignment instructions",
      content: "Current assignment instructions",
      createdAt: new Date("2026-09-03T12:00:00.000Z"),
    });

    const unread = await request(app)
      .get("/api/messages/unread-count")
      .set("Cookie", authCookieFor(replacement));
    expect(unread.status).toBe(200);
    expect(unread.body.count).toBe(1);

    const summary = await request(app)
      .get("/api/messages/summary")
      .set("Cookie", authCookieFor(replacement));
    expect(summary.status).toBe(200);
    expect(summary.body.items).toEqual([
      expect.objectContaining({ caseId: String(caseDoc._id), unread: 1 }),
    ]);

    const thread = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(replacement));
    expect(thread.status).toBe(200);
    expect(thread.body.messages.map((message) => message.text)).toEqual([
      "Current assignment instructions",
    ]);

    const read = await request(app)
      .post(`/api/messages/${caseDoc._id}/read`)
      .set("Cookie", authCookieFor(replacement))
      .send({ upTo: new Date("2026-09-04T12:00:00.000Z").toISOString() });
    expect(read.status).toBe(200);
    const [storedOld, storedCurrent] = await Promise.all([
      Message.findById(oldMessage._id).lean(),
      Message.findById(currentMessage._id).lean(),
    ]);
    expect(storedOld.readBy.map(String)).not.toContain(String(replacement._id));
    expect(storedCurrent.readBy.map(String)).toContain(String(replacement._id));

    const attorneyThread = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney));
    expect(attorneyThread.status).toBe(200);
    expect(attorneyThread.body.messages.map((message) => message.text)).toEqual([
      "Prior assignment confidential context",
      "Current assignment instructions",
    ]);
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

  test("Message notification is suppressed while the recipient is active in case detail", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "samanthasider+attorney5@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "samanthasider+paralegal5@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const presenceRes = await request(app)
      .post("/api/notifications/workspace-presence")
      .set("Cookie", authCookieFor(attorney))
      .send({ caseId: String(caseDoc._id) });

    expect(presenceRes.status).toBe(200);

    const res = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "This should stay in the live workspace only." });

    expect(res.status).toBe(201);

    const notif = await Notification.findOne({ userId: attorney._id, type: "message" }).lean();
    expect(notif).toBeFalsy();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("V2 only suppresses a message alert when the recipient is viewing the Messages surface", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Surface",
      email: "attorney-message-surface@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Surface",
      email: "paralegal-message-surface@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await seedFundedCase({ attorney, paralegal });

    const overviewPresence = await request(app)
      .post("/api/notifications/workspace-presence")
      .set("Cookie", authCookieFor(attorney))
      .send({ caseId: String(caseDoc._id), surface: "overview" });
    expect(overviewPresence.body).toEqual(expect.objectContaining({ success: true, surface: "overview" }));

    const visibleAlert = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Visible outside the conversation." });
    expect(visibleAlert.status).toBe(201);
    expect(await Notification.countDocuments({ userId: attorney._id, type: "message" })).toBe(1);

    const messagesPresence = await request(app)
      .post("/api/notifications/workspace-presence")
      .set("Cookie", authCookieFor(attorney))
      .send({ caseId: String(caseDoc._id), surface: "messages" });
    expect(messagesPresence.body).toEqual(expect.objectContaining({ success: true, surface: "messages" }));

    const inConversation = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Rendered live in the open conversation." });
    expect(inConversation.status).toBe(201);
    expect(await Notification.countDocuments({ userId: attorney._id, type: "message" })).toBe(1);
  });

  test("clearing one V2 workspace surface does not clear another open tab's presence", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Tabs",
      email: "attorney-presence-tabs@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Tabs",
      email: "paralegal-presence-tabs@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await seedFundedCase({ attorney, paralegal });
    const cookie = authCookieFor(attorney);

    await request(app).post("/api/notifications/workspace-presence").set("Cookie", cookie)
      .send({ caseId: String(caseDoc._id), surface: "overview" });
    await request(app).post("/api/notifications/workspace-presence").set("Cookie", cookie)
      .send({ caseId: String(caseDoc._id), surface: "messages" });
    await request(app).delete("/api/notifications/workspace-presence").set("Cookie", cookie)
      .send({ caseId: String(caseDoc._id), surface: "overview" });

    const response = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "The second tab remains present." });
    expect(response.status).toBe(201);
    expect(await Notification.countDocuments({ userId: attorney._id, type: "message" })).toBe(0);
  });
});
