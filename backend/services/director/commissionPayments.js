const { fingerprint, requestIdValid } = require('../matterDraftRevision');
const { currency, money, date } = require('../adminFinancialReport');
const LIMIT = 1000;
const actions = ['payment', 'reverse', 'legacy_none'];
const unit = row => row.currency === currency(row.currency) && ['live', 'test'].includes(row.stripeMode);
const key = row => `${row.currency}:${row.stripeMode}`;
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value && value <= new Date().toISOString().slice(0, 10);
function error(status, code, message) { return Object.assign(new Error(message), { status, statusCode: status, publicCode: `DIRECTOR_PAYMENT_${code}` }); }
function parse(body) {
  const common = ['requestId', 'revision', 'action', 'note'];
  if (!body || Array.isArray(body) || typeof body !== 'object' || !actions.includes(body.action)) throw error(400, 'INVALID', 'Choose a payment record action.');
  const allowed = [...common, ...(body.action === 'payment' ? ['amountCents', 'currency', 'stripeMode', 'paidDate', 'reference', 'reconcileLegacy'] : body.action === 'reverse' ? ['reverses'] : [])];
  if (Object.keys(body).some(name => !allowed.includes(name)) || !requestIdValid(body.requestId) || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw error(400, 'INVALID', 'Refresh and review the current balance before recording a payment.');
  if (typeof body.note !== 'string' || !body.note.trim() || body.note.length > 500) throw error(400, 'NOTE', 'Enter a note of 1 to 500 characters.');
  const value = { action: body.action, requestId: body.requestId.toLowerCase(), revision: body.revision, note: body.note.trim() };
  if (value.action === 'payment') {
    if (!money(body.amountCents) || body.amountCents === 0 || !unit(body) || !dateOnly(body.paidDate) || typeof body.reference !== 'string' || !body.reference.trim() || body.reference.length > 200 || typeof body.reconcileLegacy !== 'boolean') throw error(400, 'DETAILS', 'Enter a positive amount, currency, mode, payment date and reference.');
    Object.assign(value, { amountCents: body.amountCents, currency: body.currency, stripeMode: body.stripeMode, paidDate: body.paidDate, reference: body.reference.trim(), reconcileLegacy: body.reconcileLegacy });
  }
  if (value.action === 'reverse') {
    if (!requestIdValid(body.reverses)) throw error(400, 'TARGET', 'Choose the original payment record to correct.');
    value.reverses = body.reverses.toLowerCase();
  }
  return value;
}
function legacyFor(record) {
  const saved = record.commissionLegacySnapshot;
  return { claimed: saved?.payoutStatus === 'paid' || record.commissionPayoutStatus === 'paid', snapshot: saved || null, status: record.commissionPayoutStatus || null, paidAt: date(record.commissionPaidAt), adminId: String(record.commissionPaidByAdminId || ''), note: record.commissionPayoutNote || '' };
}
function basisFor(record, earned) {
  return { recordId: String(record._id), directorUserId: String(record.directorUserId), attorneyId: String(record.registeredUserId || ''), attorneyEmail: record.attorneyEmail, firstOutreachSentAt: date(record.firstOutreachSentAt), state: earned.commissionState, currencies: earned.commissionCurrencies, matterCount: earned.commissionableMatterCount, matters: earned.commissionAudit };
}
function project(record, earned) {
  const ledger = record.commissionPaymentLedger === undefined ? [] : record.commissionPaymentLedger;
  const version = record.commissionPaymentVersion ?? 0, legacy = legacyFor(record), basis = basisFor(record, earned);
  const revision = fingerprint([basis, legacy, version, ledger]);
  let corrupt = !Array.isArray(ledger) || ledger.length > LIMIT || !Number.isSafeInteger(version) || version !== ledger.length;
  const entries = new Map(), reversed = new Set();
  if (!corrupt) for (const entry of ledger) {
    const validBase = entry && requestIdValid(entry.id) && !entries.has(entry.id) && actions.includes(entry.action) && /^[a-f0-9]{64}$/.test(entry.requestFingerprint || '') && /^[a-f0-9]{64}$/.test(entry.reviewedRevision || '') && /^[a-f0-9]{64}$/.test(entry.sourceRevision || '') && /^[a-f0-9]{24}$/i.test(String(entry.recordedBy || '')) && date(entry.recordedAt) && typeof entry.note === 'string' && entry.note.trim() && entry.note.length <= 500;
    if (!validBase || entry.action === 'payment' && (!money(entry.amountCents) || !entry.amountCents || !unit(entry) || !dateOnly(entry.paidDate) || typeof entry.reference !== 'string' || !entry.reference.trim() || entry.reference.length > 200 || typeof entry.reconcileLegacy !== 'boolean') || entry.action === 'reverse' && (!entries.has(entry.reverses) || entries.get(entry.reverses).action === 'reverse' || reversed.has(entry.reverses))) { corrupt = true; break; }
    entries.set(entry.id, entry);
    if (entry.action === 'reverse') reversed.add(entry.reverses);
  }
  const active = [...entries.values()].filter(entry => !reversed.has(entry.id));
  const reconciliation = active.filter(entry => entry.action === 'legacy_none' || entry.action === 'payment' && entry.reconcileLegacy);
  if (reconciliation.length > 1 || reconciliation.length && !legacy.claimed) corrupt = true;
  const legacyState = legacy.claimed ? reconciliation.length === 1 ? 'reconciled' : 'needs_review' : 'none';
  const review = corrupt || legacyState === 'needs_review' || earned.commissionState === 'needs_review';
  const groups = new Map();
  for (const group of earned.commissionCurrencies || []) groups.set(key(group), { currency: group.currency, stripeMode: group.stripeMode, earnedCents: group.earnedCents, paidCents: 0 });
  for (const entry of active.filter(entry => entry.action === 'payment')) {
    if (!groups.has(key(entry))) groups.set(key(entry), { currency: entry.currency, stripeMode: entry.stripeMode, earnedCents: earned.commissionState === 'needs_review' ? null : 0, paidCents: 0 });
    const group = groups.get(key(entry)); group.paidCents += entry.amountCents;
    if (!money(group.paidCents)) corrupt = true;
  }
  const balances = [...groups.values()].sort((a, b) => key(a).localeCompare(key(b))).map(group => {
    const uncertain = review || corrupt || !money(group.earnedCents) || group.paidCents > group.earnedCents;
    return { ...group, paidCents: corrupt || legacyState === 'needs_review' ? null : group.paidCents, outstandingCents: uncertain ? null : group.earnedCents - group.paidCents, state: uncertain ? 'needs_review' : 'recorded' };
  });
  const state = review || corrupt || balances.some(group => group.state === 'needs_review') ? 'needs_review' : balances.some(group => group.outstandingCents > 0) ? active.some(entry => entry.action === 'payment') ? 'partial' : 'unpaid' : active.some(entry => entry.action === 'payment') ? 'paid' : 'none';
  return { revision, state, legacyState, corrupt, version, groups: balances, paidCents: corrupt || legacyState === 'needs_review' || balances.length > 1 ? null : balances[0]?.paidCents ?? 0, outstandingCents: state === 'needs_review' || balances.length > 1 ? null : balances[0]?.outstandingCents ?? 0, history: [...entries.values()].map(entry => ({ ...entry, reversed: reversed.has(entry.id) })), legacy: legacy.claimed ? legacy : null };
}
function present(value, { admin = false } = {}) {
  if (!value) return null;
  if (admin) return value;
  return { state: value.state, legacyState: value.legacyState, groups: value.groups, paidCents: value.paidCents, outstandingCents: value.outstandingCents, history: value.history.map(entry => ({ id: entry.id, action: entry.action, amountCents: entry.amountCents, currency: entry.currency, stripeMode: entry.stripeMode, paidDate: entry.paidDate, recordedAt: entry.recordedAt, reversed: entry.reversed, reverses: entry.reverses })) };
}
function outstanding(records) {
  const groups = new Map(); let review = false;
  for (const record of records) {
    const payments = record.commissionPayments;
    if (!payments || payments.state === 'needs_review') review = true;
    for (const balance of payments?.groups || []) {
      if (!groups.has(key(balance))) groups.set(key(balance), { currency: balance.currency, stripeMode: balance.stripeMode, earnedCents: 0 });
      if (balance.outstandingCents === null) review = true;
      else { groups.get(key(balance)).earnedCents += balance.outstandingCents; if (!money(groups.get(key(balance)).earnedCents)) throw error(413, 'TOTAL', 'The commission total requires review.'); }
    }
  }
  const currencies = [...groups.values()].sort((a, b) => key(a).localeCompare(key(b)));
  return { commissionState: review ? 'needs_review' : currencies.some(group => group.earnedCents > 0) ? 'recorded' : 'none', commissionEarnedCents: review || currencies.length > 1 ? null : currencies[0]?.earnedCents ?? 0, commissionCurrencies: review ? [] : currencies, commissionCurrency: currencies.length === 1 ? currencies[0].currency : null, commissionStripeMode: currencies.length === 1 ? currencies[0].stripeMode : null };
}
module.exports = { LIMIT, parse, project, present, outstanding, legacyFor, basisFor, error };
