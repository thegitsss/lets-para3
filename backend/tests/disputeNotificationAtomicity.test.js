const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), Case = require("../models/Case"), AuditLog = require("../models/AuditLog"), Notification = require("../models/Notification");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/disputes", require("../routes/disputes"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, invited, admin, matter;
beforeAll(connect);afterAll(closeDatabase);afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); [owner, other, para, invited, admin] = await User.create(["owner", "other", "para", "invited", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@disputes.test`, password: "Synthetic123!", role: name === "admin" ? "admin" : ["para", "invited"].includes(name) ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "River Street lease review", details: "Review lease exhibits", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_dispute", totalAmount: 100000, currency: "usd" });
});
const read = (query = {}, user = owner) => request(app).get(`/api/disputes/${matter._id}/attorney-review`).set("Cookie", cookie(user)).query({ expectedOwnerId: String(user._id), ...query });
const send = (body, user = owner) => request(app).post(`/api/disputes/${matter._id}/attorney-action`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), ...body });
const raw = () => Case.collection.findOne({ _id: matter._id });
async function command(action = "open", text = "The exhibit references need administrator review.", disputeId) {
  const result = await read(disputeId ? { disputeId } : {}); expect(result.status).toBe(200); return { action, text, requestId: crypto.randomUUID(), reviewedRevision: result.body.revision, ...(action === "comment" ? { disputeId: result.body.selected.id, reviewedDisputeRevision: result.body.selected.revision } : {}) };
}

test.each(["attorney_reviewed","paralegal_current","admin_current"])("%s opening must not commit a dispute without its participant and administrator notices",async entry=>{
 const before=await raw(),body=entry==="attorney_reviewed"?await command():null;
 jest.spyOn(Notification,"create").mockRejectedValueOnce(new Error("Synthetic dispute recipient unavailable"));
 const result=entry==="attorney_reviewed"?await send(body):await request(app).post(`/api/disputes/${matter._id}`).set("Cookie",cookie(entry==="paralegal_current"?para:admin)).send({message:"The supporting exhibit needs review."});
 expect(result.status).toBeGreaterThanOrEqual(500);const after=await raw();expect(after.status).toBe(before.status);expect(after.disputes).toEqual(before.disputes);expect(await Notification.countDocuments({type:"dispute_opened"})).toBe(0);expect(await AuditLog.countDocuments({action:"dispute.create"})).toBe(0);
});
test("a current-route audit write failure cannot leave an opened dispute without its record",async()=>{
 const before=await raw();jest.spyOn(AuditLog,"logFromReq").mockRejectedValueOnce(new Error("Synthetic audit unavailable"));
 const result=await request(app).post(`/api/disputes/${matter._id}`).set("Cookie",cookie(para)).send({message:"The supporting exhibit needs review."});
 expect(result.status).toBeGreaterThanOrEqual(500);expect(result.body.error).toBe("The dispute change could not be confirmed. Refresh and check its saved status before trying again.");const after=await raw();expect(after.status).toBe(before.status);expect(after.disputes).toEqual(before.disputes);
});

test("an unavailable dispute list reports a failed read without a fabricated empty result", async () => {
 const before = await raw();
 jest.spyOn(Case, "aggregate").mockRejectedValueOnce(Error("Synthetic private database failure"));
 const result = await request(app).get("/api/disputes/admin").set("Cookie", cookie(admin));
 expect(result.status).toBe(500);
 expect(result.body).toEqual({ error: "Dispute details could not be loaded. Refresh to check again." });
 expect(await raw()).toEqual(before);
});

test("an error after saving administrator notes preserves an unknown outcome and can be read back", async () => {
 const disputeId = new mongoose.Types.ObjectId().toString();
 await Case.collection.updateOne({ _id: matter._id }, { $set: { disputes: [{ disputeId, message: "Retained review", raisedBy: para._id, status: "resolved" }], disputeSettlement: { action: "refund", disputeId } } });
 jest.spyOn(AuditLog, "logFromReq").mockRejectedValueOnce(Error("Synthetic audit acknowledgement unavailable"));
 const result = await request(app).patch(`/api/disputes/${matter._id}/${disputeId}/admin-notes`).set("Cookie", cookie(admin)).send({ notes: "Checked retained receipt." });
 expect(result.status).toBe(500);
 expect(result.body).toEqual({ error: "The dispute change could not be confirmed. Refresh and check its saved status before trying again." });
 const saved = await raw(); expect(saved.disputes[0].adminNotes).toBe("Checked retained receipt.");
 const readback = await request(app).get(`/api/disputes/admin?disputeId=${disputeId}&status=all`).set("Cookie", cookie(admin));
 expect(readback.status).toBe(200); expect(readback.body.items[0].dispute.adminNotes).toBe("Checked retained receipt.");
});

const Notice = require("../models/MatterReviewNotification"), reviewNotices = require("../services/matterReviewNotifications"), sendEmail = require("../utils/email");
const currentSend = (user = para) => request(app).post(`/api/disputes/${matter._id}`).set("Cookie", cookie(user)).send({ message: "The supporting exhibit needs review." });
test.each(["attorney_reviewed", "paralegal_current", "admin_current"])("%s saves exactly one recipient set and no immediate email", async entry => {
 const body = entry === "attorney_reviewed" ? await command() : null;
 const opened = body ? await send(body) : await currentSend(entry === "admin_current" ? admin : para);
 expect(opened.status).toBe(body ? 200 : 201);
 const rows = await Notice.find({ caseId: matter._id }).lean(); expect(rows).toHaveLength(3);
 expect(rows.map(row => String(row.userId)).sort()).toEqual([owner, para, admin].map(user => String(user._id)).sort());
 expect(rows.every(row => row.status === "pending" && row.attempts === 0)).toBe(true);
 expect(JSON.stringify(rows)).not.toMatch(/@disputes.test|lease review|supporting exhibit/);
 expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(3); expect(sendEmail).not.toHaveBeenCalled();
 expect((body ? await send(body) : await currentSend()).status).toBe(body ? 200 : 409);
 expect(await Notice.countDocuments({ caseId: matter._id })).toBe(3);
 sendEmail.mockImplementation(async to => ({ accepted: [to] }));
 await Promise.all([reviewNotices.processNotices(), reviewNotices.processNotices()]);
 expect(sendEmail).toHaveBeenCalledTimes(3); expect(await Notice.countDocuments({ status: "accepted" })).toBe(3);
 await reviewNotices.processNotices(); expect(sendEmail).toHaveBeenCalledTimes(3);
});
test.each(["second_recipient", "queue", "indexes"])("%s failure rolls back review, audit and the entire recipient set", async failure => {
 const body = await command(), before = await raw();
 if (failure === "second_recipient") { const create = Notification.create.bind(Notification); let calls = 0; jest.spyOn(Notification, "create").mockImplementation((...args) => ++calls === 2 ? Promise.reject(new Error("Synthetic second recipient failure")) : create(...args)); }
 if (failure === "queue") jest.spyOn(Notice, "create").mockRejectedValueOnce(new Error("Synthetic email queue failure"));
 if (failure === "indexes") jest.spyOn(Notice.collection, "indexes").mockResolvedValue([]);
 expect((await send(body)).status).toBe(503); expect((await raw()).status).toBe(before.status); expect((await raw()).disputes).toEqual(before.disputes);
 expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(0); expect(await Notice.countDocuments({})).toBe(0); expect(await AuditLog.countDocuments({ action: "dispute.create" })).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
});
test("a lost reviewed commit acknowledgement keeps one durable email set", async () => {
 const start = mongoose.startSession.bind(mongoose); jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw Error("Synthetic lost commit acknowledgement"); }; return session; });
 const body = await command(); expect((await send(body)).status).toBe(200); expect((await send(body)).status).toBe(200);
 expect(await Notice.countDocuments({})).toBe(3); expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(3); expect((await raw()).disputes).toHaveLength(1);
});
test.each(["email", "emailCase", "inApp", "inAppCase"])("%s preference is independent and preserves mandatory administrator review notices", async preference => {
 await User.updateMany({ _id: { $in: [owner._id, para._id, admin._id] } }, { $set: { [`notificationPrefs.${preference}`]: false } });
 expect((await currentSend()).status).toBe(201);
 expect(await Notice.countDocuments({})).toBe(preference === "email" ? 1 : 3); expect(await Notification.countDocuments({ type: "dispute_opened" })).toBe(preference === "inApp" ? 1 : 3);
 expect(await Notice.countDocuments({ userId: admin._id })).toBe(1); expect(await Notification.countDocuments({ userId: admin._id, type: "dispute_opened" })).toBe(1);
});

test("an administrator can load an exact older review beyond the first page without widening member access", async () => {
 const original = (await currentSend()).body.disputeId;
 const earlier = Array.from({ length: 30 }, (_, n) => ({ disputeId: new mongoose.Types.ObjectId().toString(), raisedBy: para._id, message: `Earlier review ${n}`, status: "resolved", createdAt: new Date(2020, 0, n + 1) }));
 await Case.collection.updateOne({ _id: matter._id }, { $push: { disputes: { $each: earlier, $position: 0 } } });
 const endpoint = `/api/disputes/admin?disputeId=${original}&status=all`;
 const response = await request(app).get(endpoint).set("Cookie", cookie(admin)); expect(response.status).toBe(200); expect(response.body.total).toBe(1); expect(response.body.items[0].dispute.disputeId).toBe(original);
 expect((await request(app).get(endpoint).set("Cookie", cookie(owner))).status).toBe(403);
 expect((await request(app).get('/api/disputes/admin?disputeId=%3Cscript%3E').set("Cookie", cookie(admin))).status).toBe(400);
 expect((await request(app).get(`/api/disputes/admin?disputeId=${new mongoose.Types.ObjectId()}`).set("Cookie", cookie(admin))).body.total).toBe(0);
});
