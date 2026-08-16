const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");

function same(value, expected) {
  return String(value ?? "") === String(expected ?? "");
}

async function upsertPayoutLedger(
  { operationKey, caseId, paralegalId, amountPaid, transferId, stripeMode },
  { session } = {}
) {
  if (!operationKey || !caseId || !paralegalId || !transferId) {
    throw new Error("Complete payout ledger evidence is required.");
  }
  const query = Payout.findOne({ $or: [{ operationKey }, { transferId }] });
  if (session) query.session(session);
  const existing = await query;
  if (existing) {
    if (
      !same(existing.caseId, caseId) ||
      !same(existing.paralegalId, paralegalId) ||
      Number(existing.amountPaid) !== Number(amountPaid) ||
      !same(existing.transferId, transferId)
    ) {
      throw new Error("Payout ledger evidence conflicts with the payment operation.");
    }
    existing.operationKey = operationKey;
    existing.status = "paid";
    existing.failureReason = "";
    return existing.save(session ? { session } : undefined);
  }
  const [created] = await Payout.create(
    [{ operationKey, caseId, paralegalId, amountPaid, transferId, stripeMode, status: "paid" }],
    session ? { session } : undefined
  );
  return created;
}

async function upsertPlatformIncomeLedger(
  { operationKey, caseId, attorneyId, paralegalId, feeAmount, stripeMode },
  { session } = {}
) {
  if (!operationKey || !caseId || !attorneyId || !paralegalId) {
    throw new Error("Complete platform-income ledger evidence is required.");
  }
  const query = PlatformIncome.findOne({
    $or: [
      { operationKey },
      {
        caseId,
        attorneyId,
        paralegalId,
        feeAmount,
        $or: [{ operationKey: { $exists: false } }, { operationKey: null }, { operationKey: "" }],
      },
    ],
  });
  if (session) query.session(session);
  const existing = await query;
  if (existing) {
    if (
      !same(existing.caseId, caseId) ||
      !same(existing.attorneyId, attorneyId) ||
      !same(existing.paralegalId, paralegalId) ||
      Number(existing.feeAmount) !== Number(feeAmount)
    ) {
      throw new Error("Platform-income ledger evidence conflicts with the payment operation.");
    }
    if (!existing.operationKey) {
      existing.operationKey = operationKey;
      return existing.save(session ? { session } : undefined);
    }
    return existing;
  }
  const [created] = await PlatformIncome.create(
    [{ operationKey, caseId, attorneyId, paralegalId, feeAmount, stripeMode }],
    session ? { session } : undefined
  );
  return created;
}

module.exports = { upsertPayoutLedger, upsertPlatformIncomeLedger };
