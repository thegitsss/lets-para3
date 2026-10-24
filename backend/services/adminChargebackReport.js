const { Types } = require('mongoose');
const Case = require('../models/Case');
const Operation = require('../models/PaymentOperation');
const Adjustment = require('../models/FinancialAdjustment');
const account = require('./financialAccountBoundary');
const { fingerprint } = require('./matterDraftRevision');
const { chargebackHoldsPayout } = require('./payoutHoldService');
const { maskIdentifier } = require('./fundingEvidenceBackfillService');
const { id, money, currency, fail } = require('./adminFinancialReport');
const validId = value => /^[a-f0-9]{24}$/i.test(value || '');
async function limited(Model, query, projection) {
  const rows = await Model.collection.find(query, { projection }).sort({ _id: 1 }).limit(10001).toArray();
  if (rows.length > 10000) fail(413, 'TOO_LARGE');
  return rows;
}
async function source() {
  const operations = await limited(Operation, { kind: 'chargeback' }, { caseId: 1, amount: 1, currency: 1, stripeMode: 1, livemode: 1, stripeDisputeId: 1, stripeChargeId: 1, stripeEventId: 1, evidenceStatus: 1, administrativeStatus: 1, processorStatus: 1, payoutPosition: 1, payoutHoldClearedAt: 1, processorEventCreatedAt: 1, createdAt: 1, updatedAt: 1 });
  const operationIds = operations.map(row => row._id), caseIds = [...new Set(operations.map(row => id(row.caseId)).filter(validId))];
  const [cases, adjustments] = await Promise.all([
    limited(Case, { _id: { $in: caseIds.map(value => new Types.ObjectId(value)) } }, { title: 1, caseNumber: 1, status: 1, archived: 1, paymentReleased: 1, remainingAmount: 1, payoutFinalizedAt: 1, partialPayoutAmount: 1, withdrawalHistory: 1 }),
    limited(Adjustment, { paymentOperationId: { $in: operationIds } }, { idempotencyKey: 1, paymentOperationId: 1, caseId: 1, amount: 1, direction: 1, adjustmentType: 1, currency: 1, stripeMode: 1, stripeDisputeId: 1, stripeChargeId: 1, stripeBalanceTransactionId: 1, stripeEventId: 1, stripeEvidenceCreatedAt: 1 }),
  ]);
  const references = await limited(Adjustment, { stripeBalanceTransactionId: { $in: adjustments.map(row => row.stripeBalanceTransactionId).filter(Boolean) } }, { idempotencyKey: 1, paymentOperationId: 1, stripeBalanceTransactionId: 1, adjustmentType: 1, direction: 1 });
  return { operations, cases, adjustments, references };
}
function project(operation, value) {
  const doc = value.cases.find(row => id(row._id) === id(operation.caseId)), rows = value.adjustments.filter(row => id(row.paymentOperationId) === id(operation._id));
  const code = currency(operation.currency), mode = ['test', 'live'].includes(operation.stripeMode) ? operation.stripeMode : 'unknown';
  const retainedCharges = [...new Set(rows.map(row => row.stripeChargeId).filter(value => /^ch_[a-zA-Z0-9_]+$/.test(value || '')))];
  const chargeId = operation.stripeChargeId || (retainedCharges.length === 1 ? retainedCharges[0] : null);
  const verified = code && mode !== 'unknown' && (operation.livemode == null || operation.livemode === (mode === 'live')) && operation.evidenceStatus === 'verified' && /^d[pu]_[a-zA-Z0-9_]+$/.test(operation.stripeDisputeId || '') && /^ch_[a-zA-Z0-9_]+$/.test(chargeId || '') && money(operation.amount);
  const valid = verified && rows.length > 0 && rows.every(row => money(row.amount) && row.amount > 0 && ['debit', 'credit'].includes(row.direction) && currency(row.currency) === code && row.stripeMode === mode && row.stripeDisputeId === operation.stripeDisputeId && row.stripeChargeId === chargeId && id(row.caseId) === id(operation.caseId) && /^txn_[a-zA-Z0-9_]+$/.test(row.stripeBalanceTransactionId || '') && /^evt_[a-zA-Z0-9_]+$/.test(row.stripeEventId || '') && typeof row.idempotencyKey === 'string' && Boolean(row.idempotencyKey) && ({ chargeback_principal: 'debit', chargeback_recovery: 'credit', processor_dispute_fee: 'debit', processor_fee_recovery: 'credit' })[row.adjustmentType] === row.direction && value.references.filter(other => other.idempotencyKey === row.idempotencyKey).length === 1 && value.references.filter(other => other.stripeBalanceTransactionId === row.stripeBalanceTransactionId && other.adjustmentType === row.adjustmentType && other.direction === row.direction).length === 1 && !value.references.some(other => other.stripeBalanceTransactionId === row.stripeBalanceTransactionId && id(other.paymentOperationId) !== id(operation._id)));
  const sum = direction => rows.filter(row => row.direction === direction).reduce((sum, row) => sum + row.amount, 0);
  const debits = valid ? sum('debit') : null, credits = valid ? sum('credit') : null;
  const fees = valid ? rows.filter(row => ['processor_dispute_fee', 'processor_fee_recovery'].includes(row.adjustmentType)).reduce((sum, row) => sum + (row.direction === 'debit' ? row.amount : -row.amount), 0) : null;
  if (valid && (!money(debits) || !money(credits) || !Number.isSafeInteger(fees) || !Number.isSafeInteger(debits - credits))) fail(413, 'TOTAL_TOO_LARGE');
  return { id: id(operation._id), matter: doc ? { id: id(doc._id), title: doc.title || 'Untitled Matter', caseNumber: doc.caseNumber || null, status: doc.status, archived: doc.archived === true } : null, chargebackAmount: verified ? operation.amount : null, requestedAmount: money(operation.amount) ? operation.amount : null, currency: code, processorFees: fees, payoutPosition: operation.payoutPosition || 'unknown', payoutHold: chargebackHoldsPayout(operation, doc), stripeMode: mode, processorStatus: operation.processorStatus || 'unknown', administrativeStatus: operation.administrativeStatus || 'pending_review', evidenceStatus: valid ? 'verified' : 'needs_review', sourceEvidenceStatus: operation.evidenceStatus || 'needs_reconciliation', netExposure: valid ? debits - credits : null, debitEvidence: debits, creditEvidence: credits, evidenceCount: rows.length, disputeRef: maskIdentifier(operation.stripeDisputeId), updatedAt: operation.updatedAt || null };
}
async function read(req) {
  const query = req.query || {}, page = query.page === undefined ? 1 : Number(query.page), limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.id && !validId(query.id)) fail(400, 'INVALID');
  const owner = await account.read(req, 'admin', query.expectedOwnerId), first = await source();
  const selected = first.operations.filter(row => {
    if (query.id && id(row._id) !== query.id) return false;
    if (!query.status || query.status === 'all') return true;
    return query.status === 'pending_review' ? !row.administrativeStatus || row.administrativeStatus === 'pending_review' : row.administrativeStatus === query.status;
  }).sort((a, b) => new Date(b.processorEventCreatedAt || b.createdAt || 0) - new Date(a.processorEventCreatedAt || a.createdAt || 0) || id(b._id).localeCompare(id(a._id)));
  const revision = fingerprint([owner, first, query.id || null, query.status || 'all']);
  if (query.revision !== undefined && query.revision !== revision) fail(409, 'CHANGED');
  const items = selected.slice((page - 1) * limit, page * limit).map(row => project(row, first));
  const current = await source(), fresh = await account.read(req, 'admin', query.expectedOwnerId);
  if (fingerprint(owner) !== fingerprint(fresh) || fingerprint(first) !== fingerprint(current)) fail(409, 'CHANGED');
  return { ownerId: id(owner._id), revision, page, limit, total: selected.length, pages: Math.ceil(selected.length / limit), items };
}
module.exports = { read };
