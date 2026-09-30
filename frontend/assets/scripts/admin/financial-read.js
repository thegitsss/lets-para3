import { secureFetch } from '../auth.js';

const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
let openedOwner = null;
function unavailable(message, status = 503) {
  return Object.assign(new Error(message || 'Financial records are unavailable. Refresh to try again.'), { status });
}
async function json(url, options = {}) {
  const response = await secureFetch(url, { ...options, headers: { ...options.headers, Accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  if ([401, 403].includes(response.status)) window.dispatchEvent(new CustomEvent('admin:financial-account-changed'));
  if (response.status === 409) window.dispatchEvent(new CustomEvent('admin:financial-source-changed'));
  if (!response.ok || !body || typeof body !== 'object') throw unavailable(body?.error || body?.msg, response.status);
  return body;
}
async function owner(signal) {
  const body = await json('/api/auth/me', { signal }), user = body.user, id = user?.id || user?._id;
  if (!validId(id) || user.role !== 'admin' || user.status !== 'approved' || user.disabled || user.deleted) {
    window.dispatchEvent(new CustomEvent('admin:financial-account-changed'));
    throw unavailable('This financial view is no longer available to this account.', 403);
  }
  return id;
}
async function currentOwner(signal) {
  const value = await owner(signal);
  if (openedOwner && openedOwner !== value) {
    window.dispatchEvent(new CustomEvent('admin:financial-account-changed'));
    throw unavailable('The signed-in account changed. Reload this page before continuing.', 403);
  }
  openedOwner = value;
  return value;
}
export async function readFinancial(url, options = {}) {
  const first = await currentOwner(options.signal), target = new URL(url, location.origin);
  if (target.origin !== location.origin) throw unavailable();
  const expected = target.searchParams.get('expectedOwnerId');
  if (expected && expected !== first) throw unavailable('The signed-in account changed. Refresh before continuing.', 403);
  target.searchParams.set('expectedOwnerId', first);
  const body = await json(target.pathname + target.search, options), metadata = body.ownerId ? body : body.financial;
  if (metadata?.ownerId !== first || !/^[a-f0-9]{64}$/.test(metadata?.revision || '')) throw unavailable('The financial response could not be verified. Refresh to try again.');
  if (await currentOwner(options.signal) !== first) {
    window.dispatchEvent(new CustomEvent('admin:financial-account-changed'));
    throw unavailable('The signed-in account changed. Refresh before continuing.', 403);
  }
  return body;
}
export function money(value, currency = 'USD') {
  if (!Number.isSafeInteger(value) || typeof currency !== 'string' || !/^[A-Z]{3}$/i.test(currency)) return 'Needs review';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(value / 100); } catch { return 'Needs review'; }
}
export async function downloadFinancialExport(url, { isCurrent = () => true, signal } = {}) {
  const first = await currentOwner(signal), target = new URL(url, location.origin);
  if (target.origin !== location.origin || target.pathname !== '/api/admin/workspace/finance/export' || target.searchParams.get('expectedOwnerId') !== first || !/^[a-f0-9]{64}$/.test(target.searchParams.get('revision') || '')) throw unavailable('Refresh the record list before exporting.');
  const response = await secureFetch(target.pathname + target.search, { signal, headers: { Accept: 'text/csv' } });
  if (!response.ok) {
    if (response.status === 409) window.dispatchEvent(new CustomEvent('admin:financial-source-changed'));
    if ([401, 403].includes(response.status)) window.dispatchEvent(new CustomEvent('admin:financial-account-changed'));
    const body = await response.json().catch(() => null); throw unavailable(body?.error || body?.msg, response.status);
  }
  if (!response.headers.get('content-type')?.startsWith('text/csv') || response.headers.get('X-LPC-Financial-Owner') !== first || response.headers.get('X-LPC-Financial-Revision') !== target.searchParams.get('revision')) throw unavailable('The export could not be verified. Refresh the record list.');
  const text = await response.text();
  if (!text.startsWith('"id","kind",') || await currentOwner(signal) !== first || !isCurrent()) throw unavailable('The account or selected records changed. Refresh before exporting.');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' }), objectUrl = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = objectUrl; link.download = `lpc-${target.searchParams.get('kind') || 'operations'}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
export const providerLabel = value => value === 'test' ? 'Test record' : value === 'live' ? 'Live record' : 'Mode needs review';
export const stateLabel = value => ({ recorded: 'Recorded', no_payout: 'No payout', needs_review: 'Needs review', unconfirmed: 'Unconfirmed', active: 'Funded', settled: 'Settled', funding_needed: 'Funding needed', not_funded: 'Not funded', pending: 'Pending', failed: 'Failed', reversed: 'Reversed', canceled: 'Canceled', decision_recorded: 'Decision recorded' })[value] || 'Needs review';
export function unitAmount(report, currency, stripeMode) {
  if (!report || report.requiresReview) return null;
  if (typeof currency !== 'string' || !['test', 'live'].includes(stripeMode)) return report.count === 0 ? 0 : null;
  const group = report.currencies?.find(group => group.currency === currency && group.stripeMode === stripeMode);
  return group ? group.requiresReview ? null : group.totalRecorded : Array.isArray(report.currencies) ? 0 : null;
}
export function reportAmount(report, fallbackCurrency = 'USD') {
  if (!report || report.requiresReview) return 'Needs review';
  if (report.currencies?.length > 1) return 'Separate totals';
  const group = report.currencies?.[0];
  return money(group ? group.totalRecorded : report.count === 0 ? 0 : null, group?.currency || fallbackCurrency);
}
