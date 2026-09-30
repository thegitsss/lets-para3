const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/stripe", () => ({
  customers: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() }, paymentMethods: { retrieve: jest.fn() },
  paymentIntents: { create: jest.fn(), retrieve: jest.fn(), cancel: jest.fn() }, refunds: { create: jest.fn(), list: jest.fn(async () => ({ data: [], has_more: false })) },
  accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(() => ({ transferable: true, charge: { id: "ch_synthetic", paid: true, status: "succeeded", amount: 48801, amount_refunded: 0 } })),
  getPaymentIntentCharge: jest.fn(() => ({ id: "ch_synthetic", paid: true, status: "succeeded", amount: 48801, amount_refunded: 0 })),
  stripeIdempotencyKey: jest.fn((...parts) => parts.join("_")), sanitizeStripeError: jest.fn((_err, fallback) => fallback), caseTransferGroup: jest.fn(caseId => `case_${caseId}`),
}));
const User = require("../models/User"), Case = require("../models/Case"), Block = require("../models/Block"), PaymentOperation = require("../models/PaymentOperation"), stripe = require("../utils/stripe");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/applications", require("../routes/applications"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, loser, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, loser] = await User.create(["owner", "other", "para", "loser"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@hiring.test`, password: "Synthetic123!", role: ["para", "loser"].includes(name) ? "paralegal" : "attorney", status: "approved", stripeCustomerId: "cus_synthetic", stripeAccountId: "acct_synthetic", stripeOnboarded: true, stripePayoutsEnabled: true })));
  matter = await Case.create({ title: "Synthetic reviewed hiring", details: "Reviewed hiring verification", attorney: owner._id, attorneyId: owner._id, totalAmount: 40001, lockedTotalAmount: 40001, feeAttorneyPct: 22, feeParalegalPct: 18, tasks: [{ title: "Prepare exhibits" }], applicants: [{ paralegalId: para._id, status: "pending" }, { paralegalId: loser._id, status: "pending" }] });
  stripe.customers.retrieve.mockResolvedValue({ id: "cus_synthetic", invoice_settings: { default_payment_method: "pm_synthetic" } });
  stripe.paymentMethods.retrieve.mockResolvedValue({ id: "pm_synthetic", type: "card", customer: "cus_synthetic", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 } });
  stripe.paymentIntents.create.mockImplementation(async data => ({ id: "pi_synthetic", status: "succeeded", livemode: false, amount_received: data.amount, ...data }));
  stripe.paymentIntents.retrieve.mockImplementation(async () => intent()); stripe.paymentIntents.cancel.mockImplementation(async () => intent({ status: "canceled", amount_received: 0 })); stripe.refunds.create.mockResolvedValue({ id: "re_synthetic", status: "succeeded" });
});
afterEach(() => jest.restoreAllMocks());
function intent(patch = {}) { return { id: "pi_synthetic", status: "succeeded", amount: 48801, amount_received: 48801, currency: "usd", customer: "cus_synthetic", metadata: { caseId: String(matter._id), attorneyId: String(owner._id), paralegalId: String(para._id) }, transfer_group: `case_${matter._id}`, livemode: false, ...patch }; }
const read = () => request(app).get(`/api/cases/${matter._id}/hiring-review/${para._id}?expectedOwnerId=${owner._id}`).set("Cookie", cookie(owner));
const hire = revision => request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", cookie(owner)).send({ expectedOwnerId: String(owner._id), reviewedRevision: revision });

const Application = require("../models/Application"), Job = require("../models/Job");
async function canonical() {
  const jobId = new Types.ObjectId(), applicationId = new Types.ObjectId(); await Job.collection.insertOne({ _id: jobId, caseId: matter._id, attorneyId: owner._id, status: "open", title: matter.title }); await Case.collection.updateOne({ _id: matter._id }, { $set: { jobId, job: jobId } }); await Application.collection.insertOne({ _id: applicationId, jobId, paralegalId: para._id, status: "submitted", coverLetter: "Synthetic invitation and application race verification.", createdAt: new Date() }); return { jobId, applicationId };
}
const revoke = applicationId => request(app).post(`/api/applications/${applicationId}/revoke`).set("Cookie", cookie(para)).send({});
test("a hire that acquires the Matter prevents application revocation during its charge", async () => {
  const { applicationId } = await canonical(), review = await read(); let revoked;
  stripe.paymentIntents.create.mockImplementationOnce(async data => { revoked = await revoke(applicationId); return { ...intent(), ...data }; });
  const response = await hire(review.body.revision); expect(revoked.status).toBe(409); expect(response.status).toBe(200); expect((await Application.findById(applicationId)).status).toBe("accepted"); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test("revocation that acquires the Matter prevents a reviewed hire before canonical status is written", async () => {
  const { applicationId } = await canonical(), review = await read(); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), original = Application.collection.findOneAndUpdate.bind(Application.collection);
  jest.spyOn(Application.collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => { arrived(); await gate; return original(...args); });
  const removal = revoke(applicationId).then(value => value); let response;
  try { await waiting; response = await hire(review.body.revision); } finally { release(); }
  expect((await removal).status).toBe(200); expect(response.status).toBe(409); expect(stripe.paymentIntents.create).not.toHaveBeenCalled(); expect((await Application.findById(applicationId)).status).toBe("withdrawn");
});
test("revocation blocks the current hiring client while the canonical withdrawal write is delayed", async () => {
  const { applicationId } = await canonical(); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), original = Application.collection.findOneAndUpdate.bind(Application.collection);
  jest.spyOn(Application.collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => { arrived(); await gate; return original(...args); }); const removal = revoke(applicationId).then(value => value); let response;
  try { await waiting; response = await request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", cookie(owner)).send({}); } finally { release(); }
  expect((await removal).status).toBe(200); expect(response.status).toBe(400); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("a failed canonical withdrawal write keeps the missing mirror explicit and blocks hiring", async () => {
  const { applicationId } = await canonical(); jest.spyOn(Application.collection, "findOneAndUpdate").mockRejectedValueOnce(new Error("Synthetic write failure")); expect((await revoke(applicationId)).status).toBe(500);
  const entry = await Application.findById(applicationId); expect(entry.status).toBe("submitted"); expect(entry.syncStatus).toBe("needs_reconciliation"); const current = await read(); expect(current.body.canHire).toBe(false); expect(current.body.reason).toBe("application_unavailable"); expect((await request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", cookie(owner)).send({})).status).toBe(400); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  expect((await revoke(applicationId)).status).toBe(200); expect((await Application.findById(applicationId)).status).toBe("withdrawn");
});
test("a later rejected canonical status is not overwritten by an earlier revocation", async () => {
  const { applicationId } = await canonical(), original = Application.collection.findOneAndUpdate.bind(Application.collection);
  jest.spyOn(Application.collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => { await Application.collection.updateOne({ _id: applicationId }, { $set: { status: "rejected" } }); return original(...args); }); const response = await revoke(applicationId); expect(response.status).toBe(409); const entry = await Application.findById(applicationId); expect(entry.status).toBe("rejected"); expect(entry.syncStatus).toBe("needs_reconciliation");
});
test("an already withdrawn application has one withdrawal history entry and no duplicate removal", async () => {
  const { applicationId, jobId } = await canonical();
  expect((await revoke(applicationId)).status).toBe(200);
  const before = await Case.collection.findOne({ _id: matter._id });
  const second = await revoke(applicationId);
  expect(second.status).toBe(200); expect(second.body.alreadyRevoked).toBe(true);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  const entry = await Application.findById(applicationId);
  expect(entry.statusHistory.filter(item => item.to === "withdrawn")).toHaveLength(1);
  // The other fixture applicant is still pending without a canonical record.
  expect(before.applicants).toEqual([expect.objectContaining({ paralegalId: loser._id, status: "pending" })]);
  expect((await Job.findById(jobId)).applicantsCount).toBe(1);
});
test("earlier text applicant references are removed without losing other applicants or evidence", async () => {
  const { applicationId } = await canonical(); await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: String(owner._id), attorneyId: String(owner._id), "applicants.0.paralegalId": String(para._id), "applicants.1.retainedEvidence": "Keep this", retainedCaseEvidence: "Keep this too" } });
  expect((await revoke(applicationId)).status).toBe(200); const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved.applicants).toHaveLength(1); expect(saved.applicants[0].retainedEvidence).toBe("Keep this"); expect(saved.retainedCaseEvidence).toBe("Keep this too"); expect(saved.attorney).toBe(String(owner._id));
});
test("current hiring still recognizes earlier text canonical and active mirror statuses", async () => {
  const { applicationId, jobId } = await canonical(); await Application.collection.updateOne({ _id: applicationId }, { $set: { jobId: String(jobId), paralegalId: String(para._id), status: "shortlisted", syncStatus: "synced" } }); await Case.collection.updateOne({ _id: matter._id }, { $set: { "applicants.0.paralegalId": String(para._id), "applicants.0.status": "shortlisted" } });
  const response = await request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", cookie(owner)).send({}); expect(response.status).toBe(200); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1); expect((await Application.findById(applicationId)).status).toBe("accepted"); expect((await Job.findById(jobId)).applicantsCount).toBe(0);
});

test("earlier canonical-only applications retain current hiring permission", async () => {
  const { applicationId } = await canonical(); await Case.collection.updateOne({ _id: matter._id }, { $set: { applicants: [] } });
  const response = await request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", cookie(owner)).send({}); expect(response.status).toBe(200); expect((await Application.findById(applicationId)).status).toBe("accepted"); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
const revokeInvite = () => request(app).post(`/api/cases/${matter._id}/invite/revoke`).set("Cookie", cookie(para)).send({});
async function acceptedInvitation() { const result = await canonical(); await Case.collection.updateOne({ _id: matter._id }, { $set: { invites: [{ paralegalId: para._id, status: "accepted", syncStatus: "synced" }] } }); return result; }
test("a claimed hire prevents revoking an accepted invitation during its charge", async () => {
  const { applicationId } = await acceptedInvitation(), review = await read(); let revoked;
  stripe.paymentIntents.create.mockImplementationOnce(async data => { revoked = await revokeInvite(); return { ...intent(), ...data }; });
  expect((await hire(review.body.revision)).status).toBe(200); expect(revoked.status).toBe(409); expect((await Application.findById(applicationId)).status).toBe("accepted");
});
test("accepted invitation revocation prevents hiring while its canonical write is delayed", async () => {
  const { applicationId } = await acceptedInvitation(), review = await read(); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), original = Application.collection.updateOne.bind(Application.collection);
  jest.spyOn(Application.collection, "updateOne").mockImplementationOnce(async (...args) => { arrived(); await gate; return original(...args); });
  const removal = revokeInvite().then(value => value); let strict, current;
  try { await waiting; strict = await hire(review.body.revision); current = await request(app).post(`/api/cases/${matter._id}/hire/${para._id}`).set("Cookie", cookie(owner)).send({}); } finally { release(); }
  expect((await removal).status).toBe(200); expect(strict.status).toBe(409); expect(current.status).toBe(400); expect((await Application.findById(applicationId)).status).toBe("withdrawn"); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("acceptance still synchronizing cannot be reversed by an overlapping invitation revocation", async () => {
  const { applicationId } = await canonical(); await Case.collection.updateOne({ _id: matter._id }, { $set: { invites: [{ paralegalId: para._id, status: "pending", syncStatus: "synced" }] } });
  let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), original = Application.collection.updateOne.bind(Application.collection);
  jest.spyOn(Application.collection, "updateOne").mockImplementationOnce(async (...args) => { arrived(); await gate; return original(...args); });
  const acceptance = request(app).post(`/api/cases/${matter._id}/invite/accept`).set("Cookie", cookie(para)).send({}).then(value => value); let revoked, withdrawn;
  try { await waiting; revoked = await revokeInvite(); withdrawn = await revoke(applicationId); } finally { release(); }
  expect((await acceptance).status).toBe(200); expect(revoked.status).toBe(409); expect(withdrawn.status).toBe(409); expect((await Application.findById(applicationId)).status).toBe("submitted"); expect((await revokeInvite()).status).toBe(200); expect((await Application.findById(applicationId)).status).toBe("withdrawn");
});
test("the withdrawal interlock is private in ordinary Matter model reads", async () => {
  const { applicationId } = await canonical(); expect((await revoke(applicationId)).status).toBe(200); expect((await Case.findById(matter._id).lean()).withdrawnApplicantIds).toBeUndefined(); expect((await Case.collection.findOne({ _id: matter._id })).withdrawnApplicantIds.map(String)).toContain(String(para._id));
});


test("a claimed hire prevents deleting the Matter during its charge", async () => {
  await canonical(); const review = await read(); let deleted;
  stripe.paymentIntents.create.mockImplementationOnce(async data => { deleted = await request(app).delete(`/api/cases/${matter._id}`).set("Cookie", cookie(owner)).send({}); return { ...intent(), ...data }; });
  expect((await hire(review.body.revision)).status).toBe(200); expect(deleted.status).toBe(409); expect(await Case.exists({ _id: matter._id })).toBeTruthy();
});
test("a deletion that finishes before the hiring claim prevents any charge", async () => {
  await canonical(); const review = await read(); expect((await request(app).delete(`/api/cases/${matter._id}`).set("Cookie", cookie(owner)).send({})).status).toBe(200);
  expect([403,404,409]).toContain((await hire(review.body.revision)).status); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("an application arriving during a charge requires reconciliation and can finish without a second charge", async () => {
  const { jobId } = await canonical(); await User.updateOne({ _id: loser._id }, { $set: { profileImage: "https://example.test/synthetic.jpg" } }); stripe.accounts.retrieve.mockResolvedValue({ details_submitted: true, payouts_enabled: true, charges_enabled: true }); const review = await read(); let application;
  stripe.paymentIntents.create.mockImplementationOnce(async data => { application = await require("../routes/applications").createApplicationForJob(String(jobId), { ...loser.toObject(), id: String(loser._id) }, "I can prepare and organize these exhibits for review."); return { ...intent(), ...data }; });
  const first = await hire(review.body.revision); expect(first.status).toBe(500); expect(application.status).toBe("submitted"); const fresh = await read(); expect(fresh.body.canResume).toBe(true); expect((await hire(fresh.body.revision)).status).toBe(200); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1); expect((await Application.findById(application._id)).status).toBe("rejected");
});


test("a revoked invitation still synchronizing cannot be resent by either attorney client", async () => {
  const { applicationId } = await acceptedInvitation(); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }), original = Application.collection.updateOne.bind(Application.collection);
  jest.spyOn(Application.collection, "updateOne").mockImplementationOnce(async (...args) => { arrived(); await gate; return original(...args); });
  const removal = revokeInvite().then(value => value); let review, current;
  try { await waiting; review = await request(app).get(`/api/cases/${matter._id}/invitation-review/${para._id}?expectedOwnerId=${owner._id}`).set("Cookie", cookie(owner)); current = await request(app).post(`/api/cases/${matter._id}/invite`).set("Cookie", cookie(owner)).send({ paralegalId: String(para._id) }); } finally { release(); }
  expect((await removal).status).toBe(200); expect(review.body.canInvite).toBe(false); expect(review.body.reason).toBe("records_unavailable"); expect(current.status).toBe(409); expect((await Application.findById(applicationId)).status).toBe("withdrawn");
});
