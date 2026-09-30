const amount = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validCurrency = value => {
  try { return typeof value === 'string' && Intl.supportedValuesOf('currency').includes(value) && new Intl.NumberFormat('en-US', { style: 'currency', currency: value }).resolvedOptions().maximumFractionDigits === 2; } catch { return false; }
};
const invalid = () => { throw new Error('Financial details could not be verified. Refresh before continuing.'); };
export const payoutStates = Object.freeze({ recorded: 'Payout recorded', no_payout: 'No payout', pending: 'Payout pending', failed: 'Payout failed', reversed: 'Payout reversed', needs_review: 'Payout needs review', unconfirmed: 'Payout not confirmed' });
export const payoutMoney = (cents, currency) => amount(cents) && validCurrency(currency) ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100) : 'Unavailable';

export function readEarningsReport(value, ownerId) {
  if (!ownerId || value?.ownerId !== ownerId || !hash(value.revision) || ![value.asOf, value.monthStart, value.last30Start].every(date => typeof date === 'string' && Number.isFinite(new Date(date).getTime())) || !Array.isArray(value.currencies) || value.currencies.length > 500) invalid();
  const states = ['recorded', 'needs_review', 'pending', 'failed', 'reversed'];
  const now = new Date(value.asOf);
  if (new Date(value.monthStart).getTime() !== Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) || new Date(value.last30Start).getTime() !== now.getTime() - 30 * 86400000) invalid();
  if (!states.every(state => amount(value.states?.[state])) || value.count !== value.states.recorded || value.requiresReview !== value.states.needs_review || !amount(value.undated)) invalid();
  const keys = new Set(); let count = 0, undated = 0;
  for (const group of value.currencies) {
    const key = `${group.currency}:${group.stripeMode}`;
    if (!validCurrency(group.currency) || !['test', 'live'].includes(group.stripeMode) || keys.has(key) || !amount(group.total) || !amount(group.count) || !group.count || !amount(group.undated) || group.undated > group.count) invalid();
    if (group.undated ? group.month !== null || group.last30 !== null : !amount(group.month) || !amount(group.last30) || group.month > group.total || group.last30 > group.total) invalid();
    keys.add(key); count += group.count; undated += group.undated;
  }
  if (count !== value.count || undated !== value.undated) invalid();
  return value;
}
export function readExpectedCompensation(value, ownerId) {
  if (!ownerId || value?.ownerId !== ownerId || !hash(value.revision) || !amount(value.requiresReview) || !Array.isArray(value.items) || !Array.isArray(value.currencies) || value.currencies.length > 500) invalid();
  const keys = new Set(), grouped = new Map(), cases = new Set(); let reviews = 0;
  for (const item of value.items) {
    if (typeof item.caseId !== 'string' || !/^[a-f0-9]{24}$/.test(item.caseId) || cases.has(item.caseId) || !['estimate', 'needs_review'].includes(item.state) || !['test', 'live', 'unknown'].includes(item.stripeMode) || item.currency !== null && !validCurrency(item.currency)) invalid();
    cases.add(item.caseId);
    if (item.state === 'needs_review') reviews++;
    else if (!validCurrency(item.currency) || item.stripeMode === 'unknown' || ![item.netCents, item.grossCents, item.feeCents].every(amount) || item.netCents + item.feeCents !== item.grossCents) invalid();
    if (!item.currency) { if (item.state !== 'needs_review') invalid(); continue; }
    const key = `${item.currency}:${item.stripeMode}`, group = grouped.get(key) || { count: 0, requiresReview: 0, netCents: 0 };
    group.count++; if (item.state === 'needs_review') group.requiresReview++; else group.netCents += item.netCents;
    grouped.set(key, group);
  }
  if (reviews !== value.requiresReview || grouped.size !== value.currencies.length) invalid();
  for (const group of value.currencies) {
    const key = `${group.currency}:${group.stripeMode}`;
    if (!validCurrency(group.currency) || !['test', 'live', 'unknown'].includes(group.stripeMode) || keys.has(key) || !amount(group.count) || !amount(group.requiresReview) || group.requiresReview > group.count || (group.requiresReview ? group.netCents !== null : !amount(group.netCents)) || group.stripeMode === 'unknown' && group.netCents !== null) invalid();
    keys.add(key);
    const expected = grouped.get(key);
    if (!expected || group.count !== expected.count || group.requiresReview !== expected.requiresReview || group.netCents !== (expected.requiresReview ? null : expected.netCents)) invalid();
  }
  return value;
}
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const unit = group => `${group.currency}${group.stripeMode === 'test' ? ' · Test' : group.stripeMode === 'unknown' ? ' · Mode unverified' : ''}`;

export function renderEarningsReport(report, { expected = null, onRetry } = {}) {
  const root = node('div', undefined, 'paralegal-financials'); root.dataset.payoutTotals = '';
  if (!report) {
    root.dataset.state = 'unavailable'; root.append(node('p', 'Payout totals unavailable.'));
    if (onRetry) { const retry = node('button', 'Refresh payouts'); retry.type = 'button'; retry.addEventListener('click', onRetry); root.append(retry); }
    return root;
  }
  root.dataset.state = 'ready';
  if (!report.currencies.length) root.append(node('p', 'No payouts recorded.'));
  else {
    const table = node('table'), caption = node('caption', 'Recorded payouts by currency and payment mode'); caption.className = 'pf-sr-only'; table.append(caption);
    const head = node('thead'), header = node('tr');
    for (const label of ['Currency', 'This month', 'Last 30 days', 'All time']) { const cell = node('th', label); cell.scope = 'col'; header.append(cell); }
    head.append(header); table.append(head);
    const body = node('tbody');
    for (const group of report.currencies) {
      const row = node('tr'), label = node('th', unit(group)); label.scope = 'row'; row.append(label);
      for (const [key, title] of [['month', 'This month'], ['last30', 'Last 30 days'], ['total', 'All time']]) { const cell = node('td', payoutMoney(group[key], group.currency)); cell.dataset.period = title; row.append(cell); }
      body.append(row);
    }
    table.append(body); root.append(table);
    root.append(node('p', report.undated ? 'Some payout dates are missing, so their period totals are unavailable.' : 'Periods use UTC.', 'pf-note'));
  }
  const issues = [['needs_review', 'need review'], ['pending', 'pending'], ['failed', 'failed'], ['reversed', 'reversed']].filter(([state]) => report.states[state]).map(([state, label]) => `${report.states[state]} ${report.states[state] === 1 && state === 'needs_review' ? 'needs review' : label}`);
  if (issues.length) root.append(node('p', issues.join(' · '), 'pf-record-status'));
  if (report.currencies.some(group => group.stripeMode === 'test')) root.append(node('p', 'Test records do not move money.', 'pf-note'));
  if (report.currencies.some(group => group.stripeMode === 'live')) root.append(node('p', 'Recorded transfers do not confirm arrival in your bank.', 'pf-note'));
  if (expected?.items.length) {
    const section = node('section', undefined, 'pf-estimates'); section.append(node('h3', 'Estimated from active work'));
    for (const group of expected.currencies) section.append(node('p', `${unit(group)} · ${payoutMoney(group.netCents, group.currency)}`));
    if (expected.requiresReview) section.append(node('p', `${expected.requiresReview} ${expected.requiresReview === 1 ? 'estimate needs' : 'estimates need'} review.`));
    section.append(node('p', 'Based on current funded work; not a scheduled payout.', 'pf-note')); root.append(section);
  }
  if (!expected) root.append(node('p', 'Active-work estimate unavailable.', 'pf-note'));
  return root;
}
