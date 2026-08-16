const mongoose = require("mongoose");
const PaymentOperation = require("../models/PaymentOperation");
const {
  STALE_PENDING_MS,
  claimPaymentOperation,
  failPaymentOperation,
  succeedPaymentOperation,
} = require("../services/paymentOperationService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

function input(overrides = {}) {
  const caseId = overrides.caseId || new mongoose.Types.ObjectId();
  return {
    operationKey: `case_payout:${caseId}`,
    caseId,
    kind: "case_payout",
    fingerprint: { paymentIntentId: "pi_123", amount: 82000 },
    amount: 82000,
    currency: "usd",
    ...overrides,
  };
}

describe("payment operation claims", () => {
  test("only one concurrent claimant acquires a new money operation", async () => {
    const args = input();
    const results = await Promise.all([
      claimPaymentOperation(args),
      claimPaymentOperation(args),
    ]);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => result.inProgress)).toHaveLength(1);
    expect(await PaymentOperation.countDocuments({ operationKey: args.operationKey })).toBe(1);
  });

  test("a succeeded operation is replayed without reacquiring it", async () => {
    const args = input();
    const first = await claimPaymentOperation(args);
    await succeedPaymentOperation(first.operation, "tr_123");

    const replay = await claimPaymentOperation(args);
    expect(replay.completed).toBe(true);
    expect(replay.operation.stripeObjectId).toBe("tr_123");
  });

  test("different financial details conflict and failed operations can retry", async () => {
    const args = input();
    const first = await claimPaymentOperation(args);

    const conflict = await claimPaymentOperation({
      ...args,
      fingerprint: { paymentIntentId: "pi_123", amount: 81000 },
      amount: 81000,
    });
    expect(conflict.conflict).toBe(true);

    await failPaymentOperation(first.operation, new Error("temporary Stripe error"));
    const retry = await claimPaymentOperation(args);
    expect(retry.acquired).toBe(true);
    expect(retry.retry).toBe(true);
    expect(retry.operation.attempts).toBe(2);
  });

  test("stale pending claims can be recovered", async () => {
    const args = input();
    const first = await claimPaymentOperation(args);
    await PaymentOperation.updateOne(
      { _id: first.operation._id },
      { $set: { lastAttemptAt: new Date(Date.now() - STALE_PENDING_MS - 1000) } }
    );

    const recovered = await claimPaymentOperation(args);
    expect(recovered.acquired).toBe(true);
    expect(recovered.retry).toBe(true);
  });
});
