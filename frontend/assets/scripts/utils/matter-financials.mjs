import { payoutMoney } from './paralegal-financials.mjs';
import { readPayoutReceipt, renderHistoryPayout } from './paralegal-history.mjs';

const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const states = new Set(['recorded', 'no_payout', 'estimate', 'paused', 'unconfirmed', 'reversed', 'pending', 'failed', 'needs_review', 'active', 'settled', 'funding_needed', 'not_funded']);
const invalid = () => { throw new Error('Matter payment details could not be verified.'); };
export function readMatterFinancials(value, { ownerId, caseId, role }) {
  if (!id(ownerId) || !id(caseId) || !['attorney', 'paralegal'].includes(role) || value?.version !== 2 || value.ownerId !== ownerId || value.caseId !== caseId || value.role !== role || !hash(value.revision) || !states.has(value.state) || typeof value.status !== 'string' || !value.status || !['test', 'live', null].includes(value.stripeMode) || value.note !== null && typeof value.note !== 'string' || value.receiptHref !== null || typeof value.receiptsAreEarlier !== 'boolean' || !Array.isArray(value.amounts) || !Array.isArray(value.receipts) || value.receipts.length > 4001) invalid();
  const codes = new Set(), allowed = role === 'paralegal' ? ['compensation', 'paralegal_fee', 'net'] : ['compensation', 'attorney_fee', 'funding', 'held', 'due', 'refund'];
  for (const amount of value.amounts) {
    if (!allowed.includes(amount.code) || codes.has(amount.code) || typeof amount.label !== 'string' || !amount.label || !integer(amount.cents) || payoutMoney(amount.cents, value.currency) === 'Unavailable') invalid();
    codes.add(amount.code);
  }
  if (role === 'attorney' && value.receipts.length) invalid();
  const seen = new Set();
  for (const receipt of value.receipts) {
    readPayoutReceipt(receipt, caseId, ownerId);
    if (seen.has(receipt.receiptId) || receipt.receiptAvailable && receipt.currency !== value.currency) invalid();
    seen.add(receipt.receiptId);
  }
  if (role === 'paralegal') {
    const find = code => value.amounts.find(amount => amount.code === code)?.cents;
    const net = find('net'), gross = find('compensation'), fee = find('paralegal_fee');
    if (net !== undefined && !['recorded', 'no_payout', 'estimate'].includes(value.state)) invalid();
    if (value.state === 'estimate' && (net === undefined || !value.stripeMode || !value.receiptsAreEarlier)) invalid();
    if (net !== undefined && value.state !== 'no_payout' && (!integer(gross) || !integer(fee) || net + fee !== gross)) invalid();
    if (['recorded', 'no_payout'].includes(value.state) && (net === undefined || value.receipts[0]?.payoutState !== value.state || Math.round(value.receipts[0].paymentAmount * 100) !== net || value.receiptsAreEarlier)) invalid();
    if (value.state === 'no_payout' && (net !== 0 || value.amounts.length !== 1)) invalid();
  }
  return value;
}
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
export function renderMatterPayments(source, { ownerId, caseId, role, api, signal, isCurrent = () => true, onRefresh, onReceipts } = {}) {
  const root = node('div', undefined, 'matter-payment-details'); root.dataset.matterPayments = '';
  const controller = new AbortController();
  const abort = () => { controller.abort(); root.replaceChildren(); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const unavailable = (message = 'Payment details changed or access is unavailable. Refresh to continue.') => {
    controller.abort(); root.replaceChildren(node('p', message)); root.dataset.state = 'unavailable';
    if (onRefresh) { const retry = node('button', 'Refresh payments'); retry.type = 'button'; retry.addEventListener('click', onRefresh); root.append(retry); }
  };
  let value;
  try { value = readMatterFinancials(source, { ownerId, caseId, role }); } catch { unavailable('Payment details could not be verified. Refresh to try again.'); return root; }
  root.dataset.state = value.state;
  if (value.state !== 'estimate') root.append(node('p', value.status, 'matter-payment-state'));
  if (value.amounts.length) {
    const list = node('dl', undefined, 'matter-payment-amounts');
    for (const amount of value.amounts) { const row = node('div'); row.dataset.amountCode = amount.code; row.append(node('dt', amount.label), node('dd', payoutMoney(amount.cents, value.currency))); list.append(row); }
    root.append(list);
  }
  if (role === 'paralegal' && value.receipts.length) {
    if (value.receiptsAreEarlier) root.append(node('h3', 'Earlier payouts'));
    const receipts = renderHistoryPayout({ caseId, receipts: value.receipts }, { api, ownerId, signal: controller.signal, isCurrent, onRefresh, currentSummary: value.receiptsAreEarlier, showCurrentDate: value.receiptsAreEarlier, refreshLabel: 'Refresh payments', onUnavailable: () => unavailable() });
    root.append(receipts);
  } else if (value.stripeMode === 'test') root.append(node('p', 'Test record — no money moved.', 'pf-note'));
  if (role === 'attorney' && onReceipts) { const button = node('button', 'View receipts'); button.type = 'button'; button.addEventListener('click', () => { if (!signal?.aborted && isCurrent()) onReceipts(button); }); root.append(button); }
  // The amount labels already explain the estimate; repeat neither that status
  // nor the unavailable state as a second sentence beneath the same panel.
  if (value.note && !['estimate', 'unconfirmed', 'paused'].includes(value.state)) root.append(node('p', value.note, 'pf-note'));
  root.clear = unavailable;
  return root;
}
