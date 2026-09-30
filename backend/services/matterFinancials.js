const financial = require('./attorneyFinancialHistory');
const attorneySummary = require('./attorneyPaymentSummary');
const attorneyAccount = require('./attorneyAccountBoundary');
const account = require('./financialAccountBoundary');
const expected = require('./paralegalExpectedCompensation');
const history = require('./paralegalHistoryProjection');
const receipts = require('./paralegalPayoutReceipt');
const { fingerprint } = require('./matterDraftRevision');
const { normalizeCaseStatus } = require('../utils/caseState');

// These joins compare logical Mongo identities, including raw legacy refs.
const id = value => String(value?._id || value?.id || value || '').toLowerCase();
const money = value => Number.isSafeInteger(value) && value >= 0;
const fail = (status, suffix) => { throw Object.assign(new Error('The Matter payment details changed or could not be verified. Refresh to try again.'), { status, statusCode: status, publicCode: `MATTER_FINANCIAL_${suffix}` }); };
const labels = { recorded: 'Payout recorded', no_payout: 'No payout', estimate: 'Estimated payout', paused: 'Payment paused', unconfirmed: 'Payout not confirmed', reversed: 'Payout reversed', pending: 'Payment pending', failed: 'Payment failed', needs_review: 'Payment details need review', active: 'Funded', settled: 'Settled', funding_needed: 'Funding required', not_funded: 'Not funded' };
const notes = { estimate: 'The estimate uses the remaining funded budget. It is not a recorded payout.', paused: 'Final payout details are not available.', unconfirmed: 'A finalized payout has not been verified.', needs_review: 'Unverified amounts are unavailable.' };
function currency(value) {
  const code = value == null ? 'USD' : typeof value === 'string' ? value.toUpperCase() : '';
  try { return Intl.supportedValuesOf('currency').includes(code) && new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits === 2 ? code : null; } catch { return null; }
}
function authorized(doc, ownerId, role) {
  if (!doc) fail(404, 'NOT_FOUND');
  const fields = role === 'attorney' ? ['attorney', 'attorneyId'] : ['paralegal', 'paralegalId'];
  if (doc[fields[0]] && doc[fields[1]] && id(doc[fields[0]]) !== id(doc[fields[1]])) fail(409, 'OWNERSHIP_CHANGED');
  if (id(doc[fields[0]] || doc[fields[1]]) !== ownerId) fail(403, 'RESTRICTED');
  // Retained receipts do not restore a closed or revoked workspace.
  if (role === 'paralegal' && (doc.paralegalAccessRevokedAt || normalizeCaseStatus(doc.status) === 'completed' || doc.paymentReleased === true)) fail(403, 'RESTRICTED');
}
function paralegal(snapshot, ownerId) {
  const doc = snapshot.cases[0], status = normalizeCaseStatus(doc.status);
  const choices = history.projectReceipts(snapshot, ownerId, { includeCompletion: status === 'closed' || doc.paymentReleased === true });
  const amounts = [];
  let state = 'paused', stripeMode = null;
  if (status === 'in progress' && !doc.archived && !doc.paymentReleased) {
    const value = expected.project(snapshot, ownerId);
    state = value.state; stripeMode = value.stripeMode === 'unknown' ? null : value.stripeMode;
    if (state === 'estimate') amounts.push({ code: 'compensation', label: 'Remaining funded budget', cents: value.grossCents }, { code: 'paralegal_fee', label: 'Estimated platform fee', cents: value.feeCents }, { code: 'net', label: 'Estimated payout', cents: value.netCents });
  } else if (choices.length) {
    state = choices[0].payoutState; stripeMode = choices[0].stripeMode;
    if (choices[0].receiptAvailable) {
      const person = snapshot.people.find(value => id(value._id) === ownerId);
      const value = receipts.projectReceipt({ snapshot, person }, ownerId, choices[0].receiptId);
      if (value.grossCents) amounts.push({ code: 'compensation', label: 'Gross payout', cents: value.grossCents }, { code: 'paralegal_fee', label: 'Platform fee', cents: value.grossCents - value.amountCents });
      amounts.push({ code: 'net', label: 'Net payout', cents: value.amountCents });
    }
  } else if (status === 'disputed' || doc.pausedReason === 'dispute') state = 'needs_review';
  const reviewOpen = state === 'needs_review' && (status === 'disputed' || doc.pausedReason === 'dispute');
  return { currency: currency(doc.currency), state, status: reviewOpen ? 'Payment under LPC review' : labels[state], stripeMode, amounts, receipts: choices, receiptsAreEarlier: status === 'in progress' && !doc.paymentReleased, note: reviewOpen ? 'This Matter is under review. Final payout details are not available.' : notes[state] || null };
}
function attorney(snapshot) {
  const doc = snapshot.cases[0], caseId = id(doc._id), code = currency(doc.currency);
  const summary = attorneySummary.project(snapshot).items.find(value => value.caseId === caseId);
  const rows = financial.rowsFor(snapshot), funding = rows.filter(value => value.type === 'funding' && value.state === 'recorded');
  const amounts = [], gross = doc.lockedTotalAmount ?? doc.totalAmount;
  if (code && money(gross)) amounts.push({ code: 'compensation', label: 'Matter budget', cents: gross });
  if (code && funding.length === 1) {
    if (money(gross) && funding[0].amount >= gross) amounts.push({ code: 'attorney_fee', label: 'Attorney platform fee', cents: funding[0].amount - gross });
    amounts.push({ code: 'funding', label: 'Funding recorded', cents: funding[0].amount });
  }
  if (code && money(summary?.amountHeld)) amounts.push({ code: 'held', label: 'Remaining funds', cents: summary.amountHeld });
  if (code && money(summary?.amountDue)) amounts.push({ code: 'due', label: summary.status === 'pending' ? 'Pending charge' : 'Funding required', cents: summary.amountDue });
  const refunds = rows.filter(value => value.type === 'refund' && value.state === 'recorded');
  if (code && refunds.length) {
    const total = refunds.reduce((sum, value) => sum + value.amount, 0);
    if (!money(total)) fail(413, 'TOTAL_TOO_LARGE');
    amounts.push({ code: 'refund', label: 'Refunds recorded', cents: total });
  }
  const state = summary?.status || (doc.paymentReleased || doc.escrowStatus === 'funded' ? 'needs_review' : 'not_funded');
  const modes = [...new Set(snapshot.operations.filter(value => value.kind === 'funding' && value.status === 'succeeded').map(value => value.stripeMode).filter(value => ['test', 'live'].includes(value)))];
  return { currency: code, state, status: labels[state], stripeMode: funding.length === 1 && modes.length === 1 ? modes[0] : null, amounts, receipts: [], receiptsAreEarlier: false, note: notes[state] || null };
}
async function actor(req) {
  const ownerId = id(req.user), role = req.user?.role, expectedOwnerId = req.query?.expectedOwnerId ?? ownerId;
  if (role === 'attorney') return attorneyAccount.read(req, expectedOwnerId);
  if (role === 'paralegal') return account.read(req, role, expectedOwnerId);
  fail(403, 'RESTRICTED');
}
function sourceRevision(snapshot) {
  // The shared inventory already selects financial Case fields. updatedAt is
  // also changed by unrelated work; retain every selected value except that
  // general timestamp so work edits cannot invalidate unchanged payment data.
  return fingerprint({ ...snapshot, cases: snapshot.cases.map(value => {
    const record = { ...value }; delete record.updatedAt; return record;
  }) });
}
async function read(req, displayedMatter) {
  const owner = await actor(req), ownerId = id(owner), role = req.user.role;
  const first = await financial.loadFinancialInventoryForCases([req.params.caseId]), doc = first.cases[0];
  authorized(doc, ownerId, role);
  // The outer workspace reader must not pair an older assignment/status with
  // a newer financial inventory. Its existing broader access checks still run.
  const context = value => [id(value.attorney), id(value.attorneyId), id(value.paralegal), id(value.paralegalId), normalizeCaseStatus(value.status), value.paymentReleased === true, value.pausedReason || ''];
  if (displayedMatter && fingerprint(context(displayedMatter)) !== fingerprint(context(doc))) fail(409, 'CHANGED');
  const value = role === 'paralegal' ? paralegal(first, ownerId) : attorney(first);
  const verify = async () => {
    const current = await financial.loadFinancialInventoryForCases([req.params.caseId]), fresh = await actor(req);
    authorized(current.cases[0], ownerId, role);
    if (sourceRevision(first) !== sourceRevision(current) || fingerprint(owner) !== fingerprint(fresh)) fail(409, 'CHANGED');
  };
  return { value: { version: 2, ownerId, caseId: id(doc._id), role, revision: fingerprint([ownerId, id(doc._id), role, value]), ...value, receiptHref: null }, verify };
}
module.exports = { read, actor };
