const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const PaymentOperation = require("../models/PaymentOperation");
const {
  buildFundingEvidenceReport,
  fundingOperationKey,
  inspectFundingCandidate,
  maskIdentifier,
  persistInspection,
} = require("../services/fundingEvidenceBackfillService");
const { APPLY_CONFIRMATION, assertApplyGuard } = require("../scripts/backfill-funding-evidence");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

function fixture({ livemode = false, refunded = false, disputed = false } = {}) {
  const caseId = new mongoose.Types.ObjectId();
  const caseDoc = {
    _id: caseId,
    paymentIntentId: "pi_funding_history_123",
    escrowIntentId: "pi_funding_history_123",
    lockedTotalAmount: 40000,
    totalAmount: 40000,
    feeAttorneyPct: 22,
    feeAttorneyAmount: 8800,
    currency: "usd",
    stripeMode: livemode ? "live" : "test",
  };
  const balanceTransaction = {
    id: "txn_funding_history_123",
    type: "charge",
    amount: 48800,
    fee: 1445,
    net: 47355,
    currency: "usd",
  };
  const charge = {
    id: "ch_funding_history_123",
    amount: 48800,
    amount_refunded: refunded ? 48800 : 0,
    currency: "usd",
    paid: true,
    captured: true,
    refunded,
    disputed,
    livemode,
    balance_transaction: balanceTransaction,
  };
  const paymentIntent = {
    id: "pi_funding_history_123",
    status: "succeeded",
    amount: 48800,
    amount_received: 48800,
    currency: "usd",
    livemode,
    metadata: { caseId: String(caseId) },
    transfer_group: `case_${caseId}`,
    latest_charge: charge,
  };
  const stripeClient = {
    paymentIntents: { retrieve: jest.fn(async () => paymentIntent) },
    charges: { retrieve: jest.fn(async () => charge) },
    balanceTransactions: { retrieve: jest.fn(async () => balanceTransaction) },
  };
  return { caseDoc, paymentIntent, charge, balanceTransaction, stripeClient };
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("historical funding evidence backfill", () => {
  test("does not auto-create Stripe-evidence indexes before production readiness review", () => {
    const indexedFields = PaymentOperation.schema.indexes().map(([fields]) => Object.keys(fields).join(","));
    expect(indexedFields).not.toContain("stripePaymentIntentId");
    expect(indexedFields).not.toContain("stripeChargeId");
    expect(indexedFields).not.toContain("stripeBalanceTransactionId");
    expect(indexedFields).not.toContain("stripeMode");
  });

  test("uses exact Stripe Balance Transaction values and distinguishes test mode", async () => {
    const { caseDoc, stripeClient } = fixture();
    const report = await buildFundingEvidenceReport({
      cases: [caseDoc],
      operations: [],
      payouts: [],
      stripeClient,
      now: new Date("2026-08-30T12:00:00.000Z"),
    });

    expect(report.counts).toEqual(expect.objectContaining({
      historicalFundingTransactions: 1,
      matched: 1,
      testMode: 1,
      liveMode: 0,
      expectedCreates: 1,
      reviewRequired: 0,
    }));
    expect(report.aggregates).toEqual(expect.objectContaining({
      grossCharges: 48800,
      processingFees: 1445,
      netCharges: 47355,
    }));
    expect(stripeClient.paymentIntents.retrieve).toHaveBeenCalledWith(
      "pi_funding_history_123",
      { expand: ["latest_charge.balance_transaction", "charges.data.balance_transaction"] }
    );
    expect(stripeClient.charges.retrieve).not.toHaveBeenCalled();
    expect(stripeClient.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/customer|payment_method|card/i);
  });

  test.each([
    [{ refunded: true }, "charge_refunded"],
    [{ disputed: true }, "charge_disputed"],
  ])("flags unsafe Stripe evidence for manual review", async (options, reason) => {
    const { caseDoc, stripeClient } = fixture(options);
    const inspection = await inspectFundingCandidate({ caseDoc, operations: [], stripeClient });
    expect(inspection.action).toBe("review");
    expect(inspection.reasons).toContain(reason);
  });

  test("creates once, then treats the same verified evidence as unchanged", async () => {
    const { caseDoc, stripeClient } = fixture();
    const first = await buildFundingEvidenceReport({
      cases: [caseDoc],
      operations: [],
      stripeClient,
      apply: true,
      PaymentOperation,
      now: new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(first.counts.appliedCreates).toBe(1);

    const stored = await PaymentOperation.find({ caseId: caseDoc._id }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(expect.objectContaining({
      operationKey: fundingOperationKey(caseDoc._id, caseDoc.paymentIntentId),
      kind: "funding",
      status: "succeeded",
      stripePaymentIntentId: "pi_funding_history_123",
      stripeChargeId: "ch_funding_history_123",
      stripeBalanceTransactionId: "txn_funding_history_123",
      grossAmount: 48800,
      processingFeeAmount: 1445,
      netAmount: 47355,
      stripeMode: "test",
      livemode: false,
    }));

    const second = await buildFundingEvidenceReport({
      cases: [caseDoc],
      operations: stored,
      stripeClient,
      apply: true,
      PaymentOperation,
    });
    expect(second.counts.unchangedVerified).toBe(1);
    expect(second.counts.appliedCreates).toBe(0);
    expect(second.counts.appliedUpdates).toBe(0);
    expect(await PaymentOperation.countDocuments({ caseId: caseDoc._id })).toBe(1);
  });

  test("does not overwrite conflicting existing evidence", async () => {
    const { caseDoc, stripeClient } = fixture();
    const operationKey = fundingOperationKey(caseDoc._id, caseDoc.paymentIntentId);
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      operationKey,
      caseId: caseDoc._id,
      kind: "funding",
      status: "succeeded",
      stripePaymentIntentId: caseDoc.paymentIntentId,
      stripeChargeId: "ch_funding_history_123",
      stripeBalanceTransactionId: "txn_funding_history_123",
      grossAmount: 48800,
      processingFeeAmount: 999,
      netAmount: 47801,
      currency: "usd",
      stripeMode: "test",
      livemode: false,
    };
    const inspection = await inspectFundingCandidate({ caseDoc, operations: [existing], stripeClient });
    expect(inspection.action).toBe("review");
    expect(inspection.reasons).toEqual(expect.arrayContaining([
      "existing_processingFeeAmount_conflict",
      "existing_netAmount_conflict",
    ]));
  });

  test("resolves a legacy Charge identifier to its PaymentIntent", async () => {
    const { caseDoc, paymentIntent, charge, stripeClient } = fixture();
    delete caseDoc.paymentIntentId;
    delete caseDoc.escrowIntentId;
    caseDoc.relatedChargeIds = [charge.id];
    charge.payment_intent = paymentIntent.id;

    const inspection = await inspectFundingCandidate({ caseDoc, operations: [], stripeClient });

    expect(inspection.action).toBe("create");
    expect(inspection.evidence.stripePaymentIntentId).toBe(paymentIntent.id);
    expect(stripeClient.charges.retrieve).toHaveBeenCalledWith(
      charge.id,
      { expand: ["balance_transaction"] }
    );
  });

  test("fills only absent evidence and preserves an existing verification timestamp", async () => {
    const evidenceVerifiedAt = new Date("2026-08-01T00:00:00.000Z");
    const PaymentOperationModel = { findOneAndUpdate: jest.fn(async () => ({})) };
    await persistInspection({
      action: "update",
      operationId: new mongoose.Types.ObjectId(),
      operationKey: "funding:case:pi",
      missing: { processingFeeAmount: 1445 },
      evidenceVerifiedAtMissing: false,
    }, PaymentOperationModel, new Date("2026-08-30T00:00:00.000Z"));

    const update = PaymentOperationModel.findOneAndUpdate.mock.calls[0][1];
    expect(update).toEqual({ $set: { processingFeeAmount: 1445 } });
    expect(update.$set.evidenceVerifiedAt).not.toBe(evidenceVerifiedAt);
    expect(update.$set.evidenceVerifiedAt).toBeUndefined();
  });

  test("masks identifiers and requires an exact apply confirmation and record count", () => {
    expect(maskIdentifier("pi_sensitive_123456789")).not.toContain("123456789");
    expect(() => assertApplyGuard(2, { apply: true, args: ["--apply"] })).toThrow(/--confirm/i);
    expect(() => assertApplyGuard(2, {
      apply: true,
      args: ["--apply", `--confirm=${APPLY_CONFIRMATION}`, "--expected-records=1"],
    })).toThrow(/expected 2 changes/i);
    expect(() => assertApplyGuard(2, {
      apply: true,
      args: ["--apply", `--confirm=${APPLY_CONFIRMATION}`, "--expected-records=2"],
    })).not.toThrow();
  });

  test("the backfill has no Stripe mutation capability", () => {
    const source = [
      fs.readFileSync(path.join(__dirname, "../scripts/backfill-funding-evidence.js"), "utf8"),
      fs.readFileSync(path.join(__dirname, "../services/fundingEvidenceBackfillService.js"), "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/stripe(?:Client)?\.(?:paymentIntents|charges|refunds|transfers|payouts|customers|paymentMethods)\.(?:create|update|cancel|confirm|capture|attach|detach)\s*\(/);
  });
});
