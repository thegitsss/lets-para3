const { Types } = require('mongoose');
const Case = require('../models/Case');
const Operation = require('../models/PaymentOperation');
const Payout = require('../models/Payout');
const Income = require('../models/PlatformIncome');
const account = require('./financialAccountBoundary');
const financial = require('./attorneyFinancialHistory');
const summary = require('./attorneyPaymentSummary');
const payoutReceipt = require('./paralegalPayoutReceipt');
const completion = require('./completionPayoutEvidence');
const { fingerprint } = require('./matterDraftRevision');

const cap = 10000;
const id = value => String(value?._id || value || '');
const money = value => Number.isSafeInteger(value) && value >= 0;
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const mode = value => ['test', 'live'].includes(value) ? value : 'unknown';
const fields = names => Object.fromEntries(names.map(name => [name, 1]));
function fail(status, suffix) {
  throw Object.assign(new Error('Financial records could not be verified. Refresh before continuing.'), { status, statusCode: status, code: `ADMIN_FINANCIAL_${suffix}`, publicCode: `ADMIN_FINANCIAL_${suffix}` });
}
function currency(value) {
  const code = typeof value === 'string' ? value.toUpperCase() : '';
  try { return Intl.supportedValuesOf('currency').includes(code) && new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits === 2 ? code : null; } catch { return null; }
}
async function limited(Model, query, projection) {
  const rows = await Model.collection.find(query, { projection }).sort({ _id: 1 }).limit(cap + 1).toArray();
  if (rows.length > cap) fail(413, 'TOO_LARGE');
  return rows;
}
async function source(caseId, { caseIds = null, incomeAttorneyIds = null } = {}) {
  const references = values => values.flatMap(value => [String(value), new Types.ObjectId(String(value))]);
  const selected = caseId ? { _id: new Types.ObjectId(caseId) } : caseIds ? { _id: { $in: references(caseIds) } } : {};
  const caseDocs = await limited(Case, selected, fields([...financial.payoutSourceFields.caseFields, 'createdAt', 'deadlineDate', 'deadline', 'payoutFailureReason', 'completionClaimStatus']));
  const snapshot = await financial.loadFinancialInventoryForCases(caseDocs.map(doc => id(doc._id)));
  const filter = caseId ? { caseId: { $in: [caseId, new Types.ObjectId(caseId)] } } : caseIds ? { caseId: { $in: references(caseIds) } } : {};
  // Keep orphan and incomplete operational rows visible for investigation. Raw
  // reads avoid schema defaults inventing a currency, mode, amount or outcome.
  const [operations, payouts, income] = await Promise.all([
    limited(Operation, filter, fields([...financial.payoutSourceFields.operationFields, 'lastError', 'updatedAt'])),
    limited(Payout, filter, fields([...financial.payoutSourceFields.payoutFields, 'failureReason'])),
    limited(Income, incomeAttorneyIds ? { $or: [filter, { attorneyId: { $in: references(incomeAttorneyIds) } }] } : filter, fields(['caseId', 'operationKey', 'attorneyId', 'paralegalId', 'feeAmount', 'stripeMode', 'createdAt'])),
  ]);
  return { snapshot, caseDocs, operations, payouts, income };
}
const scoped = (snapshot, doc) => ({ ...snapshot, cases: [doc], operations: snapshot.operations.filter(row => id(row.caseId) === id(doc._id)), payouts: snapshot.payouts.filter(row => id(row.caseId) === id(doc._id)) });

function aggregate(rows, { unknownAffectsTotal = false } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.currency || !['test', 'live'].includes(row.stripeMode)) continue;
    if (!unknownAffectsTotal && (row.state !== 'recorded' || !money(row.amount))) continue;
    const key = `${row.currency}:${row.stripeMode}`;
    if (!groups.has(key)) groups.set(key, { currency: row.currency, stripeMode: row.stripeMode, totalRecorded: 0, count: 0, requiresReview: 0 });
    const group = groups.get(key);
    if (row.state === 'recorded' && money(row.amount)) { group.totalRecorded += row.amount; group.count++; }
    else group.requiresReview++;
    if (!money(group.totalRecorded)) fail(413, 'TOTAL_TOO_LARGE');
  }
  const currencies = [...groups.values()].sort((a, b) => `${a.currency}:${a.stripeMode}`.localeCompare(`${b.currency}:${b.stripeMode}`));
  const unknown = rows.some(row => !row.currency || !['test', 'live'].includes(row.stripeMode) || row.state !== 'recorded' || !money(row.amount));
  const totalAmount = unknownAffectsTotal && unknown || currencies.length > 1 || currencies.some(group => group.currency !== 'USD') ? null : currencies[0]?.totalRecorded ?? 0;
  return { totalAmount, currencies, count: rows.filter(row => row.state === 'recorded' && money(row.amount) && row.currency && ['test', 'live'].includes(row.stripeMode)).length, requiresReview: rows.filter(row => !['recorded', 'failed', 'canceled'].includes(row.state)).length, undated: rows.filter(row => !row.recordedAt).length, states: Object.fromEntries([...new Set(rows.map(row => row.state))].map(state => [state, rows.filter(row => row.state === state).length])) };
}
function project(value, { from = null } = {}) {
  const { snapshot } = value;
  const historyRows = financial.rowsFor(snapshot), balances = summary.project(snapshot).items;
  const cases = new Map(snapshot.cases.map(doc => [id(doc._id), doc]));
  const period = row => !from || !row.recordedAt || new Date(row.recordedAt) >= from;
  const dated = row => !from || Boolean(row.recordedAt);
  const funding = value.operations.filter(op => op.kind === 'funding').map(op => {
    const doc = cases.get(id(op.caseId)), key = op.stripePaymentIntentId || op.stripeObjectId || `record:${id(op._id)}`;
    const row = historyRows.find(row => row.id === fingerprint([id(op.caseId), ['funding', key]]));
    const code = currency(op.currency), valid = doc && currency(doc.currency) === code && code && row?.state === 'recorded';
    return { id: id(op._id), caseId: id(op.caseId), title: doc?.title || '', operationKey: op.operationKey || null, state: valid ? 'recorded' : row?.state === 'failed' ? 'failed' : row?.state === 'pending' ? 'pending' : 'needs_review', status: op.status || 'unknown', amount: valid ? row.amount : null, requestedAmount: money(op.amount) ? op.amount : null, grossAmount: valid ? op.grossAmount : null, processingFeeAmount: valid ? op.processingFeeAmount : null, netAmount: valid ? op.netAmount : null, currency: code, stripeMode: mode(op.stripeMode), recordedAt: date(op.evidenceVerifiedAt), createdAt: date(op.createdAt), stripePaymentIntentId: op.stripePaymentIntentId || null, stripeChargeId: op.stripeChargeId || null, stripeBalanceTransactionId: op.stripeBalanceTransactionId || null, basis: valid ? 'original_payment' : 'funding_to_verify' };
  });
  const payouts = value.payouts.map(row => {
    const doc = cases.get(id(row.caseId)), evidence = doc ? financial.payoutRecordEvidence(doc, row, scoped(snapshot, doc)) : null;
    const code = doc ? currency(doc.currency) : null, state = code ? evidence?.state || 'needs_review' : 'needs_review';
    const payee = snapshot.people.find(person => id(person._id) === id(row.paralegalId));
    return { id: id(row._id), payoutId: id(row._id), caseId: id(row.caseId), title: doc?.title || '', paralegalId: id(row.paralegalId), paralegalName: [payee?.firstName, payee?.lastName].filter(Boolean).join(' ') || 'Name unavailable', operationKey: row.operationKey || null, reference: row.transferId || null, state, status: state === 'recorded' ? 'paid' : state, amount: state === 'recorded' ? evidence.amount : null, requestedAmount: money(row.amountPaid) ? row.amountPaid : null, currency: code, stripeMode: evidence?.stripeMode || 'unknown', recordedAt: date(row.createdAt), receiptId: evidence?.withdrawal?.id || 'completion', basis: 'paralegal_payout' };
  });
  const income = value.income.map(row => {
    const doc = cases.get(id(row.caseId)), linked = payouts.filter(p => row.operationKey && p.operationKey === row.operationKey), original = funding.filter(p => p.caseId === id(row.caseId) && p.state === 'recorded');
    const payout = linked[0]; let expected = null, retainedAttorneyFee = null, retainedParalegalFee = null;
    if (doc && linked.length === 1 && payout.state === 'recorded' && original.length === 1 && id(row.attorneyId) === id(doc.attorney || doc.attorneyId) && id(row.paralegalId) === payout.paralegalId && mode(row.stripeMode) === payout.stripeMode && original[0].stripeMode === payout.stripeMode && value.income.filter(other => other.operationKey === row.operationKey).length === 1) {
      try {
        const receipt = payoutReceipt.projectReceipt({ snapshot: scoped(snapshot, doc), person: snapshot.people.find(person => id(person._id) === payout.paralegalId) }, payout.paralegalId, payout.receiptId);
        const paralegalFee = receipt.grossCents - receipt.amountCents;
        if (payout.receiptId !== 'completion') { expected = paralegalFee; retainedAttorneyFee = 0; retainedParalegalFee = paralegalFee; }
        else {
          const settlement = doc.disputeSettlement?.transferId === payout.reference ? doc.disputeSettlement : null;
          const attorneyFee = settlement ? settlement.feeAttorneyAmount : original[0].amount - (doc.lockedTotalAmount ?? doc.totalAmount);
          if (money(attorneyFee) && (!settlement || settlement.feeParalegalAmount === paralegalFee) && balances.find(b => b.caseId === id(doc._id))?.status === 'settled') { expected = attorneyFee + paralegalFee; retainedAttorneyFee = attorneyFee; retainedParalegalFee = paralegalFee; }
        }
      } catch (error) { if (error.status !== 409 && error.status !== 404 && error.status !== 403) throw error; }
    }
    const valid = money(expected) && money(row.feeAmount) && expected === row.feeAmount;
    return { id: id(row._id), caseId: id(row.caseId), title: doc?.title || '', operationKey: row.operationKey || null, state: valid ? 'recorded' : 'needs_review', status: valid ? 'recorded' : 'needs_review', amount: valid ? row.feeAmount : null, attorneyFeeAmount: valid ? retainedAttorneyFee : null, paralegalFeeAmount: valid ? retainedParalegalFee : null, requestedAmount: money(row.feeAmount) ? row.feeAmount : null, currency: doc ? currency(doc.currency) : null, stripeMode: mode(row.stripeMode), recordedAt: date(row.createdAt), basis: valid ? 'retained_platform_fee' : 'income_to_verify' };
  });
  const matters = balances.map(row => {
    const doc = cases.get(row.caseId), original = funding.filter(f => f.caseId === row.caseId && f.state === 'recorded');
    return { ...row, currency: currency(doc.currency), stripeMode: original.length === 1 ? original[0].stripeMode : 'unknown', amountHeld: currency(doc.currency) ? row.amountHeld : null };
  });
  // Report windows apply to flows. Principal still held is always current,
  // including old Matters and amounts retained after earlier withdrawals.
  const heldRows = matters.filter(row => !['not_funded', 'funding_needed'].includes(row.status)).map(row => ({ ...row, state: ['active', 'settled'].includes(row.status) && money(row.amountHeld) ? 'recorded' : row.status === 'pending' ? 'pending' : 'needs_review', amount: row.amountHeld, recordedAt: row.fundedAt }));
  const pending = matters.filter(row => ['completed', 'closed'].includes(row.caseStatus) && !cases.get(row.caseId).paymentReleased).map(row => {
    const doc = cases.get(row.caseId), net = row.status === 'active' && money(row.amountHeld) ? completion.amountFor({ ...doc, remainingAmount: row.amountHeld }) : null;
    return { ...row, state: money(net) ? 'recorded' : 'needs_review', amount: money(net) ? net : null, basis: 'estimated_payout', recordedAt: null };
  });
  const flow = rows => rows.filter(period);
  const inPeriod = rows => rows.filter(period).map(row => dated(row) ? row : { ...row, state: 'needs_review', amount: null });
  return { matters, historyRows, funding: flow(funding), payouts: flow(payouts), income: flow(income), pending, allFunding: funding, allPayouts: payouts, allIncome: income,
    held: aggregate(heldRows, { unknownAffectsTotal: true }), payoutTotals: aggregate(inPeriod(payouts)), incomeTotals: aggregate(inPeriod(income), { unknownAffectsTotal: true }), fundingTotals: aggregate(inPeriod(funding), { unknownAffectsTotal: true }), pendingTotals: aggregate(pending, { unknownAffectsTotal: true }) };
}
async function begin(req, { caseId = null, from = null } = {}) {
  if (caseId && !/^[a-f0-9]{24}$/i.test(caseId) || from !== null && (!(from instanceof Date) || !Number.isFinite(from.getTime()))) fail(400, 'INVALID');
  const owner = await account.read(req, 'admin', req.query?.expectedOwnerId), first = await source(caseId);
  const revision = fingerprint([owner, first, from?.toISOString() || null]), value = { ...project(first, { from }), ownerId: id(owner._id), revision, from: from?.toISOString() || null };
  return { value, source: first, async verify() {
    const current = await source(caseId), fresh = await account.read(req, 'admin', req.query?.expectedOwnerId);
    if (fingerprint(owner) !== fingerprint(fresh) || fingerprint(first) !== fingerprint(current)) fail(409, 'CHANGED');
  } };
}
async function read(req, options) { const report = await begin(req, options); await report.verify(); return report.value; }
// Internal commission adapter: its caller scopes referral IDs and verifies
// current account authority before delivering these retained projections.
async function commissionSource(caseIds, attorneyIds) {
  if (!Array.isArray(caseIds) || !Array.isArray(attorneyIds) || caseIds.length > cap || attorneyIds.length > cap || [...caseIds, ...attorneyIds].some(value => !/^[a-f0-9]{24}$/i.test(String(value)))) fail(400, 'INVALID');
  const value = await source(null, { caseIds, incomeAttorneyIds: attorneyIds });
  return { source: value, report: project(value) };
}
module.exports = { begin, read, aggregate, currency, money, date, id, fail, commissionSource };
