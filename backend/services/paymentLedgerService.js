const { reportOperationalFailure } = require("../utils/operationalFailure");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const PaymentOperation = require("../models/PaymentOperation");
const Case = require("../models/Case");
const mongoose = require("mongoose");
const { TRANSFER_OPERATION_KINDS } = require("./paymentOperationService");

function same(value, expected) {
  return String(value ?? "") === String(expected ?? "");
}

async function withPayoutTransaction(work) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.paymentLedgerService.transaction_abort"));
    if (error.code === 112 || error.hasErrorLabel?.("TransientTransactionError")) throw new Error("Payout ledger evidence changed before it could be confirmed.");
    throw error;
  } finally { await session.endSession(); }
}

async function upsertPayoutLedger(
  { operationKey, caseId, paralegalId, amountPaid, transferId, stripeMode },
  { session } = {}
) {
  if (!operationKey || !caseId || !paralegalId || !transferId) {
    throw new Error("Complete payout ledger evidence is required.");
  }
  if (!session) {
    return withPayoutTransaction(ownedSession => upsertPayoutLedger({ operationKey, caseId, paralegalId, amountPaid, transferId, stripeMode }, { session: ownedSession }));
  }
  const operation = await PaymentOperation.findOne({ operationKey }).session(session).lean();
  if (operation) {
    if (!TRANSFER_OPERATION_KINDS.includes(operation.kind) || !same(operation.caseId, caseId) || operation.evidenceStatus === "quarantined" || operation.evidenceStatus === "needs_reconciliation" && !operation.stripeTransferId || ![operation.stripeTransferId, operation.stripeObjectId].includes(transferId)) throw new Error("The payout transfer requires payment review before its ledger can be completed.");
    const matter = await Case.findById(caseId).session(session).lean();
    if (matter && (!matter.payoutTransferId || matter.payoutTransferId === transferId) && ["failed", "reversed"].includes(matter.payoutStatus)) throw new Error("The Matter records a payout failure or reversal that requires payment review.");
    // A real write to this operation serializes payout creation with a transfer
    // reversal, even when no payout row existed when the callback arrived.
    const touchedAt = new Date(Math.max(Date.now(), (new Date(operation.updatedAt).getTime() || 0) + 1));
    const guard = await PaymentOperation.collection.updateOne(
      { _id: operation._id, evidenceStatus: { $ne: "quarantined" } }, { $set: { updatedAt: touchedAt } }, { session }
    );
    if (!guard.matchedCount) throw new Error("The payout operation changed before its ledger could be confirmed.");
  }
  const query = Payout.findOne({ $or: [{ operationKey }, { transferId }] });
  if (session) query.session(session);
  const existing = await query.lean();
  if (existing) {
    if (
      !same(existing.caseId, caseId) ||
      !same(existing.paralegalId, paralegalId) ||
      Number(existing.amountPaid) !== Number(amountPaid) ||
      !same(existing.transferId, transferId) ||
      existing.operationKey && existing.operationKey !== operationKey ||
      existing.status !== "paid" ||
      existing.reversedAt != null
    ) {
      throw new Error("Payout ledger evidence conflicts with the payment operation.");
    }
    // An idempotent ledger write may attach its operation key, but cannot
    // promote pending/failed evidence or erase a concurrent reversal.
    const result = await Payout.findOneAndUpdate(
      { _id: existing._id, caseId: existing.caseId, paralegalId: existing.paralegalId, amountPaid: existing.amountPaid, transferId: existing.transferId, status: "paid", reversedAt: null, operationKey: existing.operationKey === undefined ? { $exists: false } : existing.operationKey },
      { $set: { operationKey } },
      { returnDocument: "after", ...(session ? { session } : {}) }
    );
    if (!result) throw new Error("Payout ledger evidence changed before it could be confirmed.");
    return result;
  }
  if (!operation) throw new Error("The payout ledger requires its retained payment operation.");
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

module.exports = { upsertPayoutLedger, upsertPlatformIncomeLedger, withPayoutTransaction };
