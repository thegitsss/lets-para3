import { payoutMoney, payoutStates } from './paralegal-financials.mjs';

const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error('Work history could not be verified. Refresh to try again.'); };
const cents = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < .000001 ? Math.round(value * 100) : null;
const date = value => value === null || typeof value === 'string' && Number.isFinite(new Date(value).getTime());
export const historyWorkLabel = (state, reviewKind) => state === 'needs_review' && reviewKind === 'termination' ? 'Termination review' : ({ completed: 'Completed', closed: 'Closed', withdrawn: 'Withdrawn', needs_review: 'Work status needs review' })[state] || 'Work status needs review';
async function verifyOwner(api, ownerId, signal) {
  const payload = await api.get('/api/auth/me', { signal }), user = payload?.user;
  if (!id(ownerId) || String(user?.id || user?._id || '') !== ownerId || user?.role !== 'paralegal' || user?.status !== 'approved' || user.disabled || user.deleted) throw Object.assign(new Error('The workspace account changed.'), { status: 403 });
}
export async function downloadParalegalReceipt(api, receipt, caseId, ownerId, { signal, isCurrent = () => true } = {}) {
  const current = () => { if (signal?.aborted || !isCurrent()) throw new DOMException('View changed', 'AbortError'); };
  current();
  if (!id(caseId) || !id(ownerId) || receipt.receiptId !== 'completion' && !hash(receipt.receiptId) || !hash(receipt.receiptRevision) || !receipt.receiptAvailable) invalid();
  const query = new URLSearchParams({ receiptId: receipt.receiptId, expectedOwnerId: ownerId, receiptRevision: receipt.receiptRevision });
  if (receipt.href !== `/api/payments/receipt/paralegal/${caseId}?${query}`) invalid();
  await verifyOwner(api, ownerId, signal); current();
  const blob = await api.blob(receipt.href, { signal, headers: { Accept: 'application/pdf' } }); current();
  if (blob.type.split(';')[0].toLowerCase() !== 'application/pdf' || !blob.size || blob.size > 10000000 || await blob.slice(0, 5).text() !== '%PDF-') throw new Error('The receipt could not be verified. Try again.');
  current(); await verifyOwner(api, ownerId, signal); current(); return blob;
}

export function readPayoutReceipt(receipt, caseId, ownerId) {
  if (!id(caseId) || !id(ownerId) || receipt.receiptId !== 'completion' && !hash(receipt.receiptId) || !Object.hasOwn(payoutStates, receipt.payoutState) || !date(receipt.recordedAt)) invalid();
  const ready = ['recorded', 'no_payout'].includes(receipt.payoutState);
  if (receipt.receiptAvailable !== ready) invalid();
  if (!ready) { if (receipt.paymentAmount !== null || receipt.href !== null) invalid(); return receipt; }
  const amount = cents(receipt.paymentAmount);
  if (amount === null || payoutMoney(amount, receipt.currency) === 'Unavailable' || !hash(receipt.receiptRevision) || !['test', 'live', null].includes(receipt.stripeMode) || receipt.payoutState === 'recorded' && (amount === 0 || !receipt.stripeMode) || receipt.payoutState === 'no_payout' && amount !== 0) invalid();
  const query = new URLSearchParams({ receiptId: receipt.receiptId, expectedOwnerId: ownerId, receiptRevision: receipt.receiptRevision });
  if (receipt.href !== `/api/payments/receipt/paralegal/${caseId}?${query}`) invalid();
  return receipt;
}

export function readHistoryPage(value, ownerId, { offset = 0, revision = null } = {}) {
  if (!id(ownerId) || value?.ownerId !== ownerId || !hash(value.revision) || revision && value.revision !== revision || !Array.isArray(value.items)) invalid();
  const page = value.page;
  if (!page || !integer(page.total) || page.total > 10000 || !integer(page.limit) || page.limit < 1 || page.limit > 500 || page.offset !== offset || value.items.length !== Math.min(page.limit, page.total - offset)) invalid();
  const end = offset + value.items.length;
  if (page.hasMore !== (end < page.total) || page.nextCursor !== (page.hasMore ? `${value.revision}:${end}` : null)) invalid();
  const seen = new Set();
  for (const item of value.items) {
    if (!id(item.caseId) || seen.has(item.caseId) || !['completed', 'closed', 'withdrawn', 'needs_review'].includes(item.workState) || !date(item.completedAt) || typeof item.title !== 'string' || !Array.isArray(item.receipts) || !item.receipts.length || item.receipts.length > 10000) invalid();
    if (item.reviewState !== undefined && item.reviewState !== null && item.reviewState !== 'open') invalid();
    if (item.reviewKind !== undefined && item.reviewKind !== null && (!['withdrawal', 'termination'].includes(item.reviewKind) || item.reviewState !== 'open' || item.reviewKind === 'termination' && item.workState !== 'needs_review')) invalid();
    seen.add(item.caseId);
    const selections = new Set();
    for (const receipt of item.receipts) {
      if (receipt.receiptId !== 'completion' && !hash(receipt.receiptId) || selections.has(receipt.receiptId) || !Object.hasOwn(payoutStates, receipt.payoutState) || !date(receipt.recordedAt)) invalid();
      selections.add(receipt.receiptId);
      readPayoutReceipt(receipt, item.caseId, ownerId);
    }
    for (const key of ['receiptId', 'payoutState', 'paymentAmount', 'stripeMode', 'receiptAvailable', 'href']) if (item[key] !== item.receipts[0][key]) invalid();
  }
  return value;
}

export async function loadParalegalHistory(api, ownerId, { signal, isCurrent = () => true } = {}) {
  if (!id(ownerId)) invalid();
  let cursor = null, revision = null, offset = 0, total = null;
  const items = [], seen = new Set();
  do {
    if (signal?.aborted || !isCurrent()) throw new DOMException('View changed', 'AbortError');
    const query = new URLSearchParams({ expectedOwnerId: ownerId, limit: '100', reviewContexts: '1' });
    if (cursor) query.set('cursor', cursor);
    const page = readHistoryPage(await api.get(`/api/cases/my-completed?${query}`, { signal }), ownerId, { offset, revision });
    if (signal?.aborted || !isCurrent()) throw new DOMException('View changed', 'AbortError');
    if (total !== null && total !== page.page.total) invalid();
    for (const item of page.items) { if (seen.has(item.caseId)) invalid(); seen.add(item.caseId); items.push(item); }
    total = page.page.total; revision = page.revision; cursor = page.page.nextCursor; offset += page.items.length;
  } while (cursor);
  await verifyOwner(api, ownerId, signal);
  if (signal?.aborted || !isCurrent()) throw new DOMException('View changed', 'AbortError');
  return { ownerId, revision, items };
}

const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const day = value => value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Date unavailable';

export function renderHistoryPayout(item, { api, ownerId, isCurrent = () => true, signal, onRefresh, expanded = false, onExpandedChange, currentSummary = true, showCurrentDate = false, refreshLabel = "Refresh history", onUnavailable } = {}) {
  if (!id(ownerId)) invalid();
  const root = node('div', undefined, 'paralegal-history-payout'); root.dataset.payoutDetails = '';
  if (item.reviewState === 'open') {
    const review = node('p', item.reviewKind === 'termination' ? 'An LPC review is open for this termination request. No decision is recorded.' : 'An LPC review is open for this withdrawal. No decision is recorded.', 'pf-note');
    review.dataset.reviewStatus = 'open'; root.append(review);
  }
  const valid = () => root.isConnected && !signal?.aborted && isCurrent();
  const mixedModes = item.receipts.some(receipt => receipt.stripeMode === 'live') && item.receipts.some(receipt => receipt.stripeMode === 'test');
  const choice = (receipt, index) => {
    const section = node('div', undefined, 'pf-receipt-choice');
    if (index || showCurrentDate || !currentSummary && receipt.recordedAt) section.append(node('p', day(receipt.recordedAt), 'pf-note'));
    if (index || currentSummary) {
    if (receipt.paymentAmount !== null) section.append(node('strong', payoutMoney(cents(receipt.paymentAmount), receipt.currency)));
    section.append(node('span', payoutStates[receipt.payoutState]));
    if (mixedModes && receipt.stripeMode === 'test') section.append(node('small', 'Test record'));
    }
    if (!receipt.receiptAvailable) return section;
    const button = node('button', 'Download receipt'); button.type = 'button'; button.dataset.payoutReceipt = receipt.receiptId;
    if (index) button.setAttribute('aria-label', `Download earlier receipt ${index} · ${day(receipt.recordedAt)}`);
    const status = node('p'); status.setAttribute('role', 'status'); status.hidden = true;
    const cancel = node('button', 'Cancel download'); cancel.type = 'button'; cancel.hidden = true;
    button.addEventListener('click', async () => {
      if (!valid() || button.disabled) return;
      button.disabled = true; button.textContent = 'Preparing receipt…'; status.hidden = true;
      const controller = new AbortController(), abort = () => controller.abort();
      let canceled = false;
      const cancelDownload = () => { canceled = true; abort(); };
      cancel.hidden = false; cancel.addEventListener('click', cancelDownload);
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 30000);
      try {
        const blob = await downloadParalegalReceipt(api, receipt, item.caseId, ownerId, { signal: controller.signal, isCurrent: () => valid() && !canceled });
        if (!valid() || canceled) return;
        const url = URL.createObjectURL(blob), link = node('a');
        link.href = url; link.download = `LPC-payout-${item.caseId}-${receipt.receiptId.slice(0, 12)}.pdf`; link.hidden = true;
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = 'Check your downloads for the receipt.'; status.hidden = false;
      } catch (error) {
        if (!valid()) return;
        if ([401, 403, 404, 409].includes(Number(error.status))) {
          if (onUnavailable) { onUnavailable(error); return; }
          root.replaceChildren(node('p', 'Payout details changed or access is unavailable. Refresh history to continue.'));
          if (onRefresh) { const retry = node('button', refreshLabel); retry.type = 'button'; retry.addEventListener('click', onRefresh); root.append(retry); retry.focus(); }
        } else { status.textContent = canceled ? 'Download canceled.' : error.name === 'AbortError' ? 'The download timed out. Try again.' : 'Receipt unavailable. Try again.'; status.hidden = false; }
      } finally {
        clearTimeout(timeout); signal?.removeEventListener('abort', abort); cancel.removeEventListener('click', cancelDownload); cancel.hidden = true;
        if (button.isConnected) { button.disabled = false; button.textContent = 'Download receipt'; if (canceled) { status.textContent = 'Download canceled.'; status.hidden = false; button.focus(); } }
      }
    });
    section.append(button, cancel, status); return section;
  };
  root.append(choice(item.receipts[0], 0));
  if (item.receipts.length > 1) {
    const details = node('details'), summary = node('summary', `Earlier receipts (${item.receipts.length - 1})`); details.open = expanded; details.append(summary);
    details.addEventListener('toggle', () => { if (root.isConnected) onExpandedChange?.(details.open); });
    item.receipts.slice(1).forEach((receipt, index) => details.append(choice(receipt, index + 1))); root.append(details);
  }
  if (item.receipts.some(receipt => receipt.stripeMode === 'test')) root.append(node('p', 'Test records do not move money.', 'pf-note'));
  if (item.receipts.some(receipt => receipt.stripeMode === 'live' && receipt.payoutState === 'recorded')) root.append(node('p', 'Recorded transfers do not confirm bank arrival.', 'pf-note'));
  return root;
}
