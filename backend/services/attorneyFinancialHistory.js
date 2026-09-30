const { Types } = require("mongoose"), Case = require("../models/Case"), User = require("../models/User"), PaymentOperation = require("../models/PaymentOperation"), Payout = require("../models/Payout");
const retainedPayoutMode = require("./retainedPayoutMode");
const account = require("./attorneyAccountBoundary"), receiptHistory = require("./attorneyReceiptHistory"), { fingerprint } = require("./matterDraftRevision"), { expectedCaseFunding } = require("../utils/paymentIntegrity"), completion = require("./completionPayoutEvidence");
const cap = 10000, id = value => String(value?._id || value || ""), validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value), hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const refs = value => [new Types.ObjectId(value), value], money = value => Number.isSafeInteger(value) && value >= 0, date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const externalId = (value, prefix) => typeof value === "string" && new RegExp(`^(?:${prefix})_[A-Za-z0-9_]{1,200}$`).test(value);
const fail = (status, suffix) => { throw Object.assign(new Error("Financial records could not be verified. Refresh the payment history before continuing."), { status, publicCode: `FINANCIAL_HISTORY_${suffix}` }); };
const caseFields = "attorney attorneyId paralegal paralegalId title status archived readOnly purgedAt currency stripeMode totalAmount lockedTotalAmount remainingAmount feeAttorneyPct feeAttorneyAmount feeParalegalPct paymentIntentId escrowIntentId escrowSessionId escrowStatus paymentStatus fundingIntegrityStatus fundingVerifiedAt paymentReleased payoutStatus payoutTransferId paidOutAt withdrawnParalegalId payoutFinalizedAt payoutFinalizedType partialPayoutAmount pausedAt withdrawalHistory disputes disputeSettlement completedAt updatedAt attorneyNameSnapshot disputeDeadlineAt pausedReason paralegalAccessRevokedAt terminationStatus terminationDisputeId terminationRequestedAt".split(" ");
const operationFields = "caseId kind operationKey status amount currency stripeObjectId stripePaymentIntentId stripeChargeId stripeBalanceTransactionId stripeDisputeId stripeRefundId stripeTransferId grossAmount processingFeeAmount netAmount stripeMode livemode evidenceVerifiedAt refundAmount refundStatus refundEvidenceStatus refundVerifiedAt refundCreatedAt transferAmount processorStatus evidenceStatus administrativeStatus payoutPosition payoutHoldClearedAt createdAt completedAt".split(" ");
const payoutFields = "caseId paralegalId operationKey amountPaid transferId stripeMode livemode status reversedAt createdAt".split(" ");
const projection = fields => Object.fromEntries(fields.map(field => [field, 1]));
function currency(value) {
  const code = value == null ? "USD" : typeof value === "string" ? value.toUpperCase() : "";
  try { return Intl.supportedValuesOf("currency").includes(code) && new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits === 2 ? code : null; } catch { return null; }
}
function readQuery(query) {
  const view = query.view || "all", q = query.q || "";
  if (Object.keys(query).some(key => !["expectedOwnerId", "view", "q", "caseId", "cursor", "revision"].includes(key)) || !["all", "funding", "payout", "refund", "withdrawal", "chargeback", "review"].includes(view) || typeof q !== "string" || q.length > 100 || /[\u0000-\u001f\u007f]/.test(q) || query.caseId !== undefined && !validId(query.caseId) || query.cursor !== undefined && (typeof query.cursor !== "string" || !/^(0|[1-9]\d{0,4})$/.test(query.cursor) || !hash(query.revision)) || query.revision !== undefined && !hash(query.revision)) fail(400, "INVALID");
  return { view, q: q.trim(), caseId: query.caseId?.toLowerCase() || null, cursor: Number(query.cursor || 0), revision: query.revision || null };
}
async function inventory(ownerId, selectedCaseId) {
  return inventoryForFilter({ $or: [{ attorney: { $in: refs(ownerId) } }, { attorneyId: { $in: refs(ownerId) } }], ...(selectedCaseId ? { _id: new Types.ObjectId(selectedCaseId) } : {}) }, selectedCaseId);
}
// Internal batch reader. Its caller must scope the selected Matter IDs to the
// current role and verify that authority again before returning a projection.
async function inventoryForCases(caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length > cap || caseIds.some(value => !validId(id(value)))) fail(400, "INVALID");
  return inventoryForFilter({ _id: { $in: [...new Set(caseIds.map(id))].flatMap(refs) } });
}
async function inventoryForFilter(filter, selectedCaseId) {
  const cases = await Case.collection.find(filter, { projection: projection(caseFields) }).sort({ _id: 1 }).limit(cap + 1).toArray();
  if (cases.length > cap) fail(413, "TOO_LARGE");
  if (selectedCaseId && !cases.length) fail(404, "MATTER_UNAVAILABLE");
  let historicalCount = 0;
  for (const doc of cases) {
    if (doc.attorney && doc.attorneyId && id(doc.attorney).toLowerCase() !== id(doc.attorneyId).toLowerCase()) fail(409, "OWNERSHIP_CHANGED");
    if (doc.withdrawalHistory != null && !Array.isArray(doc.withdrawalHistory)) fail(409, "SOURCE_INVALID");
    historicalCount += doc.withdrawalHistory?.length || 0; if (historicalCount > cap) fail(413, "TOO_LARGE");
  }
  const caseIds = cases.flatMap(doc => refs(id(doc._id)));
  const [operations, payouts] = await Promise.all([
    PaymentOperation.collection.find({ caseId: { $in: caseIds } }, { projection: projection(operationFields) }).sort({ _id: 1 }).limit(cap + 1).toArray(),
    Payout.collection.find({ caseId: { $in: caseIds } }, { projection: projection(payoutFields) }).sort({ _id: 1 }).limit(cap + 1).toArray(),
  ]);
  if (operations.length > cap || payouts.length > cap) fail(413, "TOO_LARGE");
  const transferIds = payouts.map(row => row.transferId).filter(value => externalId(value, "tr")), payoutKeys = payouts.map(row => row.operationKey).filter(Boolean);
  const [payoutReferences, transferReferences] = await Promise.all([
    Payout.collection.find({ transferId: { $in: transferIds } }, { projection: { transferId: 1 } }).sort({ _id: 1 }).limit(cap + 1).toArray(),
    PaymentOperation.collection.find({ $or: [{ stripeTransferId: { $in: transferIds } }, { stripeObjectId: { $in: transferIds } }, { operationKey: { $in: payoutKeys } }] }, { projection: { caseId: 1, operationKey: 1, stripeTransferId: 1, stripeObjectId: 1 } }).sort({ _id: 1 }).limit(cap + 1).toArray(),
  ]);
  if (payoutReferences.length > cap || transferReferences.length > cap) fail(413, "TOO_LARGE");
  const intentIds = [...new Set([...cases.flatMap(doc => [doc.paymentIntentId, doc.escrowIntentId]), ...operations.filter(op => op.kind === "funding").flatMap(op => [op.stripePaymentIntentId, op.stripeObjectId])].filter(value => externalId(value, "pi")))];
  const fundingReferences = await Case.collection.find({ $or: [{ paymentIntentId: { $in: intentIds } }, { escrowIntentId: { $in: intentIds } }] }, { projection: { paymentIntentId: 1, escrowIntentId: 1 } }).sort({ _id: 1 }).limit(cap + 1).toArray();
  if (fundingReferences.length > cap) fail(413, "TOO_LARGE");
  const fundingOps = operations.filter(op => op.kind === "funding"), chargeIds = fundingOps.map(op => op.stripeChargeId).filter(value => externalId(value, "ch")), balanceIds = fundingOps.map(op => op.stripeBalanceTransactionId).filter(value => externalId(value, "txn"));
  const fundingOperations = await PaymentOperation.collection.find({ kind: "funding", $or: [{ stripePaymentIntentId: { $in: intentIds } }, { stripeObjectId: { $in: intentIds } }, { stripeChargeId: { $in: chargeIds } }, { stripeBalanceTransactionId: { $in: balanceIds } }] }, { projection: { stripePaymentIntentId: 1, stripeObjectId: 1, stripeChargeId: 1, stripeBalanceTransactionId: 1 } }).sort({ _id: 1 }).limit(cap + 1).toArray();
  if (fundingOperations.length > cap) fail(413, "TOO_LARGE");
  const refundIds = [...new Set(operations.flatMap(op => [op.stripeRefundId, op.stripeObjectId]).filter(value => externalId(value, "re")))];
  const refundReferences = await PaymentOperation.collection.find({ $or: [{ stripeRefundId: { $in: refundIds } }, { stripeObjectId: { $in: refundIds } }] }, { projection: { stripeRefundId: 1, stripeObjectId: 1 } }).sort({ _id: 1 }).limit(cap + 1).toArray();
  if (refundReferences.length > cap) fail(413, "TOO_LARGE");
  const peopleIds = [...new Set(cases.flatMap(doc => [id(doc.attorney), id(doc.attorneyId), id(doc.paralegal), id(doc.paralegalId), id(doc.withdrawnParalegalId), ...(doc.withdrawalHistory || []).map(record => id(record?.withdrawnParalegalId))]).filter(validId))];
  const people = await User.collection.find({ _id: { $in: peopleIds.map(value => new Types.ObjectId(value)) } }, { projection: { firstName: 1, lastName: 1 } }).sort({ _id: 1 }).toArray();
  return { cases, operations, payouts, payoutReferences, transferReferences, fundingReferences, fundingOperations, refundReferences, people };
}
const sameMode = (doc, source) => !["live", "test"].includes(doc.stripeMode) || !["live", "test"].includes(source.stripeMode) || doc.stripeMode === source.stripeMode;
function payoutDateMatches(record, payout) {
  if (!date(record.pausedAt)) return true;
  return date(payout.createdAt) ? new Date(payout.createdAt) >= new Date(record.pausedAt) : Boolean(record.payoutTransferId);
}
function proposedFunding(doc) {
  if (!money(doc.lockedTotalAmount ?? doc.totalAmount) || (doc.lockedTotalAmount ?? doc.totalAmount) <= 0 || doc.feeAttorneyAmount != null && !money(doc.feeAttorneyAmount) || doc.feeAttorneyPct != null && (typeof doc.feeAttorneyPct !== "number" || !Number.isFinite(doc.feeAttorneyPct) || doc.feeAttorneyPct < 0 || doc.feeAttorneyPct > 100)) return null;
  const expected = expectedCaseFunding(doc); return money(expected.totalAmount) ? expected.totalAmount : null;
}
const refundStates = { succeeded: ["recorded", "refund_processed"], pending: ["pending", "refund_pending"], requires_action: ["requires_action", "refund_action"], failed: ["failed", "refund_failed"], canceled: ["canceled", "refund_canceled"] };
function verifiedRefund(doc, op, key, amount, intentIds, snapshot) {
  const original = proposedFunding(doc);
  return externalId(key, "re") && op.stripeRefundId === key && (!externalId(op.stripeObjectId, "re") || op.stripeObjectId === key)
    && intentIds.length === 1 && externalId(intentIds[0], "pi") && op.stripePaymentIntentId === intentIds[0] && externalId(op.stripeChargeId, "ch")
    && op.refundEvidenceStatus === "verified" && date(op.refundVerifiedAt) && Object.hasOwn(refundStates, op.refundStatus)
    && money(amount) && amount > 0 && op.refundAmount === amount && money(original) && amount <= original && doc.fundingIntegrityStatus !== "failed"
    && typeof op.currency === "string" && Boolean(currency(doc.currency)) && currency(op.currency) === currency(doc.currency) && ["test", "live"].includes(op.stripeMode) && sameMode(doc, op)
    && Array.isArray(snapshot.refundReferences) && !snapshot.refundReferences.some(other => id(other._id) !== id(op._id) && [other.stripeRefundId, other.stripeObjectId].includes(key))
    && !snapshot.fundingReferences.some(other => id(other._id) !== id(doc._id) && [other.paymentIntentId, other.escrowIntentId].includes(intentIds[0]))
    && !snapshot.operations.some(other => id(other.caseId) === id(doc._id) && other.kind === "funding" && other.stripePaymentIntentId === intentIds[0] && other.stripeChargeId && other.stripeChargeId !== op.stripeChargeId);
}
function payoutRecordEvidence(doc, payout, { operations, payouts, payoutReferences = payouts, transferReferences = operations }) {
  const caseId = id(doc._id), code = currency(doc.currency), history = receiptHistory.inventory(doc);
  const personId = id(payout.paralegalId), candidates = history.filter(entry => entry.record && id(entry.record.withdrawnParalegalId) === personId && (entry.record.payoutTransferId ? entry.record.payoutTransferId === payout.transferId : history.filter(item => item.record && id(item.record.withdrawnParalegalId) === personId).length === 1 && payouts.filter(row => id(row.paralegalId) === personId).length === 1));
  const withdrawal = candidates.length === 1 ? candidates[0] : null;
  const linked = operations.filter(op => payout.operationKey && op.operationKey === payout.operationKey || externalId(payout.transferId, "tr") && [op.stripeTransferId, op.stripeObjectId].includes(payout.transferId));
  const operation = linked[0], safeOperation = linked.length <= 1 && (!operation || ["case_payout", "partial_payout", "dispute_settlement"].includes(operation.kind) && operation.status === "succeeded" && !["quarantined", "needs_reconciliation"].includes(operation.evidenceStatus) && [operation.stripeTransferId, externalId(operation.stripeObjectId, "tr") ? operation.stripeObjectId : null].filter(Boolean).every(value => value === payout.transferId) && [operation.kind === "dispute_settlement" ? null : operation.amount, operation.transferAmount].filter(value => value != null && value !== 0).every(value => value === payout.amountPaid) && sameMode(doc, operation) && currency(operation.currency) === code && (operation.kind === "dispute_settlement" ? operation.transferAmount === payout.amountPaid : operation.amount === payout.amountPaid));
  const assignment = !(doc.paralegal && doc.paralegalId && id(doc.paralegal) !== id(doc.paralegalId)) && id(doc.paralegal || doc.paralegalId) === personId;
  const settlement = doc.disputeSettlement, currentPayout = assignment && (doc.payoutTransferId === payout.transferId || payout.operationKey === `case_payout:${caseId}`) && payout.amountPaid === completion.amountFor(doc);
  const settledPayout = assignment && settlement?.transferId === payout.transferId && money(settlement.payoutAmount) && settlement.payoutAmount === payout.amountPaid;
  const withdrawnPayout = withdrawal && !withdrawal.conflict && receiptHistory.decisions.has(withdrawal.record.payoutFinalizedType) && money(doc.lockedTotalAmount ?? doc.totalAmount) && money(withdrawal.record.partialPayoutAmount) && withdrawal.record.partialPayoutAmount > 0 && withdrawal.record.partialPayoutAmount >= payout.amountPaid && withdrawal.record.partialPayoutAmount <= (doc.lockedTotalAmount ?? doc.totalAmount) && date(withdrawal.record.payoutFinalizedAt) && payoutDateMatches(withdrawal.record, payout) && history.filter(entry => entry.record?.payoutTransferId && entry.record.payoutTransferId === payout.transferId).length <= 1;
  const caseOutcome = !(currentPayout || doc.payoutTransferId === payout.transferId) || !["failed", "reversed", "needs_reconciliation"].includes(doc.payoutStatus);
  const stripeMode = retainedPayoutMode.inspect(doc, payout, operation);
  const valid = externalId(payout.transferId, "tr") && payoutReferences.filter(row => row.transferId === payout.transferId).length === 1 && !transferReferences.some(op => id(op.caseId) !== caseId && (payout.operationKey && op.operationKey === payout.operationKey || [op.stripeTransferId, op.stripeObjectId].includes(payout.transferId))) && money(payout.amountPaid) && payout.amountPaid > 0 && stripeMode && safeOperation && caseOutcome && (withdrawnPayout || currentPayout || settledPayout);
  const state = payout.reversedAt || payout.status === "reversed" ? "reversed" : payout.status === "failed" ? "failed" : payout.status === "pending" ? "pending" : payout.status === "paid" && valid ? "recorded" : "needs_review";
  return { state: code ? state : "needs_review", withdrawal, personId, linked, stripeMode, currency: code, amount: code && money(payout.amountPaid) ? payout.amountPaid : null, recordedAt: date(payout.createdAt) };
}
function rowsFor(snapshot) {
  const rows = [], names = new Map(snapshot.people.map(person => [id(person._id), [person.firstName, person.lastName].filter(value => typeof value === "string").join(" ").trim()]));
  const duplicateIntent = (intentId, caseId) => snapshot.fundingReferences.some(doc => id(doc._id) !== caseId && [doc.paymentIntentId, doc.escrowIntentId].includes(intentId));
  const duplicateFunding = op => snapshot.fundingOperations.some(other => id(other._id) !== id(op._id) && (op.stripePaymentIntentId && [other.stripePaymentIntentId, other.stripeObjectId].includes(op.stripePaymentIntentId) || op.stripeChargeId && other.stripeChargeId === op.stripeChargeId || op.stripeBalanceTransactionId && other.stripeBalanceTransactionId === op.stripeBalanceTransactionId));
  for (const doc of snapshot.cases) {
    const caseId = id(doc._id), code = currency(doc.currency), operations = snapshot.operations.filter(op => id(op.caseId) === caseId), payouts = snapshot.payouts.filter(row => id(row.caseId) === caseId), history = receiptHistory.inventory(doc);
    const title = typeof doc.title === "string" && doc.title ? doc.title : "Untitled Matter";
    const push = (key, type, state, amount, at, basis, receiptId = null, paralegalName = null) => {
      if (rows.length >= cap) fail(413, "TOO_LARGE");
      rows.push({ id: fingerprint([caseId, key]), caseId, caseTitle: title, type, state: code ? state : "needs_review", amount: code && money(amount) ? amount : null, currency: code, recordedAt: date(at), basis, receiptId, paralegalName });
    };
    const intentIds = [...new Set([doc.paymentIntentId, doc.escrowIntentId].filter(Boolean))], fundingOps = operations.filter(op => op.kind === "funding"), groups = new Map();
    for (const op of fundingOps) { const key = op.stripePaymentIntentId || op.stripeObjectId || `record:${id(op._id)}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(op); }
    for (const intentId of intentIds) if (!groups.has(intentId)) groups.set(intentId, []);
    if (!groups.size && (doc.escrowStatus === "funded" || doc.paymentReleased || doc.paralegal || doc.paralegalId || payouts.length || history.length > 1)) groups.set("unconfirmed", []);
    for (const [intentId, group] of groups) {
      const op = group[0], amount = group.length ? group.length === 1 && money(op.amount) ? op.amount : null : proposedFunding(doc), base = proposedFunding(doc);
      const verified = group.length === 1 && intentIds.length === 1 && intentIds[0] === intentId && externalId(intentId, "pi") && !duplicateIntent(intentId, caseId) && !duplicateFunding(op) && op.operationKey === `funding:${caseId}:${intentId}` && op.status === "succeeded" && op.stripePaymentIntentId === intentId && (!op.stripeObjectId || op.stripeObjectId === intentId) && externalId(op.stripeChargeId, "ch") && externalId(op.stripeBalanceTransactionId, "txn") && date(op.evidenceVerifiedAt) && money(op.grossAmount) && op.grossAmount === amount && op.grossAmount === base && money(op.processingFeeAmount) && money(op.netAmount) && op.grossAmount - op.processingFeeAmount === op.netAmount && currency(op.currency) === code && typeof op.livemode === "boolean" && op.stripeMode === (op.livemode ? "live" : "test") && sameMode(doc, op) && doc.fundingIntegrityStatus !== "failed";
      const sameCurrency = !op || currency(op.currency) === code;
      const state = !sameCurrency ? "needs_review" : verified ? "recorded" : group.length === 1 && op.status === "failed" && !op.stripeChargeId ? "failed" : group.length === 1 && op.status === "pending" && !op.stripeChargeId ? "pending" : !op && intentId === "unconfirmed" && doc.escrowStatus !== "funded" ? "unconfirmed" : "needs_review";
      push(["funding", intentId], "funding", state, sameCurrency ? verified ? op.grossAmount : amount : null, op?.evidenceVerifiedAt || op?.createdAt || doc.fundingVerifiedAt, verified ? "original_payment" : "funding_to_verify", intentIds.length === 1 && intentIds[0] === intentId || intentId === "unconfirmed" ? "payment" : null);
    }
    const usedOperations = new Set();
    for (const payout of payouts) {
      const { state, withdrawal, personId, linked } = payoutRecordEvidence(doc, payout, { operations, payouts, payoutReferences: snapshot.payoutReferences || snapshot.payouts, transferReferences: snapshot.transferReferences || snapshot.operations });
      linked.forEach(op => usedOperations.add(id(op._id)));
      push(["payout", id(payout._id)], "payout", state, payout.amountPaid, payout.createdAt, "paralegal_payout", withdrawal?.id || null, names.get(personId) || withdrawal?.name || "Paralegal name not recorded");
    }
    for (const entry of history.filter(item => item.record)) {
      const record = entry.record;
      const valid = !entry.conflict && validId(id(record.withdrawnParalegalId)) && date(record.payoutFinalizedAt) && receiptHistory.decisions.has(record.payoutFinalizedType) && money(record.partialPayoutAmount) && money(doc.lockedTotalAmount ?? doc.totalAmount) && record.partialPayoutAmount <= (doc.lockedTotalAmount ?? doc.totalAmount);
      push(["withdrawal", entry.id], "withdrawal", valid ? "decision_recorded" : "needs_review", record.partialPayoutAmount, record.payoutFinalizedAt, "withdrawal_decision", entry.id, names.get(id(record.withdrawnParalegalId)) || entry.name || "Paralegal name not recorded");
    }
    const refundGroups = new Map();
    for (const op of operations) {
      if (op.kind === "refund" || op.kind === "dispute_settlement" && (op.refundAmount > 0 || op.stripeRefundId)) { const key = op.stripeRefundId || (externalId(op.stripeObjectId, "re") ? op.stripeObjectId : id(op._id)); if (!refundGroups.has(key)) refundGroups.set(key, []); refundGroups.get(key).push(op); }
      if (["case_payout", "partial_payout", "dispute_settlement"].includes(op.kind) && !usedOperations.has(id(op._id)) && (op.kind !== "dispute_settlement" || op.transferAmount > 0 || op.stripeTransferId)) push(["payout_request", id(op._id)], "payout", currency(op.currency) !== code || !sameMode(doc, op) ? "needs_review" : op.status === "failed" && !op.stripeTransferId && !externalId(op.stripeObjectId, "tr") ? "failed" : op.status === "pending" ? "pending" : "needs_review", currency(op.currency) === code ? money(op.transferAmount) && op.transferAmount > 0 ? op.transferAmount : op.amount : null, op.createdAt, "payout_request");
      if (op.kind === "chargeback") push(["chargeback", id(op._id)], "chargeback", op.evidenceStatus === "verified" && externalId(op.stripeChargeId, "ch") && externalId(op.stripeDisputeId, "dp|du") && sameMode(doc, op) && currency(op.currency) === code ? "recorded" : "needs_review", currency(op.currency) === code ? op.amount : null, op.createdAt, "card_dispute");
    }
    const refundRows = [];
    for (const [key, group] of refundGroups) {
      const op = group[0], amount = money(op.refundAmount) && op.refundAmount > 0 ? op.refundAmount : op.kind === "refund" ? op.amount : null;
      const verified = group.length === 1 && verifiedRefund(doc, op, key, amount, intentIds, snapshot);
      const hasEvidence = op.refundStatus != null || op.refundEvidenceStatus != null || op.refundVerifiedAt != null;
      const state = group.length !== 1 || !sameMode(doc, op) || currency(op.currency) !== code || hasEvidence || op.status === "needs_reconciliation" ? "needs_review" : op.status === "failed" && !externalId(key, "re") ? "failed" : "unconfirmed";
      const [outcome, basis] = verified ? refundStates[op.refundStatus] : [state, "refund_request"];
      refundRows.push({ key, outcome, basis, amount: currency(op.currency) === code ? amount : null, at: verified ? op.refundCreatedAt : op.createdAt, verified, active: verified && ["succeeded", "pending", "requires_action"].includes(op.refundStatus) });
    }
    const activeRefundTotal = refundRows.filter(row => row.active).reduce((sum, row) => sum + row.amount, 0);
    const conflictingTotal = !money(activeRefundTotal) || activeRefundTotal > proposedFunding(doc);
    for (const row of refundRows) {
      const conflict = conflictingTotal && row.active;
      push(["refund", row.key], "refund", conflict ? "needs_review" : row.outcome, row.amount, row.at, conflict ? "refund_request" : row.basis, "payment");
    }
  }
  return rows.sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || "") || a.id.localeCompare(b.id));
}
function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.currency) continue;
    if (!groups.has(row.currency)) groups.set(row.currency, { currency: row.currency, originalFunding: 0, paralegalPayouts: 0, refunds: 0, fundingRecords: 0, payoutRecords: 0, refundRecords: 0, fundingUnverified: 0, payoutsUnverified: 0, refundsUnverified: 0 });
    const group = groups.get(row.currency), key = row.state === "recorded" ? { funding: "originalFunding", payout: "paralegalPayouts", refund: "refunds" }[row.type] : null;
    if (key) { group[key] += row.amount; group[{ funding: "fundingRecords", payout: "payoutRecords", refund: "refundRecords" }[row.type]]++; if (!money(group[key])) fail(413, "TOTAL_TOO_LARGE"); }
    else if (row.type === "funding") group.fundingUnverified++; else if (row.type === "payout") group.payoutsUnverified++; else if (row.type === "refund") group.refundsUnverified++;
  }
  return { currencies: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)), requiresReview: rows.filter(row => ["needs_review", "unconfirmed", "requires_action"].includes(row.state)).length, pending: rows.filter(row => row.state === "pending").length, undated: rows.filter(row => !row.recordedAt).length };
}
async function read(req, { exportAll = false } = {}) {
  const query = readQuery(req.query || {}), user = await account.read(req, req.query.expectedOwnerId), ownerId = id(user._id);
  if (exportAll && (!query.revision || query.cursor)) fail(400, "EXPORT_REVIEW_REQUIRED");
  const first = await inventory(ownerId, query.caseId), all = rowsFor(first), filtered = all.filter(row => (query.view === "all" || query.view === "review" ? query.view === "all" || ["needs_review", "unconfirmed", "requires_action"].includes(row.state) : row.type === query.view) && (!query.q || row.caseTitle.toLocaleLowerCase("en-US").includes(query.q.toLocaleLowerCase("en-US"))));
  const current = await inventory(ownerId, query.caseId), fresh = await account.read(req, req.query.expectedOwnerId);
  if (fingerprint(first) !== fingerprint(current) || fingerprint(user) !== fingerprint(fresh)) fail(409, "CHANGED");
  const revision = fingerprint([ownerId, first, query.view, query.q, query.caseId]);
  if (query.revision && query.revision !== revision || query.cursor > filtered.length) fail(409, "CHANGED");
  const entries = exportAll ? filtered : filtered.slice(query.cursor, query.cursor + 50);
  return { ownerId, revision, view: query.view, q: query.q, caseId: query.caseId, total: filtered.length, entries, nextCursor: !exportAll && query.cursor + entries.length < filtered.length ? String(query.cursor + entries.length) : null, summary: summarize(filtered) };
}
const typeLabels = { funding: "Matter funding", payout: "Paralegal payout", refund: "Refund", withdrawal: "Withdrawal decision", chargeback: "Card-provider dispute" };
const stateLabels = { recorded: "Recorded", decision_recorded: "Decision recorded", pending: "Pending", requires_action: "Action required", failed: "Failed", canceled: "Canceled", reversed: "Reversed", needs_review: "Records need review", unconfirmed: "Current status not confirmed" };
const basisLabels = { original_payment: "Original payment before refunds", funding_to_verify: "Funding amount to verify", paralegal_payout: "Net amount in payout record", payout_request: "Requested payout amount", refund_request: "Requested refund; processing not confirmed", refund_processed: "Refund recorded by Stripe", refund_pending: "Refund awaiting completion", refund_action: "Refund requires action", refund_failed: "Refund that did not complete", refund_canceled: "Canceled refund", withdrawal_decision: "Decision amount; payout checked separately", card_dispute: "Disputed payment; not an additional attorney charge" };
function csv(value) {
  const cell = value => { let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""); if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };
  const amount = value => money(value) ? `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}` : "";
  const rows = [["Matter", "Record", "Status", "Currency", "Amount", "Amount describes", "Recorded on (UTC)", "Paralegal", "Matter receipt path"]];
  for (const row of value.entries) rows.push([row.caseTitle, typeLabels[row.type], stateLabels[row.state], row.currency, row.type === "payout" ? "" : amount(row.amount), row.type === "payout" ? "Payment release record; see Matter release amount" : basisLabels[row.basis], row.recordedAt, row.paralegalName, row.receiptId ? `/attorney-v2.html#/matters/${row.caseId}/receipt?receiptId=${row.receiptId}` : ""]);
  return `\uFEFF${rows.map(row => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
// Internal adapters must authorize and load their own stable source inventory.
module.exports = { read, csv, rowsFor, loadFinancialInventory: inventory, loadFinancialInventoryForCases: inventoryForCases, payoutRecordEvidence, payoutSourceFields: { caseFields, operationFields, payoutFields }, typeLabels, stateLabels, basisLabels };
