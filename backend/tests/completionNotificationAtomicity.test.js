const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async to => ({ accepted: [to] })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const mockStripe = { paymentIntents: { retrieve: jest.fn() }, transfers: { create: jest.fn() }, accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(), sanitizeStripeError: jest.fn((_error, fallback) => fallback), stripeIdempotencyKey: jest.fn((kind, ...values) => `${kind}:${values.join(":")}`), caseTransferGroup: jest.fn(value => `case_${value}`) };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../services/caseLifecycle", () => ({ generateArchiveZip: jest.fn(async () => ({ key: "cases/synthetic/archive.zip", readyAt: new Date() })), buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%synthetic")), uploadPdfToS3: jest.fn(async () => ({ key: "synthetic/receipt.pdf" })), getReceiptKey: jest.fn(() => "synthetic/receipt.pdf") }));
const User = require("../models/User"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Payout = require("../models/Payout"), PaymentOperation = require("../models/PaymentOperation"), PlatformIncome = require("../models/PlatformIncome"), AuditLog = require("../models/AuditLog");
const service = require("../services/attorneyCompletion"), lifecycle = require("../services/caseLifecycle");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/disputes", require("../routes/disputes"));
let owner, other, para, matter;
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
beforeAll(async () => { await connect(); await Promise.all([User.init(), Case.init(), CaseFile.init(), Payout.init(), PlatformIncome.init(), PaymentOperation.init(), AuditLog.init()]); }, 60000);
afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); lifecycle.generateArchiveZip.mockResolvedValue({ key: "cases/synthetic/archive.zip", readyAt: new Date() });
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@completion.test`, password: "Synthetic123!", status: "approved", role: name === "para" ? "paralegal" : "attorney", ...(name === "para" ? { stripeAccountId: "acct_synthetic_completion", stripeOnboarded: true, stripePayoutsEnabled: true } : {}) })));
  matter = await Case.create({ title: "River Street lease review", details: "Review completion payment evidence.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_completion", totalAmount: 100000, lockedTotalAmount: 100000, currency: "usd", tasks: [{ title: "Review lease exhibits", completed: true }] });
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ livemode: false, id: "pi_synthetic_completion", status: "succeeded", amount: 122000, currency: "usd", transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id) }, latest_charge: { id: "ch_synthetic", transfer_group: `case_${matter._id}` } }); mockStripe.isTransferablePaymentIntent.mockReturnValue({ transferable: true, charge: { id: "ch_synthetic" } }); mockStripe.transfers.create.mockResolvedValue({ id: "tr_synthetic_completion" });
});
const read = (query = {}, user = owner) => request(app).get(`/api/cases/${matter._id}/completion-review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const send = (body, user = owner) => request(app).post(`/api/cases/${matter._id}/complete`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
async function command() { const review = await read(); expect(review.status).toBe(200); return { requestId: crypto.randomUUID(), confirmation: service.confirmation(review.body) }; }
const raw = () => Case.collection.findOne({ _id: matter._id });
const paid = () => Payout.create({ stripeMode: "test", caseId: matter._id, paralegalId: para._id, amountPaid: 82000, transferId: "tr_synthetic_completion", status: "paid" });


const Notification = require("../models/Notification"), sendEmail = require("../utils/email");
test("a failed final completion record cannot send an attorney Matter-completed email", async () => {
  const body = await command(); jest.spyOn(service, "finish").mockRejectedValueOnce(new Error("Synthetic completion record unavailable"));
  expect((await send(body)).status).toBe(503); expect((await raw()).status).toBe("in progress");
  expect(await Payout.countDocuments()).toBe(1); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls.filter(call => call[0] === owner.email && /completed/i.test(call[1]))).toHaveLength(0);
});
test("completion respects email preferences for both recipients", async () => {
  await User.updateMany({}, { $set: { "notificationPrefs.email": false } });
  expect((await send(await command())).status).toBe(200); expect((await raw()).status).toBe("completed");
  expect(sendEmail).not.toHaveBeenCalled(); expect(await require("../models/MatterPaymentNotification").countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(2); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
});
test("finishing an already-paid Matter cannot commit without its completion notification", async () => {
  await paid(); const before = await Payout.find().lean();
  jest.spyOn(Notification, "create").mockRejectedValueOnce(new Error("Synthetic completion notice unavailable"));
  expect((await send(await command())).status).toBeGreaterThanOrEqual(500);
  expect((await raw()).status).toBe("in progress"); expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(0);
  expect(await Payout.find().lean()).toEqual(before); expect(mockStripe.transfers.create).not.toHaveBeenCalled();
});

const Notice = require("../models/MatterPaymentNotification"), delivery = require("../services/matterPaymentNotifications");
test("completion retains two recipient obligations once, survives dispatch loss, and respects role destinations", async () => {
  const body = await command(); expect((await send(body)).status).toBe(200);
  expect(sendEmail).not.toHaveBeenCalled(); expect(await Notice.countDocuments({ kind: "completion" })).toBe(2);
  expect(await Notification.countDocuments({ "payload.outcome": "matter_completion_recorded" })).toBe(2);
  const records = await Notice.find().lean(); expect(JSON.stringify(records)).not.toMatch(/River Street|completion.test|82000/);
  expect((await send(body)).status).toBe(200); expect(await Notice.countDocuments()).toBe(2); expect(await Notification.countDocuments()).toBe(2); expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
  expect((await Promise.all([delivery.processNotices(), delivery.processNotices()])).reduce((a,b)=>a+b,0)).toBe(2);
  expect(await Notice.countDocuments({ status: "accepted" })).toBe(2); expect(sendEmail).toHaveBeenCalledTimes(2);
  const attorneyEmail=sendEmail.mock.calls.find(call=>call[0]===owner.email), paraEmail=sendEmail.mock.calls.find(call=>call[0]===para.email);
  expect(attorneyEmail[2]).toContain(`/case-detail.html?caseId=${matter._id}&amp;tab=financials`);
  expect(paraEmail[2]).toContain(`/dashboard-paralegal.html?highlightCase=${matter._id}#cases-completed`);
  expect(paraEmail[2]).toContain("bank arrival depends on"); expect(paraEmail[2]).not.toContain("Your bank account has");
  await delivery.processNotices(); expect(sendEmail).toHaveBeenCalledTimes(2);
});
test.each(["recipient", "outbox", "indexes"])("a %s persistence failure rolls back completion and both recipients without another transfer", async failure => {
  await paid(); const body=await command();
  if(failure==="recipient") { const create=Notification.create.bind(Notification);jest.spyOn(Notification,"create").mockImplementationOnce((...args)=>create(...args)).mockRejectedValueOnce(new Error("Synthetic second recipient unavailable")); }
  if(failure==="outbox") jest.spyOn(Notice,"create").mockRejectedValueOnce(new Error("Synthetic outbox unavailable"));
  if(failure==="indexes") jest.spyOn(Notice.collection,"indexes").mockResolvedValueOnce([]);
  expect((await send(body)).status).toBe(503); expect((await raw()).status).toBe("in progress");
  expect(await Notice.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
  expect(await AuditLog.countDocuments({ action: "case.completion.recorded" })).toBe(0);
  expect(await Payout.countDocuments()).toBe(1); expect(mockStripe.transfers.create).not.toHaveBeenCalled();expect(sendEmail).not.toHaveBeenCalled();
});
test.each(["inApp","inAppCase"])("disabled %s notices still retain both email obligations", async preference => {
  await User.updateMany({},{$set:{["notificationPrefs."+preference]:false}});
  expect((await send(await command())).status).toBe(200);expect(await Notification.countDocuments()).toBe(0);expect(await Notice.countDocuments()).toBe(2);
});
test("unknown completion email acceptance is reviewable and never automatically duplicated", async () => {
  expect((await send(await command())).status).toBe(200);
  sendEmail.mockRejectedValueOnce(Object.assign(new Error("Synthetic connection closed"),{code:"ECONNECTION",command:"CONN"}));
  await delivery.processNotices(); expect(await Notice.countDocuments({status:"unknown"})).toBe(1);expect(await Notice.countDocuments({status:"accepted"})).toBe(1);
  await delivery.processNotices();expect(sendEmail).toHaveBeenCalledTimes(2);expect((await delivery.noticeStatus()).counts.unknown).toBe(1);
});
