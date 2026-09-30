const financial = require('./attorneyFinancialHistory');
const receipts = require('./paralegalPayoutReceipt');
const receiptHistory = require('./attorneyReceiptHistory');
const account = require('./financialAccountBoundary');
const { fingerprint } = require('./matterDraftRevision');
const { normalizeCaseStatus } = require('../utils/caseState');
const id = value => String(value?._id || value || '');
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fail = () => { throw Object.assign(new Error('The work history changed or needs review. Refresh before continuing.'), { statusCode: 409, code: 'PAYOUT_PROJECTION_CHANGED' }); };

function selectedReceipt(snapshot, doc, person, ownerId, selection, owned) {
  const base = { receiptId: selection, payoutState: 'unconfirmed', paymentAmount: null, stripeMode: null, recordedAt: null, receiptAvailable: false, href: null };
  try {
    const value = receipts.projectReceipt({ snapshot, person }, ownerId, selection);
    const query = new URLSearchParams({ receiptId: selection, expectedOwnerId: ownerId, receiptRevision: value.receiptRevision });
    return { ...base, payoutState: value.payoutState, paymentAmount: value.amountCents / 100, currency: value.currency, stripeMode: value.stripeMode, recordedAt: value.recordedAt, receiptAvailable: true, receiptRevision: value.receiptRevision, href: `/api/payments/receipt/paralegal/${doc._id}?${query}` };
  } catch (error) {
    if (!String(error.publicCode || '').startsWith('PAYOUT_RECEIPT_')) throw error;
    const relevant = owned.filter(item => selection === 'completion' ? !item.evidence.withdrawal && (doc.payoutTransferId ? item.row.transferId === doc.payoutTransferId : item.row.operationKey === `case_payout:${doc._id}`) : item.evidence.withdrawal?.id === selection);
    const payoutState = relevant.length === 1 && ['reversed', 'failed', 'pending'].includes(relevant[0].evidence.state) ? relevant[0].evidence.state : relevant.length || selection !== 'completion' && receiptHistory.inventory(doc).find(entry => entry.id === selection)?.record?.payoutFinalizedAt ? 'needs_review' : 'unconfirmed';
    return { ...base, payoutState };
  }
}

function projectReceipts(snapshot, ownerId, { includeCompletion = false } = {}) {
  const doc = snapshot.cases[0], person = snapshot.people.find(value => id(value._id) === ownerId);
  const entries = receiptHistory.inventory(doc).filter(entry => entry.record && id(entry.record.withdrawnParalegalId) === ownerId);
  const owned = snapshot.payouts.filter(row => id(row.paralegalId) === ownerId).map(row => ({ row, evidence: financial.payoutRecordEvidence(doc, row, snapshot) }));
  return [...(includeCompletion ? ['completion'] : []), ...entries.map(entry => entry.id)].map(selection => selectedReceipt(snapshot, doc, person, ownerId, selection, owned));
}

function project(snapshot, ownerId, now) {
  const people = new Map(snapshot.people.map(person => [id(person._id), person]));
  return snapshot.cases.map(doc => {
    const entries = receiptHistory.inventory(doc).filter(entry => entry.record && id(entry.record.withdrawnParalegalId) === ownerId);
    const assigned = id(doc.paralegal || doc.paralegalId) === ownerId;
    if (!assigned && !entries.length || doc.paralegal && doc.paralegalId && id(doc.paralegal) !== id(doc.paralegalId)) fail();
    const part = { ...snapshot, cases: [doc], payouts: snapshot.payouts.filter(row => id(row.caseId) === id(doc._id)), operations: snapshot.operations.filter(row => id(row.caseId) === id(doc._id)) };
    const status = normalizeCaseStatus(doc.status), terminal = ['completed', 'closed'].includes(status), currentCompletion = assigned && (terminal || doc.paymentReleased);
    const openReviews = (doc.disputes || []).filter(review => String(review.status || 'open').toLowerCase() === 'open');
    const consistentReview = !doc.purgedAt && status === 'disputed' && doc.pausedReason === 'dispute' && openReviews.length === 1
      && !(doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId));
    const terminationReview = consistentReview && assigned && date(doc.paralegalAccessRevokedAt) && date(doc.terminationRequestedAt)
      && doc.terminationStatus === 'disputed' && id(openReviews[0].disputeId || openReviews[0]._id) === id(doc.terminationDisputeId);
    const choices = projectReceipts(part, ownerId, { includeCompletion: currentCompletion || terminationReview });
    if (!choices.length) fail();
    const selected = choices[0], entry = entries.find(value => value.id === selected.receiptId), record = entry?.record, isWithdrawn = !!record;
    const currentWithdrawal = isWithdrawn && id(doc.withdrawnParalegalId) === ownerId && date(doc.payoutFinalizedAt) === date(record.payoutFinalizedAt);
    const source = isWithdrawn ? { ...doc, ...record, status: 'paused', pausedReason: 'paralegal_withdrew', disputeDeadlineAt: currentWithdrawal ? doc.disputeDeadlineAt : null } : doc;
    const disputed = normalizeCaseStatus(doc.status) === 'disputed' || doc.pausedReason === 'dispute' || !!doc.disputes?.some(entry => String(entry.status).toLowerCase() === 'open');
    const reviewState = terminationReview || consistentReview && id(doc.withdrawnParalegalId) === ownerId && !doc.payoutFinalizedAt ? 'open' : null;
    const reviewKind = reviewState ? terminationReview ? 'termination' : 'withdrawal' : null;
    const attorney = people.get(id(doc.attorney || doc.attorneyId));
    return { caseId: id(doc._id), title: doc.title || 'Untitled Matter', attorneyName: [attorney?.firstName, attorney?.lastName].filter(Boolean).join(' ') || doc.attorneyNameSnapshot || 'Attorney', completedAt: terminationReview ? null : isWithdrawn ? date(record.pausedAt) || date(record.payoutFinalizedAt) : date(doc.completedAt), workState: isWithdrawn ? 'withdrawn' : terminal ? status : 'needs_review', isWithdrawn, disputeDeadlineAt: source.disputeDeadlineAt || null, canDispute: currentWithdrawal && !record.payoutFinalizedAt && !disputed && new Date(source.disputeDeadlineAt).getTime() > now.getTime(), isDisputed: disputed, reviewState, reviewKind, payoutFinalizedAt: record?.payoutFinalizedAt || null, payoutFinalizedType: record?.payoutFinalizedType || null, currency: selected.currency || (typeof doc.currency === 'string' ? doc.currency.toUpperCase() : null), ...selected, receipts: choices, source };
  });
}

async function read(req, selectedCases, { now = new Date() } = {}) {
  const owner = await account.read(req, 'paralegal', req.query?.expectedOwnerId), ownerId = id(owner._id), caseIds = selectedCases.map(doc => id(doc._id));
  const first = await financial.loadFinancialInventoryForCases(caseIds);
  if (first.cases.length !== new Set(caseIds).size) fail();
  const items = project(first, ownerId, now), sourceRevision = fingerprint(first);
  // The route calls verify after block/action policy reads, before serializing.
  const verify = async () => {
    const current = await financial.loadFinancialInventoryForCases(caseIds), fresh = await account.read(req, 'paralegal', req.query?.expectedOwnerId);
    if (sourceRevision !== fingerprint(current) || fingerprint(owner) !== fingerprint(fresh)) fail();
  };
  return { ownerId, revision: fingerprint([ownerId, first]), items, verify };
}
module.exports = { read, projectReceipts };
