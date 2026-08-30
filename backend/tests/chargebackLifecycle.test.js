const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const User = require("../models/User");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const PaymentOperation = require("../models/PaymentOperation");
const FinancialAdjustment = require("../models/FinancialAdjustment");
const {
  acknowledgeChargeback,
  clearEligiblePayoutHold,
  recordChargebackEvent,
  shouldAcceptProcessorState,
} = require("../services/chargebackService");
const { createPayoutTransfer, getPayoutHold } = require("../services/payoutHoldService");
const { getParalegalEarnings } = require("../services/paymentProjectionService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

async function createMatter({ paid = false, archived = false } = {}) {
  const [attorney, paralegal] = await User.create([
    {
      firstName: "Chargeback",
      lastName: "Attorney",
      email: `chargeback-attorney-${new mongoose.Types.ObjectId()}@example.com`,
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    },
    {
      firstName: "Chargeback",
      lastName: "Paralegal",
      email: `chargeback-paralegal-${new mongoose.Types.ObjectId()}@example.com`,
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    },
  ]);
  const paymentIntentId = `pi_${new mongoose.Types.ObjectId()}`;
  const caseDoc = await Case.create({
    title: "Chargeback evidence matter",
    details: "A funded test matter for deterministic chargeback characterization.",
    status: paid ? "completed" : "in progress",
    archived,
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal._id,
    paralegalId: paralegal._id,
    paymentIntentId,
    escrowIntentId: paymentIntentId,
    escrowStatus: "funded",
    paymentStatus: "succeeded",
    paymentReleased: paid,
    payoutTransferId: paid ? `tr_${new mongoose.Types.ObjectId()}` : "",
    lockedTotalAmount: 40000,
    totalAmount: 40000,
    currency: "usd",
  });
  let payout = null;
  let income = null;
  if (paid) {
    payout = await Payout.create({
      paralegalId: paralegal._id,
      caseId: caseDoc._id,
      operationKey: `case_payout:${caseDoc._id}`,
      amountPaid: 32800,
      transferId: caseDoc.payoutTransferId,
      stripeMode: "test",
      status: "paid",
    });
    income = await PlatformIncome.create({
      caseId: caseDoc._id,
      operationKey: `case_payout:${caseDoc._id}`,
      attorneyId: attorney._id,
      paralegalId: paralegal._id,
      feeAmount: 16000,
      stripeMode: "test",
    });
  }
  return { attorney, paralegal, caseDoc, payout, income, paymentIntentId };
}

function stripeFixture({ caseDoc, paymentIntentId, livemode = false, refunded = 0 } = {}) {
  const charge = {
    id: `ch_${new mongoose.Types.ObjectId()}`,
    amount: 48800,
    amount_refunded: refunded,
    currency: "usd",
    livemode,
    metadata: { caseId: String(caseDoc?._id || "") },
    payment_intent: {
      id: paymentIntentId,
      metadata: { caseId: String(caseDoc?._id || "") },
    },
  };
  const stripeClient = {
    charges: { retrieve: jest.fn(async () => charge) },
    paymentIntents: { retrieve: jest.fn(async () => charge.payment_intent) },
    balanceTransactions: { retrieve: jest.fn(async (id) => ({ id })) },
    transfers: { create: jest.fn(async () => ({ id: "tr_should_not_run" })) },
  };
  return { charge, stripeClient };
}

function disputeEvent({
  caseDoc,
  charge,
  id = `dp_${new mongoose.Types.ObjectId()}`,
  eventId = `evt_${new mongoose.Types.ObjectId()}`,
  status = "under_review",
  created = 1_800_000_000,
  livemode = false,
  balanceTransactions,
  amount = 48800,
} = {}) {
  const dispute = {
    id,
    object: "dispute",
    amount,
    currency: "usd",
    status,
    livemode,
    charge,
    metadata: { caseId: String(caseDoc?._id || "") },
    balance_transactions: balanceTransactions || [{
      id: `txn_${id}_debit`,
      amount: -amount,
      fee: 1500,
      net: -(amount + 1500),
      currency: "usd",
      created,
    }],
  };
  return {
    id: eventId,
    type: status === "won" || status === "lost" ? "charge.dispute.closed" : "charge.dispute.updated",
    created,
    livemode,
    data: { object: dispute },
  };
}

beforeAll(async () => {
  await connect();
  await FinancialAdjustment.init();
});
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("Phase 4B chargeback lifecycle", () => {
  test("pre-payout chargeback creates one canonical operation, debit evidence, and payout hold", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    const event = disputeEvent({ caseDoc: matter.caseDoc, charge });

    const first = await recordChargebackEvent({ event, stripeClient });
    const replay = await recordChargebackEvent({
      event: { ...event, id: "evt_same_dispute_reconciliation" },
      stripeClient,
    });

    expect(first.operation).toEqual(expect.objectContaining({
      operationKey: `chargeback:${event.data.object.id}`,
      kind: "chargeback",
      caseId: matter.caseDoc._id,
      payoutPosition: "pre_payout",
      administrativeStatus: "pending_review",
      processorStatus: "under_review",
      evidenceStatus: "verified",
      stripeMode: "test",
    }));
    expect(first.adjustments.map(({ adjustment }) => [adjustment.adjustmentType, adjustment.direction, adjustment.amount]))
      .toEqual(expect.arrayContaining([
        ["chargeback_principal", "debit", 48800],
        ["processor_dispute_fee", "debit", 1500],
      ]));
    expect(replay.adjustments.every((entry) => entry.created === false)).toBe(true);
    expect(await PaymentOperation.countDocuments({ kind: "chargeback" })).toBe(1);
    expect(await FinancialAdjustment.countDocuments()).toBe(2);
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(true);
    const unchanged = await Case.findById(matter.caseDoc._id).lean();
    expect(unchanged.status).toBe("in progress");
    expect(unchanged.paymentReleased).toBe(false);
  });

  test("delayed processor events cannot regress a terminal win and do not clear the hold", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    const disputeId = "dp_terminal_order";
    const won = disputeEvent({ caseDoc: matter.caseDoc, charge, id: disputeId, status: "won", created: 500 });
    await recordChargebackEvent({ event: won, stripeClient });
    const delayed = disputeEvent({
      caseDoc: matter.caseDoc,
      charge,
      id: disputeId,
      status: "needs_response",
      created: 400,
      eventId: "evt_delayed_chargeback",
    });
    const result = await recordChargebackEvent({ event: delayed, stripeClient });

    expect(result.operation.processorStatus).toBe("won");
    expect(result.processorStateAccepted).toBe(false);
    expect(result.operation.administrativeStatus).toBe("pending_review");
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(true);
  });

  test("lost pre-payout chargeback remains frozen after admin acknowledgment", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    const event = disputeEvent({ caseDoc: matter.caseDoc, charge, status: "lost" });
    const result = await recordChargebackEvent({ event, stripeClient });
    const acknowledgment = await acknowledgeChargeback(result.operation._id, matter.attorney._id);

    expect(acknowledgment.operation.administrativeStatus).toBe("acknowledged");
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(true);
    await expect(clearEligiblePayoutHold(result.operation._id, matter.attorney._id))
      .rejects.toMatchObject({ code: "CHARGEBACK_HOLD_NOT_ELIGIBLE" });
  });

  test("won pre-payout chargeback requires explicit idempotent admin hold clearance", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    const result = await recordChargebackEvent({
      event: disputeEvent({ caseDoc: matter.caseDoc, charge, status: "won" }),
      stripeClient,
    });
    const first = await clearEligiblePayoutHold(result.operation._id, matter.attorney._id);
    const second = await clearEligiblePayoutHold(result.operation._id, matter.attorney._id);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.operation.administrativeStatus).toBe("hold_cleared");
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(false);
  });

  test("a payout after explicit hold clearance permanently classifies later events as post-payout", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    const disputeId = "dp_cleared_then_paid";
    const first = await recordChargebackEvent({
      event: disputeEvent({ caseDoc: matter.caseDoc, charge, id: disputeId, status: "won", created: 500 }),
      stripeClient,
    });
    await clearEligiblePayoutHold(first.operation._id, matter.attorney._id);
    const transfer = await createPayoutTransfer({
      caseId: matter.caseDoc._id,
      stripeClient,
      payload: { amount: 32800 },
      stripeOptions: { idempotencyKey: "cleared-then-paid" },
    });
    expect(transfer.id).toBe("tr_should_not_run");
    expect((await PaymentOperation.findById(first.operation._id).lean()).payoutPosition).toBe("post_payout");

    matter.caseDoc.paymentReleased = true;
    matter.caseDoc.payoutTransferId = transfer.id;
    await matter.caseDoc.save();
    const later = await recordChargebackEvent({
      event: disputeEvent({
        caseDoc: matter.caseDoc,
        charge,
        id: disputeId,
        status: "won",
        created: 600,
        eventId: "evt_cleared_then_paid_later",
      }),
      stripeClient,
    });
    expect(later.operation.payoutPosition).toBe("post_payout");
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(false);
  });

  test("post-payout chargeback preserves payout, completed matter, archive, and PlatformIncome", async () => {
    const matter = await createMatter({ paid: true, archived: true });
    const originalIncome = matter.income.toObject();
    const { charge, stripeClient } = stripeFixture(matter);
    const result = await recordChargebackEvent({
      event: disputeEvent({ caseDoc: matter.caseDoc, charge }),
      stripeClient,
    });

    expect(result.operation.payoutPosition).toBe("post_payout");
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(false);
    expect(await Payout.findById(matter.payout._id).lean()).toEqual(expect.objectContaining({
      amountPaid: 32800,
      status: "paid",
    }));
    expect(await PlatformIncome.findById(matter.income._id).lean()).toEqual(expect.objectContaining({
      feeAmount: originalIncome.feeAmount,
      operationKey: originalIncome.operationKey,
    }));
    expect(await Case.findById(matter.caseDoc._id).lean()).toEqual(expect.objectContaining({
      status: "completed",
      archived: true,
      paymentReleased: true,
    }));
    expect(await getParalegalEarnings(matter.paralegal._id)).toEqual(expect.objectContaining({ total: 328 }));
  });

  test("subsequent actual recovery appends credits without editing the original debits", async () => {
    const matter = await createMatter({ paid: true, archived: true });
    const { charge, stripeClient } = stripeFixture(matter);
    const disputeId = "dp_recovery_append_only";
    const debitEvent = disputeEvent({ caseDoc: matter.caseDoc, charge, id: disputeId, status: "under_review", created: 500 });
    await recordChargebackEvent({ event: debitEvent, stripeClient });
    const originalDebits = await FinancialAdjustment.find({ direction: "debit" }).sort({ createdAt: 1 }).lean();
    const recoveryEvent = disputeEvent({
      caseDoc: matter.caseDoc,
      charge,
      id: disputeId,
      status: "won",
      created: 600,
      eventId: "evt_recovery_append_only",
      balanceTransactions: [{
        id: "txn_recovery_append_only",
        amount: 48800,
        fee: -1500,
        net: 50300,
        currency: "usd",
        created: 600,
      }],
    });
    await recordChargebackEvent({ event: recoveryEvent, stripeClient });

    const credits = await FinancialAdjustment.find({ direction: "credit" }).lean();
    expect(credits.map((entry) => [entry.adjustmentType, entry.amount])).toEqual(expect.arrayContaining([
      ["chargeback_recovery", 48800],
      ["processor_fee_recovery", 1500],
    ]));
    const preservedDebits = await FinancialAdjustment.find({ direction: "debit" }).sort({ createdAt: 1 }).lean();
    expect(preservedDebits.map((entry) => entry.idempotencyKey)).toEqual(originalDebits.map((entry) => entry.idempotencyKey));
  });

  test("partial chargebacks use actual disputed and balance-transaction cents", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    const event = disputeEvent({
      caseDoc: matter.caseDoc,
      charge,
      amount: 12000,
      balanceTransactions: [{
        id: "txn_partial_chargeback",
        amount: -12000,
        fee: 1500,
        net: -13500,
        currency: "usd",
      }],
    });
    const result = await recordChargebackEvent({ event, stripeClient });
    expect(result.operation.amount).toBe(12000);
    expect(result.adjustments.map((entry) => entry.adjustment.amount)).toEqual(expect.arrayContaining([12000, 1500]));
  });

  test("refund overlap is quarantined and cannot create duplicate loss evidence", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture({ ...matter, refunded: 1000 });
    const result = await recordChargebackEvent({
      event: disputeEvent({ caseDoc: matter.caseDoc, charge }),
      stripeClient,
    });
    expect(result.operation.evidenceStatus).toBe("quarantined");
    expect(result.reasons).toContain("refund_chargeback_overlap");
    expect(await FinancialAdjustment.countDocuments()).toBe(0);
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(true);
  });

  test("unmatched disputes are quarantined without matching a Case by amount", async () => {
    const paymentIntentId = "pi_unmatched_chargeback";
    const { charge, stripeClient } = stripeFixture({ paymentIntentId });
    charge.metadata = {};
    charge.payment_intent.metadata = {};
    const event = disputeEvent({ charge, caseDoc: null });
    event.data.object.metadata = {};
    const result = await recordChargebackEvent({ event, stripeClient });
    expect(result.operation.caseId).toBeFalsy();
    expect(result.operation.evidenceStatus).toBe("quarantined");
    expect(result.reasons).toContain("case_unmatched");
    expect(await FinancialAdjustment.countDocuments()).toBe(0);
  });

  test("ambiguous PaymentIntent-to-Case evidence is quarantined", async () => {
    const first = await createMatter();
    const second = await createMatter();
    second.caseDoc.paymentIntentId = first.paymentIntentId;
    second.caseDoc.escrowIntentId = first.paymentIntentId;
    await second.caseDoc.save();
    const { charge, stripeClient } = stripeFixture(first);
    charge.metadata = {};
    charge.payment_intent.metadata = {};
    const event = disputeEvent({ caseDoc: null, charge });
    event.data.object.metadata = {};

    const result = await recordChargebackEvent({ event, stripeClient });

    expect(result.operation.caseId).toBeFalsy();
    expect(result.operation.evidenceStatus).toBe("quarantined");
    expect(result.reasons).toContain("case_ambiguous");
  });

  test("existing transfer evidence classifies a chargeback as post-payout during local reconciliation", async () => {
    const matter = await createMatter();
    await PaymentOperation.create({
      operationKey: `case_payout:${matter.caseDoc._id}`,
      caseId: matter.caseDoc._id,
      kind: "case_payout",
      fingerprint: "existing-transfer-evidence",
      status: "needs_reconciliation",
      amount: 32800,
      currency: "usd",
      stripeObjectId: "tr_existing_reconciliation",
      stripeTransferId: "tr_existing_reconciliation",
    });
    const { charge, stripeClient } = stripeFixture(matter);
    const result = await recordChargebackEvent({
      event: disputeEvent({ caseDoc: matter.caseDoc, charge }),
      stripeClient,
    });
    expect(result.operation.payoutPosition).toBe("post_payout");
    expect((await getPayoutHold(matter.caseDoc._id)).held).toBe(false);
  });

  test("test-mode and live-mode adjustment evidence remain separated", async () => {
    const testMatter = await createMatter();
    const liveMatter = await createMatter();
    const testStripe = stripeFixture(testMatter);
    const liveStripe = stripeFixture({ ...liveMatter, livemode: true });
    await recordChargebackEvent({
      event: disputeEvent({ caseDoc: testMatter.caseDoc, charge: testStripe.charge, id: "dp_mode_test" }),
      stripeClient: testStripe.stripeClient,
    });
    await recordChargebackEvent({
      event: disputeEvent({
        caseDoc: liveMatter.caseDoc,
        charge: liveStripe.charge,
        id: "dp_mode_live",
        livemode: true,
      }),
      stripeClient: liveStripe.stripeClient,
    });
    expect(await FinancialAdjustment.countDocuments({ stripeMode: "test" })).toBe(2);
    expect(await FinancialAdjustment.countDocuments({ stripeMode: "live" })).toBe(2);
  });

  test("all production payout entry points use the same hold-aware transfer authority", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    await recordChargebackEvent({ event: disputeEvent({ caseDoc: matter.caseDoc, charge }), stripeClient });
    await expect(createPayoutTransfer({
      caseId: matter.caseDoc._id,
      stripeClient,
      payload: { amount: 32800 },
      stripeOptions: { idempotencyKey: "held" },
    })).rejects.toMatchObject({ code: "PAYOUT_HELD_FOR_CHARGEBACK" });
    expect(stripeClient.transfers.create).not.toHaveBeenCalled();

    const routeSources = ["cases.js", "payments.js"].map((file) =>
      fs.readFileSync(path.join(__dirname, "../routes", file), "utf8")
    ).join("\n");
    expect(routeSources).not.toMatch(/stripe\.transfers\.create\s*\(/);
    expect((routeSources.match(/createPayoutTransfer\s*\(\{/g) || [])).toHaveLength(4);
  });

  test("financial adjustments are immutable and only index the new empty collection", async () => {
    const matter = await createMatter();
    const { charge, stripeClient } = stripeFixture(matter);
    await recordChargebackEvent({ event: disputeEvent({ caseDoc: matter.caseDoc, charge }), stripeClient });
    const adjustment = await FinancialAdjustment.findOne();
    await expect(FinancialAdjustment.findByIdAndUpdate(adjustment._id, { $set: { amount: 1 } }))
      .rejects.toThrow(/immutable/i);
    adjustment.amount = 1;
    await expect(adjustment.save()).rejects.toThrow(/immutable/i);
    expect(PaymentOperation.schema.indexes().map(([fields]) => Object.keys(fields).join(",")))
      .not.toContain("stripeDisputeId");
    expect(FinancialAdjustment.schema.indexes()).toEqual(expect.arrayContaining([
      [{ idempotencyKey: 1 }, { unique: true }],
    ]));
  });

  test("legacy PaymentOperation records without Phase 4B evidence fields load safely", async () => {
    const matter = await createMatter();
    await mongoose.connection.db.collection("paymentoperations").insertOne({
      operationKey: `refund:${matter.caseDoc._id}:legacy`,
      caseId: matter.caseDoc._id,
      kind: "refund",
      fingerprint: "legacy-operation",
      status: "succeeded",
      amount: 1000,
      currency: "usd",
      stripeObjectId: "re_legacy",
      refundAmount: 1000,
      attempts: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const loaded = await PaymentOperation.findOne({ operationKey: `refund:${matter.caseDoc._id}:legacy` });
    expect(loaded).toBeTruthy();
    expect(loaded.processingFeeAmount).toBeUndefined();
    expect(loaded.processorStatus).toBeNull();
    expect(loaded.administrativeStatus).toBeNull();
  });

  test("conflicting terminal processor states never replace the first terminal outcome", () => {
    expect(shouldAcceptProcessorState(
      "won",
      new Date("2026-08-30T12:00:00.000Z"),
      "lost",
      new Date("2026-08-30T13:00:00.000Z")
    )).toBe(false);
    expect(shouldAcceptProcessorState(
      "lost",
      new Date("2026-08-30T12:00:00.000Z"),
      "under_review",
      new Date("2026-08-30T13:00:00.000Z")
    )).toBe(false);
  });
});
