"use strict";
const mongoose = require("mongoose");
const { withPayoutTransaction } = require("../services/paymentLedgerService");
afterEach(() => jest.restoreAllMocks());
function owned(commit) {
  let inTransaction = false;
  const session = {
    startTransaction: jest.fn(() => { inTransaction = true; }),
    inTransaction: jest.fn(() => inTransaction),
    commitTransaction: jest.fn(async () => { const result = await commit(() => { inTransaction = false; }); inTransaction = false; return result; }),
    abortTransaction: jest.fn(async () => { inTransaction = false; }),
    endSession: jest.fn(async () => {}),
  };
  jest.spyOn(mongoose, "startSession").mockResolvedValue(session);
  return session;
}
test("an acknowledged financial transaction returns its result and closes its owned session", async () => {
  const session = owned(async () => {}), result = { operation: "owned reservation" };
  await expect(withPayoutTransaction(async current => { expect(current).toBe(session); return result; })).resolves.toBe(result);
  expect(session.commitTransaction).toHaveBeenCalledTimes(1); expect(session.abortTransaction).not.toHaveBeenCalled(); expect(session.endSession).toHaveBeenCalledTimes(1);
});
test("a lost commit acknowledgement returns503 without continuing to a provider call", async () => {
  const lost = new Error("Synthetic committed acknowledgement lost"), session = owned(async committed => { committed(); throw lost; }), provider = jest.fn();
  await expect(withPayoutTransaction(async () => ({ reserved: true })).then(provider)).rejects.toMatchObject({ status: 503, publicCode: "PAYMENT_COMMIT_UNCONFIRMED", cause: lost });
  expect(provider).not.toHaveBeenCalled(); expect(session.commitTransaction).toHaveBeenCalledTimes(1); expect(session.abortTransaction).not.toHaveBeenCalled(); expect(session.endSession).toHaveBeenCalledTimes(1);
});
test("a precommit authority error retains its original denial and aborts", async () => {
  const session = owned(async () => {}), denied = Object.assign(new Error("Current owner denied"), { status: 403, publicCode: "ACCOUNT_CHANGED" });
  await expect(withPayoutTransaction(async () => { throw denied; })).rejects.toBe(denied);
  expect(session.commitTransaction).not.toHaveBeenCalled(); expect(session.abortTransaction).toHaveBeenCalledTimes(1); expect(session.endSession).toHaveBeenCalledTimes(1);
});
test("a known transient commit conflict retains its existing conflict path", async () => {
  const session = owned(async () => { throw Object.assign(new Error("Synthetic conflict"), { code: 112 }); });
  await expect(withPayoutTransaction(async () => null)).rejects.toThrow("Payout ledger evidence changed before it could be confirmed.");
  expect(session.abortTransaction).toHaveBeenCalledTimes(1); expect(session.endSession).toHaveBeenCalledTimes(1);
});
test("an explicit typed commit denial is not replaced with an uncertain response", async () => {
  const denied = Object.assign(new Error("Explicit commit boundary denial"), { status: 403, publicCode: "ACCOUNT_CHANGED" }), session = owned(async () => { throw denied; });
  await expect(withPayoutTransaction(async () => null)).rejects.toBe(denied);
  expect(session.abortTransaction).toHaveBeenCalledTimes(1); expect(session.endSession).toHaveBeenCalledTimes(1);
});
