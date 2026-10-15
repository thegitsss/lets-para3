import { requireAuth, getStoredSession } from '../auth.js';
const amount = value => Number.isSafeInteger(value) && value >= 0;
const validCurrency = value => {
  try { return typeof value === 'string' && Intl.supportedValuesOf('currency').includes(value) && new Intl.NumberFormat('en-US', { style: 'currency', currency: value }).resolvedOptions().maximumFractionDigits === 2; } catch { return false; }
};
export function commissionMoney(cents, currency, mode, unavailable = 'Needs review') {
  if (!amount(cents) || !validCurrency(currency) || !['test', 'live'].includes(mode)) return unavailable;
  return `${new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(cents / 100)}${mode === 'test' ? ' · Test' : ''}`;
}
export function commissionLabel(value = {}) {
  if (value.commissionState === 'needs_review') return 'Needs review';
  const groups = value.commissionCurrencies;
  if (!Array.isArray(groups)) return 'Unavailable';
  if (!groups.length) return value.commissionState === 'none' && value.commissionEarnedCents === 0 ? 'No commission' : 'Needs review';
  return groups.map(group => commissionMoney(group.earnedCents, group.currency, group.stripeMode)).join('\n');
}
export function commissionCount(value) { return amount(value) ? value.toLocaleString() : 'Needs review'; }
export function commissionPaymentLabel(record = {}) {
  if (record.commissionPayments) return { needs_review: 'Payment to verify', paid: 'Paid', partial: 'Partly paid', unpaid: 'Unpaid', none: '—' }[record.commissionPayments.state] || 'Unavailable';
  if (record.commissionPayoutStatus === 'paid') return 'Payment to verify';
  if (record.commissionState === 'needs_review') return '—';
  if (record.commissionCurrencies?.some(group => group.stripeMode === 'test')) return 'Test record';
  return record.commissionEarnedCents > 0 ? 'Unpaid' : '—';
}
export function commissionPaymentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—';
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
}
export function commissionAccount(role) {
  const first = requireAuth(role), ownerId = String(first.user?.id || first.user?._id || '');
  function verify(payload) {
    const current = getStoredSession();
    if (!/^[a-f0-9]{24}$/i.test(ownerId) || String(current.user?.id || current.user?._id || '') !== ownerId || current.role !== role || current.user?.disabled || current.user?.deleted || payload && payload.ownerId !== ownerId) {
      throw Object.assign(new Error('The signed-in account changed. Reload this page to continue.'), { status: 403 });
    }
  }
  function url(path) { verify(); const value = new URL(path, location.origin); value.searchParams.set('expectedOwnerId', ownerId); return value.pathname + value.search; }
  return { ownerId, verify, url };
}
