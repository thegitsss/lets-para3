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
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
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
test.each([39999, 40000, 40001])("hiring review applies the Matter minimum to the recorded %i-cent amount without charging or changing it", async amount => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { totalAmount: amount, lockedTotalAmount: amount } });
  const before = await Case.collection.findOne({ _id: matter._id }), response = await read();
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ budgetCents: amount, canHire: amount >= 40000 });
  if (amount < 40000) {
    expect(response.body.reason).toBe('amount_unavailable');
    expect((await hire(response.body.revision)).status).toBe(409);
  }
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("hiring review reads the exact locked amount, rounded fee and saved card without changes", async () => {
  const before = await Case.collection.findOne({ _id: matter._id }), value = await read(); expect(value.status).toBe(200); expect(value.body).toMatchObject({ caseId: String(matter._id), applicantId: String(para._id), canHire: true, canResume: false, budgetCents: 40001, feeCents: 8800, chargeCents: 48801, card: { id: "pm_synthetic", last4: "4242" } }); expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before); expect(stripe.paymentIntents.create).not.toHaveBeenCalled(); expect(stripe.customers.create).not.toHaveBeenCalled();
});
test("reviewed hiring charges the shown amount once and preserves other applicant history", async () => {
  const review = await read(), response = await hire(review.body.revision); expect(response.status).toBe(200); expect(response.body.hiringConfirmation).toMatchObject({ caseId: String(matter._id), applicantId: String(para._id), reviewedRevision: review.body.revision, mode: "hire_and_fund", chargeCents: 48801 });
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1); expect(stripe.paymentIntents.create.mock.calls[0][0]).toMatchObject({ amount: 48801, customer: "cus_synthetic", payment_method: "pm_synthetic", off_session: true, confirm: true });
  const saved = await Case.collection.findOne({ _id: matter._id }); expect(String(saved.paralegalId)).toBe(String(para._id)); expect(saved.status).toBe("in progress"); expect(saved.applicants.map(entry => entry.status)).toEqual(["accepted", "rejected"]); expect((await hire(review.body.revision)).status).toBe(409); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test.each(["amount", "card", "application", "pre_engagement", "owner", "profile", "block"])("changed %s prevents a charge from an earlier review", async kind => {
  const review = await read();
  if (kind === "amount") await Case.collection.updateOne({ _id: matter._id }, { $set: { lockedTotalAmount: 41000 } });
  if (kind === "card") stripe.customers.retrieve.mockResolvedValue({ invoice_settings: { default_payment_method: null } });
  if (kind === "application") await Case.collection.updateOne({ _id: matter._id }, { $set: { "applicants.0.status": "rejected" } });
  if (kind === "pre_engagement") await Case.collection.updateOne({ _id: matter._id }, { $set: { preEngagement: { status: "submitted", requestedParalegalId: para._id } } });
  if (kind === "owner") await Case.collection.updateOne({ _id: matter._id }, { $set: { attorney: other._id, attorneyId: other._id } });
  if (kind === "profile") await User.collection.updateOne({ _id: para._id }, { $set: { disabled: true } });
  if (kind === "block") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  expect([403, 404, 409]).toContain((await hire(review.body.revision)).status); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("approved requirements for another applicant do not authorize this hire", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { preEngagement: { status: "approved", requestedParalegalId: loser._id, conflictsCheckRequired: true, conflictsDetails: "Synthetic named parties", conflictsResponseType: "none_known" } } }); const value = await read(); expect(value.status).toBe(200); expect(value.body).toMatchObject({ canHire: false, reason: "pre_engagement_required" });
});
test("a provider read failure cannot be shown as a missing card", async () => { stripe.paymentMethods.retrieve.mockRejectedValueOnce(new Error("Synthetic provider unavailable")); const value = await read(); expect(value.status).toBe(503); expect(value.body.reason).toBeUndefined(); });
test("token revocation during the final provider read withholds the hiring review", async () => {
  const original = stripe.paymentMethods.retrieve.getMockImplementation(); let reads = 0; stripe.paymentMethods.retrieve.mockImplementation(async (...args) => { if (++reads === 2) await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return original(...args); }); expect((await read()).status).toBe(403);
});
test("a raw Matter change immediately before the claim prevents charging", async () => {
  const review = await read(), original = Case.collection.findOneAndUpdate.bind(Case.collection);
  jest.spyOn(Case.collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => { await Case.collection.updateOne({ _id: matter._id }, { $set: { lockedTotalAmount: 42000 } }); return original(...args); }); expect((await hire(review.body.revision)).status).toBe(409); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("an unknown charge response retains the claim and cannot cause another charge", async () => {
  const review = await read(); stripe.paymentIntents.create.mockRejectedValueOnce(new Error("Synthetic lost processor response")); expect((await hire(review.body.revision)).status).toBe(409); const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved.hiringClaimStatus).toBe("needs_reconciliation");
  const value = await read(); expect(value.body).toMatchObject({ canHire: false, canResume: false, reason: "reconciliation" }); expect((await hire(value.body.revision)).status).toBe(409); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test("a provider-confirmed canceled card attempt is retained as failed evidence before a new review", async () => {
  const review = await read(); stripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error("Synthetic decline"), { type: "StripeCardError", payment_intent: { id: "pi_synthetic" } })); stripe.paymentIntents.retrieve.mockResolvedValue(intent({ status: "requires_payment_method", amount_received: 0 }));
  const result = await hire(review.body.revision); expect(result.status).toBe(402); expect(result.body.code).toBe("HIRING_CARD_NOT_CHARGED"); expect((await PaymentOperation.findOne({ operationKey: "hire-card-failure:pi_synthetic" })).status).toBe("failed"); const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved.fundingRequestKey).toBe(""); expect(saved.hiringClaimStatus).toBeNull(); expect((await read()).body.canHire).toBe(true);
});
test("failed cancellation cannot release an uncertain funding attempt", async () => {
  const review = await read(); stripe.paymentIntents.create.mockResolvedValueOnce(intent({ status: "requires_action", amount_received: 0 })); stripe.paymentIntents.retrieve.mockResolvedValue(intent({ status: "requires_action", amount_received: 0 })); stripe.paymentIntents.cancel.mockRejectedValueOnce(new Error("Synthetic cancellation unavailable")); expect((await hire(review.body.revision)).status).toBe(409); expect((await Case.findById(matter._id)).hiringClaimStatus).toBe("needs_reconciliation");
});
test("a successful charge can finish an interrupted hire without another charge or saved-card requirement", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { hiringClaimToken: "earlier", hiringClaimStatus: "needs_reconciliation", hiringClaimParalegalId: para._id, hiringClaimPaymentIntentId: "pi_synthetic", hiringClaimAmount: 48801, fundingRequestKey: "earlier-key" } }); stripe.customers.retrieve.mockResolvedValue({ invoice_settings: { default_payment_method: null } });
  const review = await read(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ canHire: false, canResume: true, fundingVerified: true }); const response = await hire(review.body.revision); expect(response.status).toBe(200); expect(response.body.hiringConfirmation).toMatchObject({ mode: "finish_hire", chargeCents: 0 }); expect(stripe.paymentIntents.create).not.toHaveBeenCalled(); expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test("a post-charge Matter change prevents stale finalization and preserves reconciliation evidence", async () => {
  const review = await read(); stripe.paymentIntents.create.mockImplementationOnce(async data => { await Case.collection.updateOne({ _id: matter._id }, { $set: { "tasks.0.title": "Changed scope after claim" } }); return { ...intent(), ...data }; }); const response = await hire(review.body.revision); expect(response.status).toBe(500); const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved.tasks[0].title).toBe("Changed scope after claim"); expect(saved.paralegalId).toBeNull(); expect(saved.hiringClaimStatus).toBe("needs_reconciliation"); expect(saved.hiringClaimPaymentIntentId).toBe("pi_synthetic");
});
async function finalizedReplacement() {
  const at = new Date("2026-09-02T12:00:00Z"), key = `partial_payout:${matter._id}:retained`;
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: "paused", pausedReason: "paralegal_withdrew", pausedAt: new Date("2026-09-01"), withdrawnParalegalId: loser._id, payoutFinalizedAt: at, payoutFinalizedType: "partial_attorney", partialPayoutAmount: 28001, remainingAmount: 12000, payoutTransferId: "tr_retained_hiring", payoutStatus: "paid", paidOutAt: at, stripeMode: "test", escrowIntentId: "pi_synthetic", escrowStatus: "funded", fundingIntegrityStatus: "verified" } });
  await require("../models/Payout").collection.insertOne({ caseId: matter._id, paralegalId: loser._id, operationKey: key, amountPaid: 22961, transferId: "tr_retained_hiring", stripeMode: "test", livemode: false, status: "paid", createdAt: at });
  await PaymentOperation.collection.insertOne({ caseId: matter._id, operationKey: key, kind: "partial_payout", status: "succeeded", amount: 22961, transferAmount: 22961, currency: "usd", stripeMode: "test", livemode: false, stripeTransferId: "tr_retained_hiring", completedAt: at });
}
test("replacement hiring uses verified remaining funding without a new card charge", async () => {
  await finalizedReplacement(); await Case.collection.updateOne({ _id: matter._id }, { $set: { "tasks.0.completed": true } });
  const review = await read(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ canHire: true, relisted: true, remainingCents: 12000, chargeCents: 0, fundingVerified: true });
  const response = await hire(review.body.revision); expect(response.status).toBe(200); expect(response.body.hiringConfirmation).toMatchObject({ mode: "replacement", chargeCents: 0, remainingCents: 12000 }); const saved = await Case.findById(matter._id); expect(saved.assignmentCompletedTaskIndexes).toEqual([0]); expect(stripe.paymentIntents.create).not.toHaveBeenCalled(); expect(stripe.customers.retrieve).not.toHaveBeenCalled();
});
test("earlier replacement funding can be reviewed without inventing a missing amount lock", async () => {
  await finalizedReplacement(); await Case.collection.updateOne({ _id: matter._id }, { $unset: { lockedTotalAmount: "" } }); const review = await read(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ canHire: true, budgetCents: 40001, relisted: true }); expect((await hire(review.body.revision)).status).toBe(200); expect((await Case.collection.findOne({ _id: matter._id })).lockedTotalAmount).toBeUndefined(); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("replacement balance changes after review prevent assignment", async () => {
  await finalizedReplacement(); const review = await read(); await Case.collection.updateOne({ _id: matter._id }, { $set: { remainingAmount: 0 } }); expect((await hire(review.body.revision)).status).toBe(409); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("two simultaneous reviewed hires cannot both acquire the Matter", async () => {
  const review = await read(); const responses = await Promise.all([hire(review.body.revision), hire(review.body.revision)]); expect(responses.map(value => value.status).sort()).toEqual([200, 409]); expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test("reviewed hiring updates canonical applications, the posting and the Case mirrors", async () => {
  const Job = require("../models/Job"), Application = require("../models/Application"), jobId = new Types.ObjectId();
  await Job.collection.insertOne({ _id: jobId, caseId: matter._id, attorneyId: owner._id, status: "open", title: matter.title }); await Case.collection.updateOne({ _id: matter._id }, { $set: { jobId, job: jobId } });
  await Application.collection.insertMany([{ jobId, paralegalId: para._id, status: "shortlisted", createdAt: new Date() }, { jobId, paralegalId: loser._id, status: "submitted", createdAt: new Date() }]);
  const review = await read(); expect(review.status).toBe(200); expect(review.body.canHire).toBe(true); expect((await hire(review.body.revision)).status).toBe(200);
  expect((await Job.findById(jobId)).status).toBe("assigned"); expect((await Application.findOne({ jobId, paralegalId: para._id })).status).toBe("accepted"); expect((await Application.findOne({ jobId, paralegalId: loser._id })).status).toBe("rejected"); expect((await Case.findById(matter._id)).applicants.map(entry => entry.status)).toEqual(["accepted", "rejected"]);
});
test("a resumed hire retains its successful-charge reference if account eligibility changes after claim", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { hiringClaimToken: "earlier", hiringClaimStatus: "needs_reconciliation", hiringClaimParalegalId: para._id, hiringClaimPaymentIntentId: "pi_synthetic", hiringClaimAmount: 48801, fundingRequestKey: "earlier-key" } });
  const review = await read(), Session = require("mongoose").mongo.ClientSession;
  const original = Session.prototype.commitTransaction;
  // The claim now includes a User lock. Change eligibility after its actual
  // commit, rather than waiting on an external User write inside that lock.
  jest.spyOn(Session.prototype, "commitTransaction").mockImplementationOnce(async function (...args) { const result = await original.apply(this, args); await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return result; });
  expect((await hire(review.body.revision)).status).toBe(403); const saved = await Case.collection.findOne({ _id: matter._id }); expect(saved.hiringClaimStatus).toBe("needs_reconciliation"); expect(saved.hiringClaimPaymentIntentId).toBe("pi_synthetic"); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test.each(["missing_payee", "missing_payout", "reversed", "unresolved", "duplicate_transfer", "chargeback_hold", "contradictory_balance", "unmatched_pending_transfer", "missing_remaining"])("replacement review explains the prior %s blocker before offering hiring", async scenario => {
  await finalizedReplacement();
  const Payout = require("../models/Payout");
  if (scenario === "missing_remaining") await Case.collection.updateOne({ _id: matter._id }, { $unset: { remainingAmount: "" } });
  if (scenario === "contradictory_balance") await Case.collection.updateOne({ _id: matter._id }, { $set: { remainingAmount: 11000 } });
  if (scenario === "unmatched_pending_transfer") await PaymentOperation.collection.insertOne({ caseId: matter._id, operationKey: "unmatched-retained-transfer", kind: "case_payout", status: "pending", amount: 9840 });
  if (scenario === "missing_payee") await Case.collection.updateOne({ _id: matter._id }, { $unset: { withdrawnParalegalId: "" } });
  if (scenario === "missing_payout") await Payout.collection.deleteMany({ caseId: matter._id });
  if (scenario === "reversed") await Payout.collection.updateOne({ caseId: matter._id }, { $set: { status: "reversed" } });
  if (scenario === "unresolved") await PaymentOperation.collection.updateOne({ caseId: matter._id }, { $set: { status: "needs_reconciliation" } });
  if (scenario === "duplicate_transfer") await PaymentOperation.collection.insertOne({ caseId: new Types.ObjectId(), operationKey: "foreign-retained-hiring", stripeTransferId: "tr_retained_hiring" });
  if (scenario === "chargeback_hold") await PaymentOperation.collection.insertOne({ caseId: matter._id, operationKey: "held-retained-hiring", kind: "chargeback", payoutPosition: "post_payout", administrativeStatus: "pending_review" });
  const before = await Case.collection.findOne({ _id: matter._id });
  const review = await read(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ canHire: false, canResume: false, reason: "withdrawal_review_required", relisted: true, chargeCents: 0 });
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
  expect((await hire(review.body.revision)).status).toBe(409); expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("unavailable prior-payout reads are errors rather than a completed review", async () => {
  await finalizedReplacement(); jest.spyOn(require("../models/Payout").collection, "find").mockImplementationOnce(() => { throw new Error("Synthetic prior ledger unavailable"); });
  const value = await read(); expect(value.status).toBe(503); expect(value.body.reason).toBeUndefined();
});
test("a still-valid earlier payout change invalidates the reviewed replacement", async () => {
  await finalizedReplacement(); const review = await read(); expect(review.body.canHire).toBe(true);
  await PaymentOperation.collection.updateOne({ caseId: matter._id }, { $set: { completedAt: new Date("2026-09-02T12:00:01Z") } });
  const current = await read(); expect(current.body.canHire).toBe(true); expect(current.body.revision).not.toBe(review.body.revision);
  expect((await hire(review.body.revision)).status).toBe(409); expect((await Case.findById(matter._id)).paralegalId).toBeNull();
});
test("an earlier ledger change after the hire claim prevents the reviewed handoff", async () => {
  await finalizedReplacement(); const review = await read(), Session = require("mongoose").mongo.ClientSession, commit = Session.prototype.commitTransaction;
  jest.spyOn(Session.prototype, "commitTransaction").mockImplementationOnce(async function (...args) {
    const result = await commit.apply(this, args);
    await PaymentOperation.collection.updateOne({ caseId: matter._id }, { $set: { completedAt: new Date("2026-09-02T12:00:02Z") } });
    return result;
  });
  const result = await hire(review.body.revision); expect(result.status).toBe(409); expect(result.body.code).toBe("HIRING_WITHDRAWAL_REVIEW_REQUIRED");
  const saved = await Case.findById(matter._id); expect(saved.paralegalId).toBeNull(); expect(saved.withdrawalHistory).toHaveLength(0); expect(saved.payoutTransferId).toBe("tr_retained_hiring");
});

test("a retained attorney fee override reaches review, charge and confirmation without using the published default", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { feeAttorneyPct: 10 } });
  const previous = [stripe.getPaymentIntentCharge, stripe.isTransferablePaymentIntent, stripe.paymentIntents.retrieve].map(mock => mock.getMockImplementation());
  const charge = { id: "ch_synthetic", paid: true, status: "succeeded", amount: 44001, amount_refunded: 0 };
  stripe.getPaymentIntentCharge.mockImplementation(() => charge);
  stripe.isTransferablePaymentIntent.mockImplementation(() => ({ transferable: true, charge }));
  stripe.paymentIntents.retrieve.mockImplementation(async () => intent({ amount: 44001, amount_received: 44001 }));
  try {
    const review = await read(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ budgetCents: 40001, feeCents: 4000, chargeCents: 44001, canHire: true });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    const response = await hire(review.body.revision); expect(response.status).toBe(200); expect(response.body.hiringConfirmation).toMatchObject({ budgetCents: 40001, chargeCents: 44001, reviewedRevision: review.body.revision });
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1); expect(stripe.paymentIntents.create.mock.calls[0][0].amount).toBe(44001);
    expect((await Case.collection.findOne({ _id: matter._id })).feeAttorneyPct).toBe(10);
  } finally {
    [stripe.getPaymentIntentCharge, stripe.isTransferablePaymentIntent, stripe.paymentIntents.retrieve].forEach((mock, index) => mock.mockImplementation(previous[index]));
  }
});
