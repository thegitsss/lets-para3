import { secureFetch } from '../auth.js';
import { commissionMoney, commissionPaymentDate } from './director-financials.mjs';
import { activateDialogFocus, deactivateDialogFocus } from './dialog-focus.js';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unitKey = group => `${group.currency}:${group.stripeMode}`;
export function paymentHistory(record, { controls = false, heading = true } = {}) {
  const payment = record?.commissionPayments;
  if (!payment) return '';
  if (!payment.history.length && payment.legacyState !== 'needs_review') return controls && !payment.corrupt && payment.state !== 'needs_review' && payment.groups.some(group => group.outstandingCents > 0)
    ? `<button type="button" class="btn secondary" data-payout-id="${escapeHTML(record.id)}">Record payment</button>` : '';
  const balances = payment.groups.map(group => `<div><dt>Recorded paid</dt><dd>${escapeHTML(commissionMoney(group.paidCents, group.currency, group.stripeMode, 'Unknown'))}</dd></div><div><dt>Outstanding</dt><dd>${escapeHTML(commissionMoney(group.outstandingCents, group.currency, group.stripeMode, 'Unknown'))}</dd></div>`).join('');
  const history = payment.history.map(entry => `<li><div><strong>${entry.action === 'reverse' ? 'Record reversed' : entry.action === 'legacy_none' ? 'No historical payment confirmed' : escapeHTML(commissionMoney(entry.amountCents, entry.currency, entry.stripeMode))}</strong>${entry.reversed ? ' · Reversed' : ''}${entry.action === 'payment' ? `<span>${escapeHTML(commissionPaymentDate(entry.paidDate))}${entry.reference ? ' · ' + escapeHTML(entry.reference) : ''}</span>` : ''}${entry.note ? `<span>${escapeHTML(entry.note)}</span>` : ''}</div>${controls && entry.action !== 'reverse' && !entry.reversed && !payment.corrupt ? `<button type="button" class="text-btn" data-payment-reverse="${escapeHTML(entry.id)}" data-payment-record="${escapeHTML(record.id)}">Reverse record</button>` : ''}</li>`).join('');
  return `<section class="payment-history">${heading ? '<h3>Payment history</h3>' : ''}${payment.legacyState === 'needs_review' ? '<p>A previous paid flag has no verified amount. Review its payment history.</p>' : payment.state === 'needs_review' ? '<p>Payment balance needs review.</p>' : ''}${balances ? `<dl class="payment-balances">${balances}</dl>` : ''}${history ? `<ul class="payment-entries">${history}</ul>` : ''}${controls && !payment.corrupt && (payment.legacyState === 'needs_review' || payment.groups.some(group => group.outstandingCents > 0)) ? `<button type="button" class="btn secondary" data-payout-id="${escapeHTML(record.id)}">${payment.legacyState === 'needs_review' ? 'Review historical payment' : 'Record payment'}</button>` : ''}</section>`;
}
export function createPaymentDialog({ account, onSaved, onDenied }) {
  const panel = document.createElement('dialog'); panel.id = 'paymentPanel'; panel.className = 'audit-panel'; panel.hidden = true; panel.setAttribute('inert', ''); panel.setAttribute('aria-labelledby', 'paymentTitle');
  panel.innerHTML = '<div class="audit-dialog payment-dialog"><div class="audit-head"><h2 id="paymentTitle">Record payment</h2><button type="button" class="btn secondary" id="closePaymentBtn">Close</button></div><div id="paymentBody"></div></div>';
  document.body.append(panel);
  const body = panel.querySelector('#paymentBody'), drafts = new Map(); let sequence = 0, active = null, busy = false;
  function close() {
    if (busy) return;
    sequence++; panel.close(); panel.hidden = true; panel.setAttribute('inert', ''); deactivateDialogFocus(panel);
    if (!active) return;
    const currentTrigger = active.trigger?.isConnected && !active.trigger.disabled && !active.trigger.closest('[inert], [hidden]') ? active.trigger : null;
    const record = CSS.escape(active.recordId);
    const replacement = !active.reverses && document.querySelector(`#commissionPayablesBody [data-payout-id="${record}"]:not(:disabled)`);
    (currentTrigger || replacement || document.querySelector(`#commissionPayablesBody [data-audit-id="${record}"]`) || document.getElementById('refreshBtn'))?.focus();
  }
  panel.querySelector('#closePaymentBtn').addEventListener('click', close);
  panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
  async function read(recordId) {
    const response = await secureFetch(account.url(`/api/admin/directors/records/${encodeURIComponent(recordId)}/audit`), { headers: { Accept: 'application/json' } });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(response.status >= 500 ? 'Payment records are unavailable. Try again.' : value.error || 'Payment records are unavailable.'), { status: response.status });
    account.verify(value); return value.record;
  }
  async function open(recordId, trigger, reverses = '') {
    const seq = ++sequence; active = { recordId, reverses, trigger, key: `${recordId}:${reverses}` }; busy = false;
    panel.hidden = false; panel.removeAttribute('inert'); if (!panel.open) panel.showModal();
    activateDialogFocus(panel, { returnFocus: trigger, initialFocus: panel.querySelector('#closePaymentBtn'), onEscape: close });
    body.innerHTML = '<p role="status">Loading payment history…</p>';
    try {
      const record = await read(recordId); if (seq !== sequence) return;
      const draft = drafts.get(active.key), found = draft && record.commissionPayments.history.some(entry => entry.id === draft.requestId);
      if (found) { drafts.delete(active.key); await saved(record); return; }
      render(record, draft);
    } catch (error) {
      if (seq !== sequence) return;
      if (error.status === 403) { close(); onDenied(error); return; }
      body.innerHTML = `<p role="alert">${escapeHTML(error.message)}</p><button type="button" class="btn secondary" data-payment-reload>Try again</button>`;
    }
  }
  function render(record, draft, reviewedDraft = null) {
    const payment = record.commissionPayments, reversing = Boolean(active.reverses), legacy = payment.legacyState === 'needs_review';
    document.getElementById('paymentTitle').removeAttribute('role');
    document.getElementById('paymentTitle').textContent = reversing ? 'Reverse payment record' : legacy ? 'Review historical payment' : 'Record payment';
    if (payment.corrupt) { body.innerHTML = '<p role="alert">Payment history requires review before it can be changed.</p>'; return; }
    const original = payment.history.find(entry => entry.id === active.reverses);
    if (reversing && (!original || original.reversed || original.action === 'reverse')) { body.innerHTML = '<p role="alert">This record has already changed. Close and refresh the audit.</p>'; return; }
    active.record = record;
    const options = payment.groups.filter(group => group.outstandingCents > 0).map(group => `<option value="${escapeHTML(unitKey(group))}">${escapeHTML(commissionMoney(group.outstandingCents, group.currency, group.stripeMode))} available</option>`).join('');
    const currencies = legacy ? Intl.supportedValuesOf('currency').filter(currency => new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits === 2).map(currency => `<option>${currency}</option>`).join('') : '';
    body.innerHTML = `<p class="payment-context"><strong>${escapeHTML(record.attorneyName || record.attorneyEmail)}</strong><br>${escapeHTML(record.directorEmail)}</p>${legacy && payment.legacy?.note ? `<p class="payment-legacy-note">Previous note: ${escapeHTML(payment.legacy.note)}</p>` : ''}${reversing ? `<p>This corrects LPC's payment history. Handle any transfer or refund separately.</p><p>${original.action === 'payment' ? escapeHTML(commissionMoney(original.amountCents, original.currency, original.stripeMode)) + ' · ' + escapeHTML(commissionPaymentDate(original.paidDate)) : 'No historical payment confirmed'}</p>` : '<p>Record a payment already sent outside LPC.</p>'}
      <form id="commissionPaymentForm"><fieldset><div class="payment-fields">
      ${legacy && !reversing ? '<label>Historical payment<select id="paymentAction"><option value="payment">Sent</option><option value="legacy_none">Not sent</option></select></label>' : ''}
      ${!reversing ? `<div id="paymentAmountFields" class="payment-fields">${legacy ? `<label>Currency<select id="paymentCurrency" required><option value="">Select</option>${currencies}</select></label><label>Mode<select id="paymentMode" required><option value="">Select</option><option value="live">Live</option><option value="test">Test</option></select></label>` : `<label>Balance<select id="paymentUnit" required>${payment.groups.filter(group => group.outstandingCents > 0).length !== 1 ? '<option value="">Choose a balance</option>' : ''}${options}</select></label>`}
      <label>Amount<input id="paymentAmount" inputmode="decimal" type="text" required maxlength="18"></label><label>Date sent<input id="paymentDate" type="date" required max="${new Date().toISOString().slice(0, 10)}"></label><label>Payment reference<input id="paymentReference" type="text" required maxlength="200"></label></div>` : ''}
      <label>${reversing ? 'Reason for correction' : 'Note'}<textarea id="paymentNote" required maxlength="500" rows="3"></textarea></label></div></fieldset>
      <p id="paymentStatus" role="status"></p><div class="payment-actions"><button class="btn primary" type="submit" id="savePaymentBtn">${reversing ? 'Save correction' : 'Save payment record'}</button><button class="btn secondary" type="button" data-payment-reload hidden>Refresh balance</button></div></form>`;
    const form = body.querySelector('form');
    const values = draft || reviewedDraft;
    if (values) {
      const set = (id, value) => { const input = body.querySelector('#' + id); if (input) input.value = value ?? ''; };
      set('paymentAction', values.action); set('paymentUnit', `${values.currency}:${values.stripeMode}`); set('paymentCurrency', values.currency); set('paymentMode', values.stripeMode); set('paymentAmount', values.amountCents / 100); set('paymentDate', values.paidDate); set('paymentReference', values.reference); set('paymentNote', values.note);
      if (draft) { form.querySelector('fieldset').disabled = true; body.querySelector('#paymentStatus').textContent = 'The previous result is unconfirmed. Retry checks the same request.'; body.querySelector('#savePaymentBtn').textContent = 'Retry record'; }
    }
    const action = body.querySelector('#paymentAction');
    const changeAction = () => { const none = action?.value === 'legacy_none', fields = body.querySelector('#paymentAmountFields'); if (fields) { fields.hidden = none; fields.querySelectorAll('input,select').forEach(input => { input.required = !none; }); } body.querySelector('#savePaymentBtn').textContent = none ? 'Confirm no payment' : reversing ? 'Save correction' : draft ? 'Retry record' : 'Save payment record'; };
    action?.addEventListener('change', changeAction); changeAction();
    form.addEventListener('submit', submit);
  }
  async function saved(record) {
    await onSaved(record);
    const title = document.getElementById('paymentTitle'); title.textContent = 'Payment history saved'; title.setAttribute('role', 'status');
    body.innerHTML = paymentHistory(record, { heading: false });
  }
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget, status = body.querySelector('#paymentStatus'), button = body.querySelector('#savePaymentBtn');
    let command = drafts.get(active.key);
    if (!command) {
      const value = id => body.querySelector('#' + id)?.value || '', action = active.reverses ? 'reverse' : value('paymentAction') || 'payment';
      command = { requestId: crypto.randomUUID(), revision: active.record.commissionPayments.revision, action, note: value('paymentNote') };
      if (action === 'reverse') command.reverses = active.reverses;
      if (action === 'payment') {
        const raw = value('paymentAmount').trim(), parts = raw.split('.'), amountCents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
        if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isSafeInteger(amountCents) || amountCents <= 0) { status.textContent = 'Enter a positive amount with no more than two decimal places.'; return; }
        const [currency, stripeMode] = value('paymentUnit').split(':');
        Object.assign(command, { amountCents, currency: currency || value('paymentCurrency'), stripeMode: stripeMode || value('paymentMode'), paidDate: value('paymentDate'), reference: value('paymentReference'), reconcileLegacy: active.record.commissionPayments.legacyState === 'needs_review' });
      }
      drafts.set(active.key, command);
    }
    busy = true; form.querySelector('fieldset').disabled = true; button.disabled = true; panel.querySelector('#closePaymentBtn').disabled = true; status.textContent = 'Saving payment history…';
    try {
      const response = await secureFetch(account.url(`/api/admin/directors/records/${encodeURIComponent(active.recordId)}/commission-payout`), { method: 'PATCH', body: command, headers: { Accept: 'application/json' } });
      const result = await response.json(); if (!response.ok) throw Object.assign(new Error(response.status >= 500 ? 'The result could not be confirmed. Retry checks the same request.' : result.error || 'Payment history could not be saved.'), { status: response.status });
      account.verify(result); drafts.delete(active.key); await saved(result.record);
    } catch (error) {
      if (error.status === 403) { busy = false; close(); onDenied(error); return; }
      status.textContent = error.status ? error.message : 'The result could not be confirmed. Retry checks the same request.';
      if (error.status === 400) { drafts.delete(active.key); form.querySelector('fieldset').disabled = false; }
      if (error.status === 409) { button.hidden = true; body.querySelector('[data-payment-reload]').hidden = false; }
      else if (error.status === 413) { drafts.delete(active.key); button.hidden = true; }
      else button.textContent = error.status === 400 ? 'Save payment record' : 'Retry record';
    } finally { busy = false; button.disabled = false; panel.querySelector('#closePaymentBtn').disabled = false; }
  }
  body.addEventListener('click', async event => {
    if (!event.target.closest('[data-payment-reload]') || busy) return;
    const target = { ...active }, draft = drafts.get(target.key);
    try { const record = await read(target.recordId); if (draft && record.commissionPayments.history.some(entry => entry.id === draft.requestId)) { drafts.delete(target.key); await saved(record); return; } drafts.delete(target.key); render(record, null, draft); }
    catch (error) { body.querySelector('[role="status"], [role="alert"]').textContent = error.message; }
  });
  return { open, clear() { drafts.clear(); busy = false; close(); body.replaceChildren(); } };
}

export function createPaymentHistoryReader() {
  const panel = document.createElement('dialog'); panel.id = 'directorPaymentPanel'; panel.className = 'director-payment-reader'; panel.setAttribute('aria-labelledby', 'directorPaymentTitle');
  panel.innerHTML = '<div class="director-payment-reader-head"><h2 id="directorPaymentTitle">Payment history</h2><button type="button" id="directorPaymentClose">Close</button></div><div id="directorPaymentBody"></div>';
  document.body.append(panel); let recordId = '';
  const closeButton = panel.querySelector('#directorPaymentClose'), body = panel.querySelector('#directorPaymentBody');
  function close() { panel.close(); deactivateDialogFocus(panel); if (document.activeElement === document.body && recordId) document.querySelector(`[data-payment-history="${CSS.escape(recordId)}"]`)?.focus(); }
  closeButton.addEventListener('click', close); panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return {
    open(record, trigger) {
      recordId = record.id;
      body.innerHTML = `<p class="payment-context"><strong>${escapeHTML(record.attorneyName || 'Attorney')}</strong><br>${escapeHTML(record.attorneyEmail)}</p>${paymentHistory(record, { heading: false })}`;
      if (!panel.open) panel.showModal();
      activateDialogFocus(panel, { returnFocus: trigger, initialFocus: closeButton, onEscape: close });
    },
    clear() { close(); body.replaceChildren(); recordId = ''; },
  };
}
