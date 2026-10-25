const crypto = require('node:crypto');
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function earnings(ownerId, metrics = {}) {
  const asOf = new Date('2026-09-10T15:00:00Z'), total = Math.round(Number(metrics.earningsTotal || 0) * 100);
  return { ownerId, revision: fingerprint(metrics), asOf: asOf.toISOString(), monthStart: '2026-09-01T00:00:00.000Z', last30Start: new Date(asOf.getTime() - 30 * 86400000).toISOString(), currencies: total ? [{ currency: 'USD', stripeMode: 'test', month: Math.round(Number(metrics.earnings || 0) * 100), last30: Math.round(Number(metrics.earningsLast30Days || 0) * 100), total, count: 1, undated: 0 }] : [], count: total ? 1 : 0, undated: 0, requiresReview: 0, states: { recorded: total ? 1 : 0, needs_review: 0, pending: 0, failed: 0, reversed: 0 } };
}
function expected(ownerId) { return { ownerId, revision: fingerprint(ownerId), items: [], currencies: [], requiresReview: 0 }; }
function receipt(caseId, ownerId, changes = {}) {
  const value = { receiptId: 'completion', receiptRevision: fingerprint([caseId, changes]), payoutState: 'recorded', paymentAmount: 81, currency: 'USD', stripeMode: 'test', recordedAt: '2026-09-01T00:00:00Z', receiptAvailable: true, ...changes };
  value.href = value.receiptAvailable ? `/api/payments/receipt/paralegal/${caseId}?${new URLSearchParams({ receiptId: value.receiptId, expectedOwnerId: ownerId, receiptRevision: value.receiptRevision })}` : null;
  return value;
}
function history(ownerId, values, query = new URLSearchParams()) {
  const items = values.map(item => {
    const selected = item.receipts?.[0] || receipt(item.caseId, ownerId, { paymentAmount: item.receiptAvailable ? item.paymentAmount : null, receiptAvailable: !!item.receiptAvailable, payoutState: item.receiptAvailable ? item.paymentAmount === 0 ? 'no_payout' : 'recorded' : 'unconfirmed', currency: (item.currency || 'USD').toUpperCase() });
    return { ...item, workState: item.workState || (item.isWithdrawn ? 'withdrawn' : 'completed'), completedAt: item.completedAt || null, ...selected, receipts: item.receipts || [selected] };
  });
  const revision = fingerprint(items), offset = Number(query.get('cursor')?.split(':')[1] || 0), limit = Number(query.get('limit') || 100), end = Math.min(offset + limit, items.length);
  return { ownerId, revision, items: items.slice(offset, end), page: { total: items.length, limit, offset, hasMore: end < items.length, nextCursor: end < items.length ? `${revision}:${end}` : null } };
}
module.exports = { earnings, expected, receipt, history, fingerprint };
