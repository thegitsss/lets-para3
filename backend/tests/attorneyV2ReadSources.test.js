const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { seedAttorneySupportFixtures } = require("./helpers/attorneySupportFixtures");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
const Case = require("../models/Case");
const CaseDraft = require("../models/CaseDraft");
const User = require("../models/User");
const Message = require("../models/Message");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/stripe", () => ({
  customers: { retrieve: jest.fn() }, paymentMethods: { retrieve: jest.fn() },
  sanitizeStripeError: jest.fn((_error, fallback) => fallback),
}));

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/cases", require("../routes/cases"));
app.use("/api/case-drafts", require("../routes/caseDrafts"));
app.use("/api/attorney/dashboard", require("../routes/attorneyDashboard"));
app.use("/api/payments", require("../routes/payments"));
app.use("/api/messages", require("../routes/messages"));
app.use("/api/applications", require("../routes/applications"));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);
const get = (path, user) => request(app).get(path).set("Cookie", authCookieFor(user));

test("owner list, applicant, file, money and unread reads agree across lifecycle fixtures without changing records", async () => {
  const f = await seedAttorneySupportFixtures();
  const before = await Case.find({ attorney: f.ids.owner }).sort({ _id: 1 }).lean();
  const paths = [
    "/api/cases/my?withFiles=true&limit=100&archived=false", "/api/cases/my?withFiles=true&limit=100&archived=true",
    "/api/attorney/dashboard", "/api/payments/summary", "/api/messages/unread-count", "/api/messages/summary", "/api/messages/threads?limit=100", "/api/applications/my-postings",
  ];
  const responses = await Promise.all(paths.map((path) => get(path, f.users.owner)));
  responses.forEach((res, index) => expect({ path: paths[index], status: res.status }).toEqual({ path: paths[index], status: 200 }));
  const [current, history, dashboard, payments, unread, summary, threads, applications] = responses.map((res) => res.body);
  expect(new Set([...current, ...history].map((item) => item.id))).toEqual(new Set(Object.values(f.caseIds).filter((caseId) => ![f.caseIds.one, f.caseIds.inaccessible].includes(caseId)).map(String)));
  expect(current.some((item) => item.id === String(f.caseIds.paused))).toBe(true);
  expect(history.some((item) => item.id === String(f.caseIds.completed))).toBe(true);
  expect(current.find((item) => item.id === String(f.caseIds.active))).toMatchObject({ filesCount: 1, deadlineDate: f.upcomingDeadline, remainingAmount: 250000 });
  expect(current.find((item) => item.id === String(f.caseIds.open)).applicantsCount).toBe(applications.filter((item) => item.caseId === String(f.caseIds.open)).length);
  expect(dashboard.metrics.escrowTotal).toBe(payments.activeFunds);
  // This historical fixture has Case funding flags and earlier decisions, but
  // no verified original capture ledger. Both consumers must show uncertainty.
  expect(payments.activeFunds).toBeNull();
  expect(payments.requiresReview).toBeGreaterThan(0);
  expect(unread.count).toBe(summary.items.reduce((sum, item) => sum + item.unread, 0));
  const perCase = new Map(summary.items.map((item) => [item.caseId, item.unread]));
  threads.threads.forEach((item) => expect(item.unread).toBe(perCase.get(item.id)));
  expect(unread.count).toBeGreaterThan(0);
  expect(JSON.stringify(responses.map((res) => res.body))).not.toContain(String(f.caseIds.inaccessible));
  expect(await Case.find({ attorney: f.ids.owner }).sort({ _id: 1 }).lean()).toEqual(before);
  const message = await Message.findOne({ caseId: f.caseIds.active, senderId: f.ids.assignedParalegal }).lean();
  expect(message.readBy).toEqual([]);
});

test("empty and one-matter attorneys remain isolated and disabled sessions lose list access", async () => {
  const f = await seedAttorneySupportFixtures();
  expect((await get("/api/cases/my?limit=100", f.users.emptyAttorney)).body).toEqual([]);
  const single = await get("/api/cases/my?limit=100", f.users.oneAttorney);
  expect(single.body.map((item) => item.id)).toEqual([String(f.caseIds.one)]);
  const wrongRole = await get("/api/attorney/dashboard", f.users.assignedParalegal);
  expect(wrongRole.status).toBe(403);
  await User.updateOne({ _id: f.ids.owner }, { $set: { disabled: true } });
  const disabled = await get("/api/cases/my?limit=100", f.users.owner);
  expect([401, 403]).toContain(disabled.status);
  expect(JSON.stringify(disabled.body)).not.toContain(f.cases.active.title);
});

test("current list endpoints cap records and do not implement a second server page", async () => {
  const f = await seedAttorneySupportFixtures();
  await Case.collection.insertMany(Array.from({ length: 101 }, (_, index) => ({ attorney: f.ids.emptyAttorney, attorneyId: f.ids.emptyAttorney, title: `Cap ${index}`, status: "open", archived: false, updatedAt: new Date(2026, 8, 1, 0, index) })));
  await CaseDraft.collection.insertMany(Array.from({ length: 201 }, (_, index) => ({ owner: f.ids.emptyAttorney, title: `Draft cap ${index}`, updatedAt: new Date(2026, 8, 1, 0, index) })));
  const [first, second, drafts] = await Promise.all([
    get("/api/cases/my?limit=100", f.users.emptyAttorney), get("/api/cases/my?limit=100&page=2", f.users.emptyAttorney), get("/api/case-drafts?limit=200", f.users.emptyAttorney),
  ]);
  expect(first.status).toBe(200); expect(second.status).toBe(200); expect(drafts.status).toBe(200);
  expect(first.body).toHaveLength(100);
  expect(second.body.map((item) => item.id)).toEqual(first.body.map((item) => item.id));
  expect(drafts.body.items).toHaveLength(200);
  expect(first.headers["x-total-count"]).toBeUndefined();
  expect(drafts.body.total).toBeUndefined();
});
