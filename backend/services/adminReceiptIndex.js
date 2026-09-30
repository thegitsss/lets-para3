const report = require('./adminFinancialReport');
const history = require('./attorneyReceiptHistory');
const receipts = require('./paralegalPayoutReceipt');
const { fingerprint } = require('./matterDraftRevision');
const { id, money, date, fail } = report;
async function read(req) {
  const query = req.query || {}, q = String(query.q || query.query || '').trim().toLowerCase();
  const page = query.page === undefined ? 1 : Number(query.page), limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || q.length > 200) fail(400, 'INVALID');
  const current = await report.begin(req), value = current.value, { snapshot } = current.source;
  const person = ownerId => snapshot.people.find(row => id(row._id) === ownerId);
  const name = ownerId => { const p = person(ownerId); return [p?.firstName, p?.lastName].filter(Boolean).join(' ') || 'Name unavailable'; };
  const cases = new Map(snapshot.cases.map(doc => [id(doc._id), doc]));
  const rows = [];
  for (const row of value.allFunding) {
    const doc = cases.get(row.caseId);
    rows.push({ id: `funding:${row.id}`, receiptId: row.stripePaymentIntentId || row.id, selectionId: 'payment', caseId: row.caseId, caseTitle: row.title, party: doc ? name(id(doc.attorney || doc.attorneyId)) : 'Name unavailable', type: 'Funding', amountCents: row.amount, currency: row.currency, stripeMode: row.stripeMode, issuedAt: row.recordedAt, state: row.state, basis: 'original_payment' });
  }
  for (const row of value.allPayouts) {
    rows.push({ id: `payout:${row.id}`, receiptId: row.reference || row.id, selectionId: row.receiptId, caseId: row.caseId, caseTitle: row.title, party: name(row.paralegalId), type: 'Payout', amountCents: row.amount, currency: row.currency, stripeMode: row.stripeMode, issuedAt: row.recordedAt, state: row.state, basis: 'net_payout' });
  }
  for (const doc of snapshot.cases) {
    const caseId = id(doc._id), scoped = { ...snapshot, cases: [doc], payouts: snapshot.payouts.filter(row => id(row.caseId) === caseId), operations: snapshot.operations.filter(row => id(row.caseId) === caseId) };
    for (const entry of history.inventory(doc).filter(entry => entry.record)) {
      const payee = id(entry.record.withdrawnParalegalId); let receipt;
      try { receipt = receipts.projectReceipt({ snapshot: scoped, person: person(payee) }, payee, entry.id); }
      catch (error) { if (![400, 403, 404, 409].includes(error.status)) throw error; }
      rows.push({ id: `withdrawal:${caseId}:${entry.id}`, receiptId: receipt?.payload.receiptId || `${caseId}:${entry.id}`, selectionId: entry.id, caseId, caseTitle: doc.title || 'Untitled Matter', party: name(id(doc.attorney || doc.attorneyId)), type: receipt?.grossCents === 0 ? 'No-payout decision' : 'Withdrawal release', amountCents: receipt ? receipt.grossCents : null, decisionAmountCents: money(entry.record.partialPayoutAmount) ? entry.record.partialPayoutAmount : null, currency: receipt?.currency || report.currency(doc.currency), stripeMode: receipt?.stripeMode || 'unknown', issuedAt: receipt ? receipt.recordedAt : date(entry.record.payoutFinalizedAt), state: receipt ? receipt.payoutState : 'needs_review', basis: receipt?.grossCents === 0 ? 'withdrawal_decision' : 'released_principal' });
    }
  }
  if (rows.length > 10000) fail(413, 'TOO_LARGE');
  const selected = rows.filter(row => !q || [row.receiptId, row.caseTitle, row.party, row.type].some(text => String(text).toLowerCase().includes(q))).sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || '') || a.id.localeCompare(b.id));
  const revision = fingerprint([value.revision, q, selected]);
  if (query.revision !== undefined && query.revision !== revision) fail(409, 'CHANGED');
  await current.verify();
  return { ownerId: value.ownerId, revision, page, limit, total: selected.length, pages: Math.max(1, Math.ceil(selected.length / limit)), items: selected.slice((page - 1) * limit, page * limit) };
}
module.exports = { read };
