import { api, escapeHTML as esc, date, onAdminPrivateInvalidation } from './shared.js';
import { readFinancial, money, providerLabel } from './financial-read.js';

export function initPaymentAttention() {
  const panel = document.createElement('div');
  panel.className = 'panel'; panel.id = 'adminPaymentAttentionPanel'; panel.hidden = true;
  panel.innerHTML = '<h2>Payment event alerts</h2><p>Review the saved event and current provider evidence. Resolving a recovered processing alert does not move money or dismiss a substantive payment issue.</p><button type="button" class="btn secondary" data-payment-alert-refresh>Refresh payment alerts</button><p role="status" data-payment-alert-status></p><div data-payment-alert-list></div><div data-payment-alert-detail></div>';
  const status = panel.querySelector('[data-payment-alert-status]'), list = panel.querySelector('[data-payment-alert-list]'), detail = panel.querySelector('[data-payment-alert-detail]');
  let generation = 0, controller = new AbortController();
  const clear = (message = '') => { generation++; controller.abort(); list.replaceChildren(); detail.replaceChildren(); status.textContent = message; };
  onAdminPrivateInvalidation(() => clear('Your Admin access changed. Refresh or sign in before continuing.'));
  window.addEventListener('admin:financial-account-changed', () => clear('The signed-in account changed. Refresh or sign in before continuing.'));
  window.addEventListener('admin:financial-source-changed', () => clear('Payment records changed. Refresh the alerts before continuing.'));
  window.addEventListener('beforeunload', () => clear());
  window.addEventListener('pagehide', () => clear());
  const current = seq => seq === generation && !controller.signal.aborted;
  const begin = () => { controller.abort(); controller = new AbortController(); return ++generation; };
  const unavailable = (error, seq) => { if (!current(seq)) return; clear([401, 403].includes(error.status) ? 'Your Admin access changed. Refresh or sign in before continuing.' : error.message || 'The payment alert could not be verified. Refresh to try again.'); };
  async function load() {
    const seq = begin(); list.replaceChildren(); detail.replaceChildren(); status.textContent = 'Loading payment event alerts…';
    try {
      const value = await readFinancial('/api/admin/workspace/finance/payment-alerts', { signal: controller.signal });
      if (!current(seq)) return;
      if (!Array.isArray(value.items)) throw new Error('The payment alerts could not be verified.');
      status.textContent = value.items.length ? `${value.items.length} payment event ${value.items.length === 1 ? 'alert needs' : 'alerts need'} review.` : 'No payment event alerts need review.';
      list.innerHTML = value.items.map(row => `<article class="admin-detail-fold"><h3>${esc(row.type)}</h3><p>${esc(row.status)} · ${esc(row.category)} · ${esc(providerLabel(row.stripeMode))}</p><p>Last attempt: ${esc(date(row.lastAttemptAt))}</p><details><summary>Event reference</summary><code>${esc(row.eventId)}</code></details><button type="button" class="btn secondary" data-payment-alert-review="${esc(row.id)}">Review payment event</button></article>`).join('');
      return true;
    } catch (error) { unavailable(error, seq); return false; }
  }
  async function review(id) {
    const seq = begin(); detail.replaceChildren(); status.textContent = 'Verifying current provider and accounting evidence…';
    try {
      const value = await readFinancial(`/api/admin/workspace/finance/payment-alerts/${id}/review`, { signal: controller.signal });
      if (!current(seq)) return;
      detail.innerHTML = `<section aria-label="Payment event review"><h3 tabindex="-1">Payment event review</h3>${value.caseTitle ? `<p>${esc(value.caseTitle)}</p>` : ''}<p>${esc(value.reason)}</p>${value.evidence ? `<p>Settled refund: ${esc(money(value.evidence.refundCents, value.evidence.currency))} · ${esc(providerLabel(value.evidence.stripeMode))}</p>` : ''}${value.canResolve ? '<button type="button" class="btn primary" data-payment-alert-resolve>Resolve recovered processing alert</button>' : ''}<p role="status" data-payment-alert-resolution-status></p></section>`;
      status.textContent = 'Current payment event evidence reviewed.';
      detail.querySelector('h3').focus({ preventScroll: true });
      const button = detail.querySelector('[data-payment-alert-resolve]');
      if (!button) return;
      const body = { expectedOwnerId: value.ownerId, revision: value.revision, requestId: crypto.randomUUID() };
      button.addEventListener('click', async () => {
        if (!current(seq) || button.disabled) return;
        button.disabled = true; detail.querySelector('[data-payment-alert-resolution-status]').textContent = 'Resolving the reviewed processing alert…';
        try {
          const result = await api(`/api/admin/workspace/finance/payment-alerts/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!current(seq)) return;
          // Recheck the document-pinned financial owner after a late successful
          // response, including a legitimate sibling-page cookie replacement.
          await readFinancial('/api/admin/workspace/finance/payment-alerts', { signal: controller.signal });
          if (!current(seq)) return;
          if (result.ownerId !== value.ownerId || !result.recorded) throw new Error('The resolution receipt could not be verified. Refresh the alert.');
          const loaded = await load();
          if (!loaded) return;
          status.textContent = result.resolved ? 'Recovered processing alert resolved. No payment was changed.' : 'Your resolution was recorded, but this event needs a new payment review.';
        } catch (error) {
          if (!current(seq)) return;
          if ([401, 403, 409].includes(error.status)) { unavailable(error, seq); return; }
          detail.querySelector('[data-payment-alert-resolution-status]').textContent = 'The result could not be confirmed. Try again to check this same resolution.';
          button.disabled = false;
        }
      });
    } catch (error) { unavailable(error, seq); }
  }
  panel.querySelector('[data-payment-alert-refresh]').addEventListener('click', () => void load());
  list.addEventListener('click', event => { const button = event.target.closest('[data-payment-alert-review]'); if (button) void review(button.dataset.paymentAlertReview); });
  return { panel, load, clear };
}
