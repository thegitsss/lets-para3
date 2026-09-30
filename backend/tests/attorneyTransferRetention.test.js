const mongoose = require("mongoose");
const PaymentOperation = require("../models/PaymentOperation");
const { createPayoutTransfer } = require("../services/payoutHoldService");
const { claimPaymentOperation, failPaymentOperation } = require("../services/paymentOperationService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

beforeAll(async () => { await connect(); await PaymentOperation.init(); });
afterAll(closeDatabase);
beforeEach(clearDatabase);
afterEach(() => jest.restoreAllMocks());

async function fixture(kind = "case_payout") {
  const caseId = new mongoose.Types.ObjectId();
  const args = { caseId, operationKey: `${kind}:${caseId}`, kind, amount: 32800, currency: "usd", fingerprint: { amount: 32800, paymentIntentId: "pi_funded" } };
  const { operation } = await claimPaymentOperation(args);
  const transfer = { id: "tr_record_before_bookkeeping", object: "transfer", amount: 32800, currency: "usd" };
  const stripeClient = { transfers: { create: jest.fn(async () => transfer) } };
  return { args, operation, transfer, stripeClient, input: { caseId, operation, stripeClient, payload: { amount: 32800, currency: "usd" }, stripeOptions: { idempotencyKey: "retention-test" } } };
}

test("retains a successful transfer before chargeback bookkeeping fails", async () => {
  const f = await fixture();
  jest.spyOn(PaymentOperation, "updateMany").mockRejectedValueOnce(new Error("bookkeeping unavailable"));
  await expect(createPayoutTransfer(f.input)).rejects.toThrow("bookkeeping unavailable");
  const stored = await PaymentOperation.findById(f.operation._id).lean();
  expect(stored.stripeTransferId).toBe(f.transfer.id);
  expect(stored.transferAmount).toBe(32800);
  expect(stored.status).toBe("needs_reconciliation");
  expect(f.stripeClient.transfers.create).toHaveBeenCalledTimes(1);
});
test.each(["pending", "requires_action", "failed", "canceled", null])("a settlement cannot request a payout while its retained refund status is %s", async refundStatus => {
  const f = await fixture("dispute_settlement"); await PaymentOperation.updateOne({ _id: f.operation._id }, { $set: { stripeRefundId: "re_retained", refundStatus, refundEvidenceStatus: "verified", refundVerifiedAt: new Date() } });
  await expect(createPayoutTransfer(f.input)).rejects.toThrow(/review/); expect(f.stripeClient.transfers.create).not.toHaveBeenCalled(); expect((await PaymentOperation.findById(f.operation._id)).stripeTransferId).toBe("");
});

test.each(["case_payout", "partial_payout", "dispute_settlement"])("keeps an unknown %s result blocked beyond the provider key lifetime", async kind => {
  const f = await fixture(kind);
  f.stripeClient.transfers.create.mockRejectedValueOnce(new Error("response lost"));
  await expect(createPayoutTransfer(f.input)).rejects.toThrow("response lost");
  await failPaymentOperation(f.operation, new Error("caller could not finish"));
  await PaymentOperation.updateOne({ _id: f.operation._id }, { $set: { lastAttemptAt: new Date(Date.now() - 3 * 86400000) } });
  const retried = await claimPaymentOperation(f.args);
  expect(retried.acquired).toBe(false);
  expect(retried.needsReconciliation).toBe(true);
  expect((await PaymentOperation.findById(f.operation._id).lean()).status).toBe("needs_reconciliation");
  expect(f.stripeClient.transfers.create).toHaveBeenCalledTimes(1);
});

test("hands the known transfer to the owning Matter claim even when bookkeeping fails", async () => {
  const f = await fixture(), retained = [];
  jest.spyOn(PaymentOperation, "updateMany").mockRejectedValueOnce(new Error("bookkeeping unavailable"));
  await expect(createPayoutTransfer({ ...f.input, onTransfer: async transfer => { retained.push(transfer.id); } })).rejects.toThrow("bookkeeping unavailable");
  expect(retained).toEqual([f.transfer.id]);
});

test("records both references before the first bookkeeping update", async () => {
  const f = await fixture(); let ownerReference = "";
  const update = PaymentOperation.updateMany.bind(PaymentOperation);
  jest.spyOn(PaymentOperation, "updateMany").mockImplementation(async (...args) => {
    expect((await PaymentOperation.findById(f.operation._id).lean()).stripeTransferId).toBe(f.transfer.id);
    expect(ownerReference).toBe(f.transfer.id);
    return update(...args);
  });
  await expect(createPayoutTransfer({ ...f.input, onTransfer: known => { ownerReference = known.id; } })).resolves.toEqual(f.transfer);
  expect((await PaymentOperation.findById(f.operation._id).lean()).evidenceStatus).toBeNull();
});

test("does not contact the provider if the durable request marker cannot be written", async () => {
  const f = await fixture();
  jest.spyOn(PaymentOperation, "findOneAndUpdate").mockRejectedValueOnce(new Error("database unavailable"));
  await expect(createPayoutTransfer(f.input)).rejects.toThrow("database unavailable");
  expect(f.stripeClient.transfers.create).not.toHaveBeenCalled();
});

test("competing requests using the same claimed operation make one transfer", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([createPayoutTransfer(f.input), createPayoutTransfer(f.input)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(f.stripeClient.transfers.create).toHaveBeenCalledTimes(1);
});

test("a replaced attempt cannot contact the provider or mark the replacement failed", async () => {
  const f = await fixture();
  await PaymentOperation.updateOne({ _id: f.operation._id }, { $inc: { attempts: 1 } });
  await expect(createPayoutTransfer(f.input)).rejects.toThrow("requires review");
  await failPaymentOperation(f.operation, new Error("old attempt"));
  const record = await PaymentOperation.findById(f.operation._id).lean();
  expect(record.attempts).toBe(2); expect(record.status).toBe("pending");
  expect(f.stripeClient.transfers.create).not.toHaveBeenCalled();
});

test("retains the transfer if the owning Matter claim write fails", async () => {
  const f = await fixture();
  await expect(createPayoutTransfer({ ...f.input, onTransfer: async () => { throw new Error("Matter claim unavailable"); } })).rejects.toThrow("Matter claim unavailable");
  const record = await PaymentOperation.findById(f.operation._id).lean();
  expect(record.stripeTransferId).toBe(f.transfer.id); expect(record.status).toBe("needs_reconciliation");
});

test("retains the owning Matter reference when the first operation evidence write fails", async () => {
  const f = await fixture(); let ownerReference = "";
  const update = PaymentOperation.findOneAndUpdate.bind(PaymentOperation); let calls = 0;
  jest.spyOn(PaymentOperation, "findOneAndUpdate").mockImplementation((...args) => ++calls === 2 ? Promise.reject(new Error("evidence write failed")) : update(...args));
  await expect(createPayoutTransfer({ ...f.input, onTransfer: known => { ownerReference = known.id; } })).rejects.toThrow("evidence write failed");
  expect(ownerReference).toBe(f.transfer.id);
  const record = await PaymentOperation.findById(f.operation._id).lean();
  expect(record.stripeTransferId).toBe(f.transfer.id); expect(record.status).toBe("needs_reconciliation");
});

test("keeps the durable fence if every database write after provider success fails", async () => {
  const f = await fixture(); let ownerReference = "";
  const update = PaymentOperation.findOneAndUpdate.bind(PaymentOperation); let calls = 0;
  const spy = jest.spyOn(PaymentOperation, "findOneAndUpdate").mockImplementation((...args) => ++calls > 1 ? Promise.reject(new Error("database connection lost")) : update(...args));
  await expect(createPayoutTransfer({ ...f.input, onTransfer: known => { ownerReference = known.id; } })).rejects.toThrow("database connection lost");
  spy.mockRestore();
  expect(ownerReference).toBe(f.transfer.id);
  const record = await PaymentOperation.findById(f.operation._id).lean();
  expect(record.evidenceStatus).toBe("needs_reconciliation"); expect(record.stripeTransferId).toBe("");
  await PaymentOperation.updateOne({ _id: f.operation._id }, { $set: { lastAttemptAt: new Date(Date.now() - 3 * 86400000) } });
  expect((await claimPaymentOperation(f.args)).needsReconciliation).toBe(true);
});

test("does not overwrite another transfer reference discovered during provider processing", async () => {
  const f = await fixture();
  f.stripeClient.transfers.create.mockImplementation(async () => { await PaymentOperation.updateOne({ _id: f.operation._id }, { $set: { stripeTransferId: "tr_other", stripeObjectId: "tr_other" } }); return f.transfer; });
  await expect(createPayoutTransfer(f.input)).rejects.toThrow("operation changed");
  expect((await PaymentOperation.findById(f.operation._id).lean()).stripeTransferId).toBe("tr_other");
});

test.each([null, {}, { id: "not_a_transfer" }])("an unidentified provider result remains under review: %j", async result => {
  const f = await fixture(); f.stripeClient.transfers.create.mockResolvedValueOnce(result);
  await expect(createPayoutTransfer(f.input)).rejects.toThrow("could not be identified");
  expect((await claimPaymentOperation(f.args)).needsReconciliation).toBe(true);
});

test("a development bypass still retains its operation and never calls Stripe", async () => {
  const f = await fixture(), bypassTransfer = { id: "bypass_retained" };
  await expect(createPayoutTransfer({ ...f.input, bypassTransfer })).resolves.toEqual(bypassTransfer);
  expect(f.stripeClient.transfers.create).not.toHaveBeenCalled();
  expect((await PaymentOperation.findById(f.operation._id).lean()).stripeTransferId).toBe(bypassTransfer.id);
});

test("a failed old caller cannot downgrade a completed operation", async () => {
  const f = await fixture();
  await PaymentOperation.updateOne({ _id: f.operation._id }, { $set: { status: "succeeded", stripeTransferId: f.transfer.id } });
  await failPaymentOperation(f.operation, new Error("late caller failure"));
  expect((await PaymentOperation.findById(f.operation._id).lean()).status).toBe("succeeded");
});

test("requires a durable claimed operation before calling Stripe", async () => {
  const f = await fixture();
  await expect(createPayoutTransfer({ ...f.input, operation: undefined })).rejects.toThrow("claimed payment operation");
  expect(f.stripeClient.transfers.create).not.toHaveBeenCalled();
});

test("an older failed refund without optional transfer fields keeps its ordinary retry behavior", async () => {
  const f = await fixture("refund");
  await PaymentOperation.collection.updateOne({ _id: f.operation._id }, { $set: { status: "failed" }, $unset: { stripeTransferId: "", evidenceStatus: "" } });
  const result = await claimPaymentOperation(f.args);
  expect(result.acquired).toBe(true); expect(result.operation.attempts).toBe(2);
});
test("a card-dispute hold recorded while the transfer request is being retained prevents the provider call", async () => {
  const f = await fixture(), update = PaymentOperation.findOneAndUpdate.bind(PaymentOperation); let began = false;
  jest.spyOn(PaymentOperation, "findOneAndUpdate").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (!began) { began = true; await PaymentOperation.create({ caseId: f.args.caseId, operationKey: "chargeback:du_arriving_hold", kind: "chargeback", fingerprint: "arriving_hold", amount: 48800, payoutPosition: "pre_payout", administrativeStatus: "pending_review" }); }
    return result;
  });
  await expect(createPayoutTransfer(f.input)).rejects.toMatchObject({ code: "PAYOUT_HELD_FOR_CHARGEBACK" }); expect(f.stripeClient.transfers.create).not.toHaveBeenCalled(); expect((await PaymentOperation.findById(f.operation._id)).stripeTransferId).toBe("");
});

test("a reversal recorded while retaining the Matter reference cannot be cleared by the transfer helper", async () => {
  const f = await fixture();
  await expect(createPayoutTransfer({ ...f.input, onTransfer: async () => { await PaymentOperation.updateOne({ _id: f.operation._id }, { $set: { stripeTransferId: f.transfer.id, stripeObjectId: f.transfer.id, status: "needs_reconciliation", evidenceStatus: "quarantined", lastError: "Retained reversal" } }); } })).rejects.toThrow(/review|revers|changed/);
  expect(await PaymentOperation.findById(f.operation._id).lean()).toMatchObject({ status: "needs_reconciliation", evidenceStatus: "quarantined", lastError: "Retained reversal" });
});

test("the request amount, mode and source charge are retained before the provider call", async () => {
  const f = await fixture();
  f.stripeClient.transfers.create.mockImplementation(async () => {
    expect(await PaymentOperation.findById(f.operation._id).lean()).toMatchObject({ transferAmount: 32800, stripeMode: "test", stripeChargeId: "ch_requested", evidenceStatus: "needs_reconciliation", stripeTransferId: "" });
    return f.transfer;
  });
  await createPayoutTransfer({ ...f.input, stripeMode: "test", payload: { ...f.input.payload, source_transaction: "ch_requested" } });
});
