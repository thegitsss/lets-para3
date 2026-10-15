const { Types } = require('mongoose');
const User = require('../models/User');
const financial = require('./attorneyFinancialHistory');
const receipts = require('./attorneyReceiptHistory');
const account = require('./attorneyAccountBoundary');
const { fingerprint } = require('./matterDraftRevision');
const { expectedCaseFunding } = require('../utils/paymentIntegrity');
const { chargebackHoldsPayout } = require('./payoutHoldService');
const { normalizeCaseStatus } = require('../utils/caseState');
const id = value => String(value?._id || value || '');
const validId = value => /^[a-f0-9]{24}$/i.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0;
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fail = (status, suffix) => { throw Object.assign(new Error('Payment amounts could not be verified. Refresh Payments before continuing.'), { status, publicCode: `PAYMENT_SUMMARY_${suffix}` }); };

function currency(value) {
  const code = value == null ? 'USD' : typeof value === 'string' ? value.toUpperCase() : '';
  try { return Intl.supportedValuesOf('currency').includes(code) && new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits === 2 ? code : null; } catch { return null; }
}
function plannedAmounts(doc) {
  const base = doc.lockedTotalAmount ?? doc.totalAmount;
  if (!money(base) || base <= 0 || doc.feeAttorneyAmount != null && !money(doc.feeAttorneyAmount) || doc.feeAttorneyPct != null && (typeof doc.feeAttorneyPct !== 'number' || !Number.isFinite(doc.feeAttorneyPct) || doc.feeAttorneyPct < 0 || doc.feeAttorneyPct > 100)) return null;
  const expected = expectedCaseFunding(doc);
  return money(expected.totalAmount) && expected.feeAmount === Math.round(base * expected.feePercent / 100) ? expected : null;
}
function remainingPrincipal(doc, rows) {
  const original = doc.lockedTotalAmount ?? doc.totalAmount;
  if (!money(original) || !original) return null;
  const entries = receipts.inventory(doc).filter(entry => entry.record?.payoutFinalizedAt);
  let disbursed = 0;
  for (const entry of entries) {
    const record = entry.record;
    if (entry.conflict || !date(record.payoutFinalizedAt) || !receipts.decisions.has(record.payoutFinalizedType) || !money(record.partialPayoutAmount)) return null;
    if (record.partialPayoutAmount > 0 && !rows.some(row => row.type === 'payout' && row.state === 'recorded' && row.receiptId === entry.id)) return null;
    disbursed += record.partialPayoutAmount;
    if (!money(disbursed) || disbursed > original) return null;
  }
  const remaining = doc.remainingAmount == null ? original - disbursed : doc.remainingAmount;
  return money(remaining) && remaining === original - disbursed ? remaining : null;
}
function groupFor(code) {
  return { currency: code, originalFunding: 0, refunds: 0, activeFunds: 0, pendingCharges: 0, fundingNeeded: 0, fundedMatterCosts: 0, fundedMatters: 0, requiresReview: 0, activeMatters: 0, pendingMatters: 0, unfundedMatters: 0, fundingUnknown: false, balanceUnknown: false, pendingUnknown: false };
}
function project(snapshot) {
  const rows = financial.rowsFor(snapshot), groups = new Map(), items = [];
  let unsupported = false;
  for (const doc of snapshot.cases) {
    const code = currency(doc.currency), caseId = id(doc._id), records = rows.filter(row => row.caseId === caseId);
    const funding = records.filter(row => row.type === 'funding'), verified = funding.filter(row => row.state === 'recorded');
    const operations = snapshot.operations.filter(row => id(row.caseId) === caseId);
    const linked = Boolean(doc.paymentIntentId || doc.escrowIntentId || doc.escrowSessionId || operations.some(row => row.kind === 'funding'));
    const relevant = linked || doc.escrowStatus === 'funded' || doc.paymentReleased || doc.paralegal || doc.paralegalId || records.some(row => row.type !== 'funding');
    if (!relevant) continue;
    const group = code ? groups.get(code) || groupFor(code) : null;
    if (group) groups.set(code, group); else unsupported = true;
    const amountPlan = plannedAmounts(doc), fundingKnown = verified.length === 1 && funding.length === 1;
    const payouts = records.filter(row => row.type === 'payout'), refunds = records.filter(row => row.type === 'refund');
    const paid = payouts.filter(row => row.state === 'recorded'), refunded = refunds.filter(row => row.state === 'recorded').reduce((sum, row) => sum + row.amount, 0);
    let state = 'needs_review', amountHeld = null, amountDue = null;
    if (!linked && doc.escrowStatus !== 'funded' && !doc.paymentReleased && !payouts.length && !refunds.length && !doc.withdrawalHistory?.length && !doc.payoutFinalizedAt) {
      const closed = doc.archived || doc.readOnly || doc.purgedAt || !['open', 'in progress'].includes(normalizeCaseStatus(doc.status));
      const assigned = validId(id(doc.paralegal || doc.paralegalId)) && (!doc.paralegal || !doc.paralegalId || id(doc.paralegal) === id(doc.paralegalId));
      state = closed ? 'not_funded' : amountPlan && code && assigned ? 'funding_needed' : 'needs_review';
      amountDue = state === 'funding_needed' ? amountPlan.totalAmount : null;
    } else if (fundingKnown && code) {
      const pendingMoney = records.some(row => ['payout', 'refund', 'chargeback'].includes(row.type) && !['recorded', 'failed', 'canceled'].includes(row.state));
      const disputed = operations.some(row => row.kind === 'chargeback' && (row.evidenceStatus !== 'verified' || chargebackHoldsPayout(row, doc))) || ['disputed', 'needs_reconciliation'].includes(doc.escrowStatus);
      const hasRefund = refunds.some(row => !['failed', 'canceled'].includes(row.state));
      const fullRefund = refunded === verified[0].amount && !paid.length && !pendingMoney;
      const remaining = remainingPrincipal(doc, records);
      const casePayouts = snapshot.payouts.filter(row => id(row.caseId) === caseId);
      const currentPayout = casePayouts.find(row => {
        if (doc.payoutTransferId ? row.transferId !== doc.payoutTransferId : row.operationKey !== `case_payout:${caseId}`) return false;
        const evidence = financial.payoutRecordEvidence(doc, row, { operations, payouts: casePayouts, payoutReferences: snapshot.payoutReferences, transferReferences: snapshot.transferReferences });
        return evidence.state === 'recorded' && !evidence.withdrawal;
      });
      const settlement = currentPayout && doc.disputeSettlement?.transferId === currentPayout.transferId ? doc.disputeSettlement : null;
      const requiredRefund = settlement ? settlement.refundAmount : 0;
      const settlementRefundComplete = money(requiredRefund) && (requiredRefund === 0 || refunds.some(row => row.state === 'recorded' && row.amount === requiredRefund) && operations.some(op => op.stripeRefundId === settlement.refundId && op.refundStatus === 'succeeded' && op.refundEvidenceStatus === 'verified'));
      const completedPayout = doc.paymentReleased === true && currentPayout && !pendingMoney && remaining !== null && settlementRefundComplete;
      if (!disputed && (fullRefund || completedPayout)) { state = 'settled'; amountHeld = 0; }
      else if (!pendingMoney && !disputed && !hasRefund && doc.paymentReleased !== true && doc.escrowStatus === 'funded' && remaining !== null && !['failed', 'reversed', 'needs_reconciliation'].includes(doc.payoutStatus)) { state = remaining ? 'active' : 'settled'; amountHeld = remaining; }
    } else if (code && amountPlan && funding.length === 1 && funding[0].state === 'pending' && operations.filter(row => row.kind === 'funding').length === 1) {
      const pending = operations.find(row => row.kind === 'funding'), intent = doc.paymentIntentId || doc.escrowIntentId;
      const uniqueIntent = snapshot.fundingReferences.filter(row => [row.paymentIntentId, row.escrowIntentId].includes(intent)).length === 1 && snapshot.fundingOperations.filter(row => [row.stripePaymentIntentId, row.stripeObjectId].includes(intent)).length === 1;
      if (intent && uniqueIntent && (!doc.paymentIntentId || !doc.escrowIntentId || doc.paymentIntentId === doc.escrowIntentId) && pending.stripePaymentIntentId === intent && pending.operationKey === `funding:${caseId}:${intent}` && pending.amount === amountPlan.totalAmount && currency(pending.currency) === code && (!['live', 'test'].includes(doc.stripeMode) || pending.stripeMode === doc.stripeMode)) { state = 'pending'; amountDue = pending.amount; }
    }
    if (group) {
      if (fundingKnown) { group.originalFunding += verified[0].amount; group.fundedMatterCosts += doc.lockedTotalAmount ?? doc.totalAmount; group.fundedMatters++; }
      else if (linked || doc.escrowStatus === 'funded' || doc.paymentReleased) group.fundingUnknown = true;
      group.refunds += refunded;
      if (state === 'active') { group.activeFunds += amountHeld; group.activeMatters++; }
      if (state === 'pending') { group.pendingCharges += amountDue; group.pendingMatters++; group.balanceUnknown = true; }
      if (state === 'funding_needed') { group.fundingNeeded += amountDue; group.unfundedMatters++; }
      if (state === 'needs_review') { group.requiresReview++; group.balanceUnknown = true; if (!fundingKnown) group.pendingUnknown = true; }
      if (![group.originalFunding, group.refunds, group.activeFunds, group.pendingCharges, group.fundingNeeded, group.fundedMatterCosts].every(money)) fail(413, 'TOTAL_TOO_LARGE');
    }
    items.push({ id: caseId, caseId, caseName: typeof doc.title === 'string' && doc.title || 'Untitled Matter', caseStatus: doc.archived ? 'archived' : doc.status || 'unknown', archived: Boolean(doc.archived), currency: code, status: state, amountHeld, amountDue, fundedAt: fundingKnown ? verified[0].recordedAt : null, checkoutUrl: `/attorney-v2.html#/matters/${caseId}/financials`, paralegalId: id(doc.paralegal || doc.paralegalId) || null, paralegalName: snapshot.people.filter(person => id(person._id) === id(doc.paralegal || doc.paralegalId)).map(person => [person.firstName, person.lastName].filter(Boolean).join(' '))[0] || '' });
  }
  const currencies = [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(group => ({ ...group, activeFunds: group.balanceUnknown ? null : group.activeFunds, pendingCharges: group.pendingUnknown ? null : group.pendingCharges, originalFunding: group.fundingUnknown ? null : group.originalFunding }));
  const usd = currencies.find(group => group.currency === 'USD') || groupFor('USD');
  return { currencies, items, requiresReview: items.filter(item => item.status === 'needs_review').length, unsupportedCurrency: unsupported,
    totalSpent: unsupported ? null : usd.originalFunding, activeFunds: unsupported ? null : usd.activeFunds, activeEscrow: unsupported ? null : usd.activeFunds,
    pendingCharges: unsupported ? null : usd.pendingCharges, fundingNeeded: unsupported ? null : usd.fundingNeeded,
    averageJobCost: unsupported || usd.fundingUnknown ? null : usd.fundedMatters ? Math.round(usd.fundedMatterCosts / usd.fundedMatters) : 0,
    completedJobsCount: snapshot.cases.filter(doc => doc.status === 'completed').length, pendingJobsCount: items.filter(item => item.status === 'pending').length };
}
async function actor(ownerId, req) {
  if (req) return account.read(req, req.query?.expectedOwnerId ?? ownerId);
  const value = await User.collection.findOne({ _id: new Types.ObjectId(ownerId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!value || value.role !== 'attorney' || value.status !== 'approved' || value.disabled || value.deleted) fail(403, 'ACCOUNT_CHANGED');
  return value;
}
async function read(attorneyId, { req } = {}) {
  const ownerId = id(attorneyId); if (!validId(ownerId)) fail(400, 'INVALID');
  const user = await actor(ownerId, req), first = await financial.loadFinancialInventory(ownerId);
  const value = project(first), current = await financial.loadFinancialInventory(ownerId), fresh = await actor(ownerId, req);
  if (fingerprint(first) !== fingerprint(current) || fingerprint(user) !== fingerprint(fresh)) fail(409, 'CHANGED');
  return { ownerId, revision: fingerprint([ownerId, first]), ...value };
}
async function list(req, view) {
  const query = req.query || {}, limit = query.limit === undefined ? 200 : Number(query.limit), offset = query.cursor === undefined ? 0 : Number(query.cursor);
  if (Object.keys(query).some(key => !['expectedOwnerId', 'limit', 'cursor', 'revision'].includes(key)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || query.cursor !== undefined && (!/^(0|[1-9]\d*)$/.test(query.cursor) || typeof query.revision !== 'string' || !/^[a-f0-9]{64}$/.test(query.revision))) fail(400, 'INVALID');
  const value = await read(req.user.id || req.user._id, { req });
  if (query.revision !== undefined && query.revision !== value.revision) fail(409, 'CHANGED');
  const rows = value.items.filter(row => view === 'active' ? ['active', 'needs_review'].includes(row.status) : ['pending', 'funding_needed', 'needs_review'].includes(row.status));
  if (offset > rows.length) fail(409, 'CHANGED');
  return { ownerId: value.ownerId, revision: value.revision, items: rows.slice(offset, offset + limit), count: rows.length, total: view === 'active' ? value.activeFunds : value.pendingCharges === null || value.fundingNeeded === null ? null : value.pendingCharges + value.fundingNeeded, currency: 'USD', currencies: value.currencies, nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
}
module.exports = { read, list, project };
