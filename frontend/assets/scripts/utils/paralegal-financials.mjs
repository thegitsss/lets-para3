const amount = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validCurrency = value => {
  try { return typeof value === 'string' && Intl.supportedValuesOf('currency').includes(value) && new Intl.NumberFormat('en-US', { style: 'currency', currency: value }).resolvedOptions().maximumFractionDigits === 2; } catch { return false; }
};
const invalid = () => { throw new Error('Financial details could not be verified. Refresh before continuing.'); };
export const payoutStates = Object.freeze({ recorded: 'Payout recorded', no_payout: 'No payout', pending: 'Payout pending', failed: 'Payout failed', reversed: 'Payout reversed', needs_review: 'Details unavailable', unconfirmed: 'Not verified' });
export const payoutMoney = (cents, currency) => amount(cents) && validCurrency(currency) ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100) : 'Unavailable';

export function readEarningsReport(value, ownerId) {
  if (!ownerId || value?.ownerId !== ownerId || !hash(value.revision) || ![value.asOf, value.monthStart, value.last30Start].every(date => typeof date === 'string' && Number.isFinite(new Date(date).getTime())) || !Array.isArray(value.currencies) || value.currencies.length > 500) invalid();
  const states = ['recorded', 'needs_review', 'pending', 'failed', 'reversed'];
  const now = new Date(value.asOf);
  if (new Date(value.monthStart).getTime() !== Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) || new Date(value.last30Start).getTime() !== now.getTime() - 30 * 86400000) invalid();
  if (!states.every(state => amount(value.states?.[state])) || value.count !== value.states.recorded || value.requiresReview !== value.states.needs_review || !amount(value.undated)) invalid();
  if (value.reviewItems !== undefined) {
    if (!Array.isArray(value.reviewItems) || value.reviewItems.length > 10000) invalid();
    const ids=new Set(),counts={needs_review:0,pending:0,failed:0,reversed:0};
    const reasons=new Set(['matter_unavailable','matter_conflict','currency_unconfirmed','reconciliation_required','transfer_missing','mode_unconfirmed','records_mismatch','pending','failed','reversed']);
    for (const item of value.reviewItems) {
      if (!/^[a-f0-9]{24}$/.test(item.payoutId || '') || !/^[a-f0-9]{24}$/.test(item.caseId || '') || ids.has(item.payoutId) || !Object.hasOwn(counts,item.state) || !reasons.has(item.reason) || item.caseTitle!==null && (typeof item.caseTitle!=='string' || item.caseTitle.length>200) || item.recordedAt!==null && (typeof item.recordedAt!=='string' || !Number.isFinite(Date.parse(item.recordedAt)))) invalid();
      ids.add(item.payoutId);counts[item.state]++;
    }
    if (Object.keys(counts).some(state=>counts[state]!==value.states[state])) invalid();
  }
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
const unit = group => `${group.currency}${group.stripeMode === 'test' ? ' · Test' : group.stripeMode === 'unknown' ? ' · Unconfirmed' : ''}`;

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
  const issues = [['needs_review', 'not confirmed'], ['pending', 'pending'], ['failed', 'failed'], ['reversed', 'reversed']].filter(([state]) => report.states[state]).map(([state, label]) => state === 'needs_review' ? `${report.states[state]} payment${report.states[state] === 1 ? '' : 's'} not confirmed` : `${report.states[state]} ${label}`);
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

// These describe retained records, not a provider review or a bank deposit.
export function payoutPresentation(receipt) {
  const state = receipt.payoutState;
  if (state === 'unconfirmed' && receipt.payoutReason === 'payment_not_released') return {
    label: 'Not released', summary: 'Funded payment',
    reason: 'LPC records the payment as funded, but no release is recorded.',
    next: 'Open the Matter’s payment details. If the payment should already have been released, contact LPC support.',
  };
  const values = {
    unconfirmed: ['No verified payout record', 'LPC cannot find a verified completed payout for this Matter. This does not establish whether money was sent.', 'Open the payment details. If you expected a payout, contact LPC support to investigate.'],
    needs_review: ['LPC could not verify the records', 'A payment record exists, but LPC cannot verify its details against the related records.', 'Contact LPC support to investigate the payment records.'],
    pending: ['Transfer recorded as pending', 'The transfer is recorded as pending. Completion has not been recorded.', 'Check the payment details for updates. Contact LPC support if the transfer remains pending.'],
    failed: ['Transfer recorded as failed', 'The transfer is recorded as failed.', 'Contact LPC support to investigate the failed transfer.'],
    reversed: ['Transfer recorded as reversed', 'The transfer is recorded as reversed and is excluded from payout totals.', 'Open the payment details. Contact LPC support if the reversal is unexpected.'],
  };
  const recordIssues = {
    currency_unconfirmed: ['Currency unavailable', 'LPC cannot verify the currency for this payment.'],
    reconciliation_required: ['Payment records conflict', 'The payment records are flagged for reconciliation. LPC cannot verify the transfer from those records.'],
    transfer_missing: ['Transfer reference missing', 'The payout record is missing a valid Stripe transfer reference.'],
    mode_unconfirmed: ['Live or test status unavailable', 'LPC cannot verify whether this payout is a live payment or a test record.'],
  };
  const issue = state === 'needs_review' && recordIssues[receipt.payoutReason];
  const copy = issue ? [...issue, values.needs_review[2]] : values[state];
  return {label: payoutStates[state], summary: copy?.[0] || '', reason: copy?.[1] || '', next: copy?.[2] || ''};
}
