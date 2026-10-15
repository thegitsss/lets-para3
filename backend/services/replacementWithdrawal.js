const { Types } = require("mongoose");
const Case = require("../models/Case"), User = require("../models/User"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation");
const history = require("./attorneyReceiptHistory"), receipts = require("./paralegalPayoutReceipt");
const { amountFacts } = require("./attorneyWithdrawal");
const { chargebackHoldsPayout } = require("./payoutHoldService");
const { payoutSourceFields } = require("./attorneyFinancialHistory"), { fingerprint } = require("./matterDraftRevision");

const id = value => String(value?._id || value || "");
const fields = "attorney attorneyId paralegal paralegalId paralegalNameSnapshot status tasks taskRevision applicants invites preEngagement hiredAt archived readOnly paymentReleased payoutStatus payoutTransferId payoutFailureReason paidOutAt withdrawnParalegalId payoutFinalizedAt payoutFinalizedType partialPayoutAmount pausedAt pausedReason withdrawalHistory totalAmount lockedTotalAmount remainingAmount feeAttorneyPct feeAttorneyAmount feeParalegalPct feeParalegalAmount currency stripeMode paymentIntentId escrowIntentId escrowStatus fundingIntegrityStatus disputes disputeDeadlineAt __v".split(" ");
const source = doc => fields.map(key => doc[key]);
function fail() { throw Object.assign(new Error("The prior withdrawal records changed or require review before replacement hiring."), { status: 409, publicCode: "HIRING_WITHDRAWAL_REVIEW_REQUIRED" }); }
async function rows(Model, filter, names, session) {
  const values = await Model.collection.find(filter, { session, projection: Object.fromEntries(names.map(key => [key, 1])) }).sort({ _id: 1 }).limit(4001).toArray();
  if (values.length > 4000) fail();
  return values;
}

async function inspect(raw, session) {
  if (!raw) fail();
  const payeeId = id(raw.withdrawnParalegalId);
  if (!/^[a-f0-9]{24}$/i.test(payeeId) || !raw.payoutFinalizedAt || raw.paymentReleased
    || ["failed", "reversed", "needs_reconciliation"].includes(raw.payoutStatus)) fail();
  const amounts = amountFacts(raw);
  if (!amounts.balanceVerified || !amounts.currency || amounts.feePct === null || !(amounts.remaining > 0) || raw.remainingAmount !== amounts.remaining) fail();
  const entries = history.inventory(raw);
  const current = entries.find(entry => entry.record && id(entry.record.withdrawnParalegalId) === payeeId
    && String(entry.record.payoutFinalizedAt) === String(raw.payoutFinalizedAt));
  if (!current || current.conflict) fail();
  const caseRefs = [raw._id, id(raw._id)];
  // Keep transaction reads sequential and reuse the retained receipt's exact
  // amount, recipient, mode and global transfer-reference checks.
  const payouts = await rows(Payout, { caseId: { $in: caseRefs } }, payoutSourceFields.payoutFields, session);
  const operations = await rows(Operation, { caseId: { $in: caseRefs } }, payoutSourceFields.operationFields, session);
  if (operations.some(operation => ["partial_payout", "case_payout", "dispute_settlement"].includes(operation.kind)
    && (["pending", "needs_reconciliation"].includes(operation.status) || ["quarantined", "needs_reconciliation"].includes(operation.evidenceStatus)))) fail();
  if (operations.some(operation => operation.kind === "chargeback" && chargebackHoldsPayout(operation, raw))) fail();
  const transfers = payouts.map(row => row.transferId).filter(Boolean), keys = payouts.map(row => row.operationKey).filter(Boolean);
  const payoutReferences = await rows(Payout, { transferId: { $in: transfers } }, ["transferId"], session);
  const transferReferences = await rows(Operation, { $or: [{ stripeTransferId: { $in: transfers } }, { stripeObjectId: { $in: transfers } }, { operationKey: { $in: keys } }] }, ["caseId", "operationKey", "stripeTransferId", "stripeObjectId"], session);
  const person = await User.collection.findOne({ _id: new Types.ObjectId(payeeId) }, { session, projection: { firstName: 1, lastName: 1 } });
  try { receipts.projectReceipt({ snapshot: { cases: [raw], payouts, operations, payoutReferences, transferReferences }, person }, payeeId, current.id); }
  catch (error) { if (error.publicCode && error.status >= 400 && error.status < 500) fail(); throw error; }
  const financialFields = "paymentReleased payoutStatus payoutTransferId payoutFailureReason paidOutAt totalAmount lockedTotalAmount remainingAmount feeAttorneyPct feeAttorneyAmount feeParalegalPct feeParalegalAmount currency stripeMode paymentIntentId escrowIntentId escrowStatus fundingIntegrityStatus".split(" ");
  return { current, person, revision: fingerprint([entries, financialFields.map(key => raw[key]), payouts, operations, payoutReferences, transferReferences, person]) };
}
async function review(caseId) {
  return (await inspect(await Case.collection.findOne({ _id: new Types.ObjectId(id(caseId)) }))).revision;
}

// Preserve the exact persisted source captured in the claim transaction. Hydration
// can generate dates for older applications that have no saved appliedAt.
async function stage(doc, before, claimToken, { session, reviewedRevision }) {
  const raw = await Case.collection.findOne({ _id: doc._id }, { session });
  if (!raw || !before || raw.hiringClaimToken !== claimToken || raw.hiringClaimStatus !== "claimed"
    || fingerprint(source(raw)) !== fingerprint(source(before))) fail();
  const { current, person, revision } = await inspect(raw, session);
  if (reviewedRevision && revision !== reviewedRevision) fail();
  if (!current.historical) doc.withdrawalHistory.push({
    ...current.record, paralegalNameSnapshot: [person?.firstName, person?.lastName].filter(Boolean).join(" ") || raw.paralegalNameSnapshot || "",
    remainingAmount: raw.remainingAmount, feeParalegalPct: raw.feeParalegalPct, feeAttorneyPct: raw.feeAttorneyPct,
  });
  doc.withdrawnParalegalId = null;
  doc.payoutFinalizedAt = null;
  doc.payoutFinalizedType = null;
  doc.partialPayoutAmount = null;
  doc.payoutTransferId = "";
  doc.payoutStatus = "not_started";
  doc.payoutFailureReason = "";
  doc.paidOutAt = null;
  doc.disputeDeadlineAt = null;
}

module.exports = { review, stage };
