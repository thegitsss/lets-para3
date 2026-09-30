const { Types } = require("mongoose");
const Payout = require("../models/Payout"), PaymentOperation = require("../models/PaymentOperation");
const retainedPayoutMode = require("./retainedPayoutMode");
const { DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT: PLATFORM_FEE_PARALEGAL_PERCENT } = require("./platformFeePolicy");

const id = value => String(value?._id || value || ""), valid = value => /^[a-f0-9]{24}$/i.test(id(value));
const refs = value => [new Types.ObjectId(id(value)), id(value)];
const money = value => Number.isSafeInteger(value) && value >= 0;
const transfer = value => typeof value === "string" && /^(?:tr_|bypass_)[A-Za-z0-9_]{1,200}$/.test(value);
const date = value => value != null && Number.isFinite(new Date(value).getTime());
function amountFor(doc) {
  const budget = doc.remainingAmount ?? doc.lockedTotalAmount ?? doc.totalAmount;
  const percent = doc.feeParalegalPct ?? PLATFORM_FEE_PARALEGAL_PERCENT;
  if (!money(budget) || budget <= 0 || !Number.isFinite(percent) || percent < 0 || percent >= 100) return null;
  const amount = budget - Math.round(budget * percent / 100);
  return money(amount) && amount > 0 ? amount : null;
}
function reconciliationError() {
  return Object.assign(new Error("Payout records require administrative reconciliation before this Matter can be completed."), { code: "PAYOUT_RECONCILIATION_REQUIRED", statusCode: 409 });
}

// Read persisted evidence as stored. Hydration must not turn an earlier record
// with no status into a paid record through today's schema default.
async function inspect(doc, { session } = {}) {
  const caseId = id(doc._id), paralegalId = id(doc.paralegal || doc.paralegalId), attorneyId = id(doc.attorney || doc.attorneyId);
  const invalid = () => ({ state: "needs_review", payout: null, operation: null });
  if (!valid(caseId) || !valid(paralegalId) || !valid(attorneyId) || doc.paralegal && doc.paralegalId && id(doc.paralegal) !== id(doc.paralegalId) || doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)) return invalid();
  const key = `case_payout:${caseId}`;
  const operation = await PaymentOperation.collection.findOne({ operationKey: key }, { session });
  const knownTransfers = [...new Set([doc.payoutTransferId, operation?.stripeTransferId, operation?.stripeObjectId].filter(Boolean))];
  const rows = await Payout.collection.find({ $or: [
    { operationKey: key },
    ...(knownTransfers.length ? [{ transferId: { $in: knownTransfers } }] : []),
    { caseId: { $in: refs(caseId) }, paralegalId: { $in: refs(paralegalId) }, $or: [{ operationKey: { $exists: false } }, { operationKey: null }, { operationKey: "" }] },
  ] }, { session }).limit(3).toArray();
  const result = (state, payout = null) => ({ state, payout, operation });
  const amount = amountFor(doc), currency = typeof doc.currency === "string" ? doc.currency.toLowerCase() : "usd";
  if (amount === null || !/^[a-z]{3}$/.test(currency) || knownTransfers.length > 1 || knownTransfers.some(value => !transfer(value)) || ["reversed", "needs_reconciliation"].includes(doc.payoutStatus)) return result("needs_review");
  if (operation && (id(operation.caseId) !== caseId || operation.kind !== "case_payout" || operation.amount !== amount || operation.currency !== currency || ["quarantined", "needs_reconciliation"].includes(operation.evidenceStatus) || !["pending", "succeeded", "failed", "needs_reconciliation"].includes(operation.status))) return result("needs_review");
  if (!rows.length) {
    // An identifier proves that a transfer may exist. It does not establish its
    // current status, amount or recipient, and cannot authorize a ledger repair.
    return result(knownTransfers.length || doc.paymentReleased || ["succeeded", "needs_reconciliation"].includes(operation?.status) ? "needs_review" : "none");
  }
  if (rows.length !== 1) return result("needs_review");
  const payout = rows[0];
  // The existing explicit development bypass remains a simulated completion;
  // financial reporting excludes bypass identifiers from recorded money.
  if (/^tr_/.test(payout.transferId || "") && !retainedPayoutMode.inspect(doc, payout, operation)) return result("needs_review");
  if (id(payout.caseId) !== caseId || id(payout.paralegalId) !== paralegalId || payout.operationKey && payout.operationKey !== key || payout.status !== "paid" || payout.reversedAt != null || !transfer(payout.transferId) || payout.amountPaid !== amount || !date(payout.createdAt) || knownTransfers.length && knownTransfers[0] !== payout.transferId || ["failed", "reversed"].includes(doc.payoutStatus)) return result("needs_review");
  if (operation && (operation.status !== "succeeded" || !knownTransfers.length || knownTransfers[0] !== payout.transferId || operation.transferAmount != null && operation.transferAmount !== 0 && operation.transferAmount !== amount)) return result("needs_review");
  const [payoutReferences, transferReferences] = await Promise.all([
    Payout.collection.find({ transferId: payout.transferId }, { session, projection: { _id: 1 } }).limit(2).toArray(),
    PaymentOperation.collection.find({ $or: [{ operationKey: key }, { stripeTransferId: payout.transferId }, { stripeObjectId: payout.transferId }] }, { session, projection: { _id: 1 } }).limit(2).toArray(),
  ]);
  if (payoutReferences.length !== 1 || id(payoutReferences[0]) !== id(payout) || transferReferences.length !== (operation ? 1 : 0) || operation && id(transferReferences[0]) !== id(operation)) return result("needs_review");
  return result("recorded", payout);
}
async function requireRecorded(doc, options) {
  const evidence = await inspect(doc, options);
  if (evidence.state !== "recorded") throw reconciliationError();
  return evidence;
}
module.exports = { inspect, requireRecorded, amountFor, reconciliationError };
