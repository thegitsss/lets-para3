const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");
const User = require("../models/User");
const Case = require("../models/Case");
const Message = require("../models/Message");
const Block = require("../models/Block");
const messagesRouter = require("../routes/messages");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/messages", messagesRouter);
app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
const date = value => new Date(`2026-${value}T12:00:00Z`);
let attorney, paralegal;

function cookie(user) {
  return `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
}
const readThreads = (user, query = {}) => request(app).get("/api/messages/threads").query(query).set("Cookie", cookie(user));
const makeUser = (role, name) => User.create({ firstName: name, lastName: "Ordering", email: `${name}@example.com`, password: "Password123!", role, status: "approved", state: "CA" });
function matter(values = {}) {
  return {
    title: "Conversation", practiceArea: "immigration", details: "Local conversation ordering regression",
    attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id,
    status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_local_ordering",
    totalAmount: 40000, currency: "usd", createdAt: date("01-01"), ...values,
  };
}
function message(caseDoc, values = {}) {
  return {
    caseId: caseDoc._id, senderId: paralegal._id, senderRole: "paralegal", type: "text",
    text: "A visible message", createdAt: date("02-01"), ...values,
  };
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [attorney, paralegal] = await Promise.all([makeUser("attorney", "attorney-order"), makeUser("paralegal", "paralegal-order")]);
});
afterEach(() => jest.restoreAllMocks());

test("the newest message on the oldest of 101 Matters leads both roles' first page", async () => {
  const cases = await Case.insertMany(Array.from({ length: 101 }, (_, index) => matter({
    title: `Matter ${index}`, createdAt: new Date(date("01-01").getTime() + index * 86400000),
  })));
  await Message.insertMany(cases.map((caseDoc, index) => message(caseDoc, {
    text: `Message ${index}`, createdAt: new Date(date("05-01").getTime() + index * 60000),
  })));
  await Message.create(message(cases[0], { text: "Urgent response on the oldest Matter", createdAt: date("09-01") }));
  for (const user of [attorney, paralegal]) {
    const first = await readThreads(user, { limit: 100 });
    const second = await readThreads(user, { limit: 100, page: 2 });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toMatchObject({ total: 101, pages: 2, page: 1, limit: 100 });
    expect(first.body.threads).toHaveLength(100);
    expect(first.body.threads[0]).toMatchObject({ id: String(cases[0]._id), lastMessageSnippet: "Urgent response on the oldest Matter", updatedAt: date("09-01").toISOString(), unread: user.role === "attorney" ? 2 : 0 });
    expect(second.body.threads.map(item => item.id)).toEqual([String(cases[1]._id)]);
    expect(new Set([...first.body.threads, ...second.body.threads].map(item => item.id)).size).toBe(101);
  }
});

test("newer empty Matters cannot push the newest real conversation beyond the first page", async () => {
  const old = await Case.create(matter({ title: "Only real conversation" }));
  await Message.create(message(old, { text: "Latest real message", createdAt: date("02-01") }));
  await Case.insertMany(Array.from({ length: 32 }, (_, index) => matter({ title: `New empty Matter ${index}`, createdAt: date("09-01") })));
  for (const user of [attorney, paralegal]) {
    const result = await readThreads(user, { limit: 20 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ total: 33, pages: 2 });
    expect(result.body.threads[0]).toMatchObject({ id: String(old._id), lastMessageSnippet: "Latest real message" });
    expect(result.body.threads.slice(1).every(item => item.lastMessageSnippet === "")).toBe(true);
  }
});

test("ties have stable Matter/message ordering and deleted messages cannot move a thread", async () => {
  const ids = ["600000000000000000000001", "600000000000000000000002", "600000000000000000000003"].map(id => new mongoose.Types.ObjectId(id));
  const cases = await Case.insertMany(ids.map((_id, index) => matter({ _id, title: `Notice [${index}]` })));
  await Message.create(message(cases[0], { _id: new mongoose.Types.ObjectId("610000000000000000000001"), text: "Earlier tie", createdAt: date("05-01") }));
  await Message.create(message(cases[0], { _id: new mongoose.Types.ObjectId("610000000000000000000002"), type: "file", fileName: "Research.pdf", text: undefined, createdAt: date("05-01") }));
  await Message.create(message(cases[1], { createdAt: date("05-01") }));
  await Message.create(message(cases[2], { text: "Deleted future activity", createdAt: date("09-01"), deleted: true }));
  const all = await readThreads(attorney, { limit: 3 });
  expect(all.status).toBe(200);
  expect(all.body.threads.map(item => item.id)).toEqual([String(ids[1]), String(ids[0]), String(ids[2])]);
  expect(all.body.threads[1].lastMessageSnippet).toBe("[file] Research.pdf");
  expect(all.body.threads[2]).toMatchObject({ lastMessageSnippet: "", updatedAt: date("01-01").toISOString(), unread: 0 });
  const pages = [];
  for (let page = 1; page <= 3; page++) pages.push((await readThreads(attorney, { page, limit: 1 })).body.threads[0].id);
  expect(pages).toEqual(all.body.threads.map(item => item.id));
  const search = await readThreads(attorney, { q: "[0]", limit: 1 });
  expect(search.body).toMatchObject({ total: 1, pages: 1 });
  expect(search.body.threads.map(item => item.id)).toEqual([String(ids[0])]);
  const pastEnd = await readThreads(attorney, { page: 4, limit: 1 });
  expect(pastEnd.body).toMatchObject({ total: 3, pages: 3, threads: [] });
});

test("prior-assignment messages cannot influence a replacement paralegal's order or unread total", async () => {
  const former = await makeUser("paralegal", "former-order");
  const old = await Case.create(matter({ title: "Reassigned", withdrawnParalegalId: former._id, hiredAt: date("06-01") }));
  const other = await Case.create(matter({ title: "Other", createdAt: date("01-02") }));
  await Message.create(message(old, { senderId: attorney._id, senderRole: "attorney", text: "Prior assignment private message", createdAt: date("05-01") }));
  await Message.create(message(other, { senderId: attorney._id, senderRole: "attorney", text: "Other current message", createdAt: date("04-01") }));
  const attorneyView = await readThreads(attorney);
  expect(attorneyView.body.threads[0].id).toBe(String(old._id));
  const replacementView = await readThreads(paralegal);
  expect(replacementView.status).toBe(200);
  expect(replacementView.body.threads.map(item => item.id)).toEqual([String(other._id), String(old._id)]);
  expect(replacementView.body.threads[1]).toMatchObject({ lastMessageSnippet: "", updatedAt: date("01-01").toISOString(), unread: 0 });
  expect(JSON.stringify(replacementView.body)).not.toContain("Prior assignment private");
  expect((await readThreads(former)).body.threads).toEqual([]);

  // Both retained legacy timestamp forms remain visible, as in workspace reads.
  await Message.collection.insertMany([
    message(old, { _id: new mongoose.Types.ObjectId("620000000000000000000001"), senderId: attorney._id, createdAt: null, text: "Legacy null timestamp" }),
    { caseId: old._id, _id: new mongoose.Types.ObjectId("620000000000000000000002"), senderId: attorney._id, type: "text", text: "Legacy missing timestamp" },
  ]);
  const legacy = (await readThreads(paralegal)).body.threads.find(item => item.id === String(old._id));
  expect(legacy).toMatchObject({ lastMessageSnippet: "Legacy missing timestamp", updatedAt: date("01-01").toISOString(), unread: 2 });
  await Message.create(message(old, { senderId: attorney._id, senderRole: "attorney", text: "Current assignment instructions", createdAt: date("06-01") }));
  const current = (await readThreads(paralegal)).body.threads[0];
  expect(current).toMatchObject({ id: String(old._id), lastMessageSnippet: "Current assignment instructions", unread: 3 });
});

test("blocked, unfunded and unrelated Matters stay outside both totals and previews", async () => {
  const blocked = await makeUser("paralegal", "blocked-order");
  const stranger = await makeUser("attorney", "stranger-order");
  const own = await Case.create(matter({ title: "Allowed" }));
  const hidden = await Case.insertMany([
    matter({ title: "Blocked", paralegal: blocked._id, paralegalId: blocked._id }),
    matter({ title: "Unfunded", escrowStatus: "pending", escrowIntentId: null }),
    matter({ title: "Unrelated", attorney: stranger._id, attorneyId: stranger._id, paralegal: blocked._id, paralegalId: blocked._id }),
  ]);
  await Block.create({ blockerId: blocked._id, blockedId: attorney._id });
  await Message.insertMany(hidden.map(caseDoc => message(caseDoc, { text: "Inaccessible latest message", createdAt: date("09-01") })));
  await Message.create(message(own));
  const result = await readThreads(attorney);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ total: 1, pages: 1 });
  expect(result.body.threads.map(item => item.id)).toEqual([String(own._id)]);
  const paraResult = await readThreads(paralegal);
  expect(paraResult.body).toMatchObject({ total: 1, pages: 1 });
  expect(paraResult.body.threads.map(item => item.id)).toEqual([String(own._id)]);
});

test("read receipts and last-viewed boundaries still control unread counts after ordering", async () => {
  const caseDoc = await Case.create(matter());
  await Message.insertMany([
    message(caseDoc, { createdAt: date("02-01") }),
    message(caseDoc, { createdAt: date("02-02"), readBy: [attorney._id] }),
    message(caseDoc, { createdAt: date("02-03"), readReceipts: [{ user: attorney._id, at: date("02-04") }] }),
    message(caseDoc, { createdAt: date("02-04"), senderId: attorney._id, senderRole: "attorney" }),
    message(caseDoc, { createdAt: date("02-05"), text: "Only unread message" }),
  ]);
  await User.updateOne({ _id: attorney._id }, { $set: { [`messageLastViewedAt.${caseDoc._id}`]: date("02-01") } });
  const result = await readThreads(attorney);
  expect(result.status).toBe(200);
  expect(result.body.threads[0]).toMatchObject({ lastMessageSnippet: "Only unread message", unread: 1 });
});

test("a failed conversation query returns failure rather than an empty successful inbox", async () => {
  jest.spyOn(Case, "aggregate").mockRejectedValueOnce(new Error("Synthetic conversation query failure"));
  const result = await readThreads(attorney);
  expect(result.status).toBe(500);
  expect(result.body).not.toHaveProperty("threads");
  expect(result.body).not.toHaveProperty("total");
});

test("both inboxes identify the other authorized participant", async () => {
  await Case.create(matter());
  const attorneyInbox = await readThreads(attorney);
  const paralegalInbox = await readThreads(paralegal);
  expect(attorneyInbox.status).toBe(200);
  expect(paralegalInbox.status).toBe(200);
  expect(attorneyInbox.body.threads[0].participant).toMatchObject({id:String(paralegal._id),role:'paralegal',name:`${paralegal.firstName} ${paralegal.lastName}`});
  expect(paralegalInbox.body.threads[0].participant).toMatchObject({id:String(attorney._id),role:'attorney',name:`${attorney.firstName} ${attorney.lastName}`});
});
