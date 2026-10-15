const User = require("../models/User");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const {
  getAttorneyPaymentSummary,
  getParalegalEarnings,
} = require("../services/paymentProjectionService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

async function user(role, suffix) {
  return User.create({
    firstName: role === "attorney" ? "Avery" : "Parker",
    lastName: "Projection",
    email: `${role}.${suffix}@example.com`,
    password: "Password123!",
    role,
    status: "approved",
    state: "NY",
  });
}

describe("canonical dashboard payment projections", () => {
  test("attorney summaries do not turn unsupported Case funding and completion flags into recorded money", async () => {
    const attorney = await user("attorney", "summary");
    await Case.create([
      {
        title: "Active funded matter",
        details: "Active funded projection.",
        attorney: attorney._id,
        attorneyId: attorney._id,
        status: "in progress",
        totalAmount: 40000,
        lockedTotalAmount: 40000,
        escrowIntentId: "pi_active_projection",
        escrowStatus: "funded",
        paymentStatus: "succeeded",
        feeAttorneyPct: 22,
        feeAttorneyAmount: 8800,
      },
      {
        title: "Completed funded matter",
        details: "Completed funded projection.",
        attorney: attorney._id,
        attorneyId: attorney._id,
        status: "completed",
        totalAmount: 40000,
        lockedTotalAmount: 40000,
        paymentReleased: true,
        feeAttorneyPct: 22,
        feeAttorneyAmount: 8800,
      },
      {
        title: "Published but not funded",
        details: "Publishing must not create an active-funds projection.",
        attorney: attorney._id,
        attorneyId: attorney._id,
        status: "open",
        totalAmount: 40000,
        lockedTotalAmount: 40000,
        feeAttorneyPct: 22,
        feeAttorneyAmount: 8800,
      },
    ]);

    await expect(getAttorneyPaymentSummary(attorney._id)).resolves.toMatchObject({
      totalSpent: null,
      activeEscrow: null,
      activeFunds: null,
      pendingCharges: null,
      averageJobCost: null,
      completedJobsCount: 1,
      pendingJobsCount: 0,
      requiresReview: 2,
    });
  });

  test("earnings count retained paid evidence once and exclude estimates, failed and reversed records", async () => {
    const attorney = await user("attorney", "earnings");
    const paralegal = await user("paralegal", "earnings");
    const paidAt = new Date("2026-08-20T12:00:00.000Z");
    const [paidCase, failedCase, fallbackCase] = await Case.create([
      {
        title: "Paid payout",
        details: "Paid payout projection.",
        attorney: attorney._id,
        attorneyId: attorney._id,
        paralegal: paralegal._id,
        paralegalId: paralegal._id,
        status: "completed",
        paymentReleased: true,
        payoutTransferId: "tr_paid_projection",
        totalAmount: 40000,
        lockedTotalAmount: 40000,
      },
      {
        title: "Reversed payout",
        details: "Reversed payout projection.",
        attorney: attorney._id,
        attorneyId: attorney._id,
        paralegal: paralegal._id,
        paralegalId: paralegal._id,
        status: "completed",
        paymentReleased: false,
        totalAmount: 40000,
        lockedTotalAmount: 40000,
      },
      {
        title: "Withdrawal fallback",
        details: "Historical withdrawal projection.",
        attorney: attorney._id,
        attorneyId: attorney._id,
        withdrawnParalegalId: paralegal._id,
        status: "paused",
        pausedReason: "paralegal_withdrew",
        partialPayoutAmount: 20000,
        payoutFinalizedAt: paidAt,
        payoutFinalizedType: "partial_attorney",
        feeParalegalPct: 18,
        totalAmount: 40000,
        lockedTotalAmount: 40000,
      },
    ]);
    await Payout.create([
      {
        caseId: paidCase._id,
        paralegalId: paralegal._id,
        amountPaid: 32800,
        transferId: "tr_paid_projection",
        status: "paid", stripeMode: "test",
        createdAt: paidAt,
      },
      {
        caseId: failedCase._id,
        paralegalId: paralegal._id,
        amountPaid: 32800,
        transferId: "tr_reversed_projection",
        status: "reversed",
        createdAt: paidAt,
      },
    ]);

    const totals = await getParalegalEarnings(paralegal._id, {
      now: new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(totals).toEqual({ month: 328, last30: 328, total: 328 });

    await Payout.create({
      caseId: fallbackCase._id,
      paralegalId: paralegal._id,
      amountPaid: 16400,
      transferId: "tr_withdrawal_projection",
      status: "paid", stripeMode: "test",
      createdAt: paidAt,
    });
    const deduped = await getParalegalEarnings(paralegal._id, {
      now: new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(deduped).toEqual({ month: 492, last30: 492, total: 492 });
  });

  test("a replacement payout cannot prove the withdrawn paralegal was paid", async () => {
    const attorney = await user("attorney", "relist");
    const withdrawn = await user("paralegal", "withdrawn");
    const replacement = await user("paralegal", "replacement");
    const paidAt = new Date("2026-08-20T12:00:00.000Z");
    const caseDoc = await Case.create({
      title: "Relisted matter",
      details: "Separate historical payout owners.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: replacement._id,
      paralegalId: replacement._id,
      withdrawnParalegalId: withdrawn._id,
      status: "completed",
      paymentReleased: true,
      partialPayoutAmount: 20000,
      payoutFinalizedAt: paidAt,
      payoutFinalizedType: "partial_attorney",
      feeParalegalPct: 18,
      totalAmount: 40000,
      lockedTotalAmount: 40000,
    });
    await Payout.create({
      caseId: caseDoc._id,
      paralegalId: replacement._id,
      amountPaid: 16400,
      transferId: "tr_replacement_projection",
      status: "paid", stripeMode: "test",
      createdAt: paidAt,
    });

    await expect(getParalegalEarnings(withdrawn._id, {
      now: new Date("2026-08-30T12:00:00.000Z"),
    })).resolves.toEqual({ month: 0, last30: 0, total: 0 });
    await Payout.create({ caseId: caseDoc._id, paralegalId: withdrawn._id, amountPaid: 16400, transferId: "tr_original_withdrawal", status: "paid", stripeMode: "test", createdAt: paidAt });
    await expect(getParalegalEarnings(withdrawn._id, { now: new Date("2026-08-30T12:00:00.000Z") })).resolves.toEqual({ month: 164, last30: 164, total: 164 });
  });
});
