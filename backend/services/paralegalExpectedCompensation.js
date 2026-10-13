const financial = require('./attorneyFinancialHistory');
const attorneySummary = require('./attorneyPaymentSummary');
const completion = require('./completionPayoutEvidence');
const { normalizeCaseStatus } = require('../utils/caseState');
const { fingerprint } = require('./matterDraftRevision');
const id = value => String(value?._id || value || '');
const validId = value => /^[a-f0-9]{24}$/i.test(id(value));
const money = value => Number.isSafeInteger(value) && value >= 0;
const changed = () => { throw Object.assign(new Error('The assignment or its financial records changed. Refresh before continuing.'), { statusCode: 409, code: 'PAYOUT_PROJECTION_CHANGED' }); };
function project(snapshot, paralegalId) {
  const ownerId = id(paralegalId), doc = snapshot.cases[0], caseId = id(doc?._id);
  if (!doc || id(doc.paralegal || doc.paralegalId) !== ownerId || doc.paralegal && doc.paralegalId && id(doc.paralegal) !== id(doc.paralegalId) || normalizeCaseStatus(doc.status) !== 'in progress' || doc.archived || doc.paymentReleased) changed();
  const funding = attorneySummary.project(snapshot).items.find(row => row.caseId === caseId);
  const grossCents = funding?.status === 'active' && money(funding.amountHeld) ? funding.amountHeld : null;
  const netCents = grossCents === null ? null : grossCents === 0 ? 0 : completion.amountFor({ ...doc, remainingAmount: grossCents });
  const originalFunding = snapshot.operations.find(row => row.kind === 'funding' && row.status === 'succeeded');
  const stripeMode = ['test', 'live'].includes(originalFunding?.stripeMode) ? originalFunding.stripeMode : 'unknown';
  return { caseId, currency: funding?.currency || null, stripeMode, grossCents, netCents, feeCents: netCents === null || grossCents === null ? null : grossCents - netCents, state: money(netCents) && funding?.currency && stripeMode !== 'unknown' ? 'estimate' : 'needs_review' };
}
async function read(paralegalId, activeCases = []) {
  const ownerId = id(paralegalId), items = [], sources = [];
  if (!validId(ownerId) || !Array.isArray(activeCases) || activeCases.length > 10000) changed();
  for (const selected of activeCases) {
    const caseId = id(selected._id), attorneyId = id(selected.attorney || selected.attorneyId);
    if (!validId(caseId) || !validId(attorneyId) || selected.attorney && selected.attorneyId && id(selected.attorney) !== id(selected.attorneyId)) changed();
    const first = await financial.loadFinancialInventory(attorneyId, caseId);
    const value = project(first, ownerId);
    const revision = fingerprint(first);
    sources.push([attorneyId, caseId, revision]); items.push(value);
  }
  // Recheck every selected Matter after all estimates are prepared, so a change
  // to an earlier assignment during a later read cannot return an old estimate.
  for (const [attorneyId, caseId, revision] of sources) if (revision !== fingerprint(await financial.loadFinancialInventory(attorneyId, caseId))) changed();
  const groups = new Map();
  for (const item of items) {
    if (!item.currency) continue;
    const key = `${item.currency}:${item.stripeMode}`;
    if (!groups.has(key)) groups.set(key, { currency: item.currency, stripeMode: item.stripeMode, netCents: 0, count: 0, requiresReview: 0 });
    const group = groups.get(key); group.count++;
    if (item.state === 'needs_review') group.requiresReview++; else group.netCents += item.netCents;
    if (!money(group.netCents)) changed();
  }
  const currencies = [...groups.values()].map(group => ({ ...group, netCents: group.requiresReview ? null : group.netCents })).sort((a, b) => `${a.currency}:${a.stripeMode}`.localeCompare(`${b.currency}:${b.stripeMode}`));
  const usd = currencies.filter(group => group.currency === 'USD'), unknown = items.some(item => !item.currency);
  const usdCents = unknown || usd.length > 1 || usd.some(group => group.netCents === null) ? null : usd[0]?.netCents || 0;
  return { ownerId, revision: fingerprint([ownerId, sources]), currencies, requiresReview: items.filter(item => item.state === 'needs_review').length, items, usd: usdCents === null ? null : usdCents / 100 };
}
module.exports = { read, project };
