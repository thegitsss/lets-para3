const express = require("express"), cookieParser = require("cookie-parser"), jwt = require("jsonwebtoken"), request = require("supertest"), mongoose = require("mongoose");
const mockStripe = { disputes: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() }, paymentIntents: { retrieve: jest.fn() }, balanceTransactions: { retrieve: jest.fn() }, refunds: { create: jest.fn() }, transfers: { create: jest.fn() } };
jest.mock("../utils/stripe", () => mockStripe);
jest.mock("../utils/email", () => Object.assign(jest.fn(), { sendWelcomePacket: jest.fn(), sendProfilePhotoRejectedEmail: jest.fn() }));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => ({ ok: true })) }));
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const User = require("../models/User"), AuthSession = require("../models/AuthSession"), Case = require("../models/Case"), Operation = require("../models/PaymentOperation"), Payout = require("../models/Payout"), Income = require("../models/PlatformIncome"), Adjustment = require("../models/FinancialAdjustment"), Audit = require("../models/AuditLog");
const { recordChargebackEvent } = require("../services/chargebackService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use("/api/admin", require("../routes/admin"));
let admin, owner, para, matter, operation, event, dispute, charge, intent;
const cookie = (user = admin, sid) => `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0, ...(sid ? { sid } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const reconcile = (user = admin, sid, operationId = operation._id) => request(app).post(`/api/admin/chargebacks/${operationId}/reconcile`).set("Cookie", cookie(user, sid)).send({});
const financial = async () => ({ operation: await Operation.findById(operation._id).lean(), adjustments: await Adjustment.find().sort({ _id: 1 }).lean(), audits: await Audit.find().sort({ _id: 1 }).lean(), matter: await Case.findById(matter._id).lean() });
const recover = () => { dispute.status = "won"; dispute.balance_transactions.push({ id: "txn_reconciliation_credit", object: "balance_transaction", type: "adjustment", reporting_category: "dispute_reversal", source: dispute.id, amount: 48800, fee: -1500, net: 50300, currency: "usd", created: 1789038000 }); };
const duringProviderRead = async (change, options = {}) => {
  let arrive, release; const waiting = new Promise(resolve => { arrive = resolve; }), gate = new Promise(resolve => { release = resolve; });
  mockStripe.charges.retrieve.mockImplementationOnce(async () => { arrive(); await gate; return structuredClone(charge); });
  const pending = reconcile(admin, options.sid).then(response => response);
  try { await waiting; await change(); release(); return await pending; } finally { release(); await pending; }
};
beforeAll(async () => { await connect(); await Promise.all([User.init(), AuthSession.init(), Case.init(), Operation.init(), Payout.init(), Income.init(), Adjustment.init(), Audit.init()]); });
afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); for (const group of Object.values(mockStripe)) for (const fn of Object.values(group)) fn.mockReset();
  [admin, owner, para] = await User.create(["admin", "attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@chargeback-reconciliation.test`, password: "Synthetic123!", role, status: "approved", authVersion: 0 })));
  matter = await Case.create({ title: "River Street lease payment review", details: "Administrative card-dispute evidence review.", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: "usd", stripeMode: "test", paymentIntentId: "pi_reconciliation", escrowIntentId: "pi_reconciliation", escrowStatus: "funded", paymentStatus: "succeeded" });
  charge = { id: "ch_reconciliation", object: "charge", payment_intent: "pi_reconciliation", amount: 48800, amount_captured: 48800, amount_refunded: 0, paid: true, captured: true, disputed: true, status: "succeeded", currency: "usd", livemode: false, metadata: { caseId: String(matter._id) } };
  intent = { id: "pi_reconciliation", object: "payment_intent", status: "succeeded", amount: 48800, amount_received: 48800, currency: "usd", livemode: false, latest_charge: charge, transfer_group: `case_${matter._id}`, metadata: { caseId: String(matter._id), attorneyId: String(owner._id) } };
  dispute = { id: "du_reconciliation", object: "dispute", status: "under_review", amount: 48800, currency: "usd", livemode: false, charge: charge.id, payment_intent: intent.id, created: 1788951600, metadata: { caseId: String(matter._id) }, balance_transactions: [{ id: "txn_reconciliation_debit", object: "balance_transaction", type: "adjustment", reporting_category: "dispute", source: "du_reconciliation", amount: -48800, fee: 1500, net: -50300, currency: "usd", created: 1788951600 }] };
  mockStripe.disputes.retrieve.mockImplementation(async () => structuredClone(dispute)); mockStripe.charges.retrieve.mockImplementation(async () => structuredClone(charge)); mockStripe.paymentIntents.retrieve.mockImplementation(async () => structuredClone(intent));
  event = { id: "evt_reconciliation_original", type: "charge.dispute.created", created: 1788955200, livemode: false, data: { object: structuredClone(dispute) } };
  operation = (await recordChargebackEvent({ event, stripeClient: mockStripe })).operation;
});
test("an administrator records a fresh provider observation without changing the retained callback or duplicating money", async () => {
  const callback = await Audit.findOne().lean(), debits = await Adjustment.find().sort({ _id: 1 }).lean(); recover();
  expect((await reconcile()).status).toBe(200); expect((await Operation.findById(operation._id)).processorStatus).toBe("won");
  expect(await Audit.findById(callback._id).lean()).toEqual(callback); expect(await Adjustment.find({ direction: "debit" }).sort({ _id: 1 }).lean()).toEqual(debits);
  expect(await Adjustment.countDocuments()).toBe(4); expect(await Adjustment.distinct("stripeEventId")).toEqual([event.id]);
  const observation = await Audit.findOne({ action: "chargeback.admin.reconcile" }).lean(); expect(observation).toMatchObject({ actor: admin._id, meta: { eventId: event.id, observationOrigin: "admin_reconciliation" } }); expect(String(observation._id)).not.toBe(String(callback._id));
  expect((await reconcile()).status).toBe(200); expect(await Adjustment.countDocuments()).toBe(4); expect(await Audit.countDocuments({ action: "chargeback.admin.reconcile" })).toBe(2);
  expect(mockStripe.transfers.create).not.toHaveBeenCalled(); expect(mockStripe.refunds.create).not.toHaveBeenCalled();
});
test("a failed administrative audit rolls back the recovery and can be safely checked again", async () => {
  const before = await financial(); recover(); jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic administrative audit unavailable"));
  expect((await reconcile()).status).toBe(500); expect(await financial()).toEqual(before);
  expect((await reconcile()).status).toBe(200); expect(await Adjustment.countDocuments()).toBe(4); expect(await Audit.countDocuments({ action: "chargeback.admin.reconcile" })).toBe(1);
});
test("provider unavailability leaves the previous financial observation intact", async () => {
  const before = await financial(); mockStripe.disputes.retrieve.mockRejectedValueOnce(new Error("Synthetic provider unavailable"));
  expect((await reconcile()).status).toBe(500); expect(await financial()).toEqual(before);
});
test("a changed chargeback requires reopening the record instead of overwriting another observation", async () => {
  recover(); const before = await financial(); const response = await duringProviderRead(() => Operation.updateOne({ _id: operation._id }, { $set: { administrativeStatus: "acknowledged" } }));
  expect(response.status).toBe(409); expect(response.body.code).toBe("CHARGEBACK_CHANGED"); expect(response.body.msg).toContain("Open the card dispute again");
  expect((await Operation.findById(operation._id)).administrativeStatus).toBe("acknowledged"); expect(await Adjustment.find().sort({ _id: 1 }).lean()).toEqual(before.adjustments); expect(await Audit.find().sort({ _id: 1 }).lean()).toEqual(before.audits);
});
test.each([{ disabled: true }, { role: "attorney" }, { authVersion: 1 }])("administrator access changed during verification: %j", async patch => {
  const before = await financial(); recover(); const response = await duringProviderRead(() => User.updateOne({ _id: admin._id }, { $set: patch }));
  expect(response.status).toBe(403); expect(response.body.code).toBe("CHARGEBACK_ADMIN_CHANGED"); expect(await financial()).toEqual(before);
});
test("a session revoked during the provider read cannot retain a new financial observation", async () => {
  const sid = "synthetic_chargeback_admin_session"; await AuthSession.create({ userId: admin._id, sessionId: sid, expiresAt: new Date(Date.now() + 3600000) });
  const before = await financial(); recover(); const response = await duringProviderRead(() => AuthSession.updateOne({ sessionId: sid }, { $set: { revokedAt: new Date() } }), { sid });
  expect(response.status).toBe(403); expect(response.body.code).toBe("CHARGEBACK_ADMIN_CHANGED"); expect(await financial()).toEqual(before);
});
test("the chargeback list and reconciliation enforce role and identifier boundaries", async () => {
  mockStripe.disputes.retrieve.mockClear();
  for (const user of [owner, para]) { expect((await request(app).get("/api/admin/chargebacks").set("Cookie", cookie(user))).status).toBe(403); expect((await reconcile(user)).status).toBe(403); }
  expect((await reconcile(admin, null, "invalid")).status).toBe(400); expect((await reconcile(admin, null, new mongoose.Types.ObjectId())).status).toBe(404); expect(mockStripe.disputes.retrieve).not.toHaveBeenCalled();
});
test("a selected chargeback list contains only that retained record and its exposure", async () => {
  await Operation.create({ operationKey: "chargeback:dp_other", kind: "chargeback", fingerprint: "synthetic_other_chargeback", amount: 10, currency: "usd", stripeDisputeId: "dp_other" });
  const response = await request(app).get(`/api/admin/chargebacks?id=${operation._id}`).set("Cookie", cookie());
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ total: 1, pages: 1, items: [{ id: String(operation._id), chargebackAmount: 48800, netExposure: 50300, debitEvidence: 50300, creditEvidence: 0, evidenceCount: 2, payoutHold: true }] });
  expect((await request(app).get("/api/admin/chargebacks?id=invalid").set("Cookie", cookie())).status).toBe(400);
});
const decide = action => request(app).post(`/api/admin/chargebacks/${operation._id}/${action}`).set("Cookie", cookie()).send({});
test.each(["acknowledge", "clear-hold"])("an interrupted %s audit cannot leave an unaudited administrative decision", async action => {
  if (action === "clear-hold") { recover(); expect((await reconcile()).status).toBe(200); }
  const before = await financial(); jest.spyOn(Audit, "create").mockRejectedValueOnce(new Error("Synthetic review decision audit unavailable")); jest.spyOn(Audit, "logFromReq").mockRejectedValueOnce(new Error("Synthetic legacy review decision audit unavailable"));
  expect((await decide(action)).status).toBe(500); expect(await financial()).toEqual(before);
});
test("a missing paid status cannot be bypassed by clearing a won card-dispute hold", async () => {
  recover(); expect((await reconcile()).status).toBe(200); await Payout.collection.insertOne({ caseId: matter._id, paralegalId: para._id, amountPaid: 32800, transferId: "tr_unconfirmed", status: null, stripeMode: "test" });
  const before = await financial(); expect((await decide("clear-hold")).status).toBe(409); expect(await financial()).toEqual(before);
});
test("a reconciled win can clear the remaining payout hold while keeping an earlier partial payout intact", async () => {
  const transferId = "tr_prior_assignment", operationKey = "partial_payout:prior_assignment";
  await Payout.create({ caseId: matter._id, paralegalId: para._id, amountPaid: 8200, transferId, operationKey, status: "paid", stripeMode: "test" });
  await Operation.create({ caseId: matter._id, operationKey, kind: "partial_payout", fingerprint: "prior_assignment", status: "succeeded", amount: 8200, stripeTransferId: transferId, stripeObjectId: transferId, currency: "usd", stripeMode: "test" });
  await Case.updateOne({ _id: matter._id }, { $set: { remainingAmount: 30000, withdrawalHistory: [{ withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedAt: new Date(), payoutFinalizedType: "partial_attorney", payoutTransferId: transferId }] } });
  recover(); expect((await reconcile()).status).toBe(200); expect((await Operation.findById(operation._id)).payoutPosition).toBe("post_payout");
  const hold = require("../services/payoutHoldService").getPayoutHold, paid = await Payout.findOne().lean(); expect((await hold(matter._id)).held).toBe(true);
  const listing = await request(app).get(`/api/admin/chargebacks?id=${operation._id}`).set("Cookie", cookie()); expect(listing.body.items[0].payoutHold).toBe(true);
  expect((await decide("clear-hold")).body.changed).toBe(true); expect((await decide("clear-hold")).body.changed).toBe(false); expect((await hold(matter._id)).held).toBe(false); expect(await Payout.findOne().lean()).toEqual(paid); expect(await Audit.countDocuments({ action: "chargeback.admin.hold_clear" })).toBe(1);
});
test.each(["acknowledge", "clear-hold"])("%s rechecks administrator access before committing the decision", async action => {
  if (action === "clear-hold") { recover(); expect((await reconcile()).status).toBe(200); }
  const before = await financial(), start = mongoose.startSession.bind(mongoose); let arrive, release;
  const waiting = new Promise(resolve => { arrive = resolve; }), gate = new Promise(resolve => { release = resolve; });
  jest.spyOn(mongoose, "startSession").mockImplementationOnce(async () => { arrive(); await gate; return start(); });
  const pending = decide(action).then(response => response);
  try { await waiting; await User.updateOne({ _id: admin._id }, { $set: { disabled: true } }); release(); expect((await pending).status).toBe(403); expect(await financial()).toEqual(before); } finally { release(); await pending; }
});
