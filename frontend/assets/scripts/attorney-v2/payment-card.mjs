import { node, button, link, recoveryButton, setRecovery } from './dom.mjs';
import { readDefaultCard, cardLabel, readHiringReturn, hiringReturnHref } from './payment-setup-model.mjs';
import { billingUrl } from './payment-records-model.mjs';
const routePrefix = value => { if (!['', '/attorney-v2.html'].includes(value)) throw new TypeError('Invalid payment route.'); return value; };
async function boundedRead(signal, ownerId, read) {
  const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); const timer = setTimeout(abort, 30000);
  try { return await read({ ownerId, signal: controller.signal }); } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
export function createPaymentCard(route, { api, signal, ownerId, routeBase = '', originalSetup = false, onRead }) {
  const base = routePrefix(routeBase), status = node('p', { role: 'status' }), body = node('div'), billing = node('div');
  let busy = false, portalRequest = null, portalId = null;
  const refresh = recoveryButton('Retry saved card', () => void load());
  const openBilling = button('Open Stripe billing', () => {
    billing.replaceChildren(node('p', { text: 'Review billing settings in Stripe, then return to Payments.' }), node('div', { className: 'av2-actions' }, [button('Continue to Stripe', () => void portal()), button('Stay in Payments', () => { billing.replaceChildren(); openBilling.focus(); })]));
    billing.querySelector('button')?.focus();
  }); openBilling.hidden = true;
  const stop = button('Stop waiting for billing', () => portalRequest?.abort()); stop.hidden = true;
  const setup = link('Manage card', originalSetup ? '/dashboard-attorney.html?cardSetup=1&workspace=legacy#funds' : `${base}#/payments/setup`), heading = node('h2', { text: 'Payment card' });
  if (base) { heading.id = 'payment-method-heading'; setup.id = 'addPaymentMethodBtn'; openBilling.id = 'openPortalBtn'; body.id = 'paymentMethodSummary'; }
  const section = node('section', { 'aria-label': 'Payment card', 'data-payment-card': '', className: 'av2-payments-card' }, [heading, status, body, node('div', { className: 'av2-actions' }, [setup, refresh, openBilling, stop]), billing]);
  function controls() { section.setAttribute('aria-busy', String(busy || Boolean(portalRequest))); refresh.disabled = busy || Boolean(portalRequest); openBilling.disabled = busy || Boolean(portalRequest); stop.hidden = !portalRequest; setRecovery(refresh, section); }
  async function load() {
    if (busy || portalRequest || signal.aborted) return; busy = true; body.replaceChildren(); billing.replaceChildren(); openBilling.hidden = true; status.textContent = 'Checking the saved card…'; section.dataset.state = 'loading'; controls();
    try {
      const raw = await boundedRead(signal, ownerId, options => api.readDefaultCard(options)), value = readDefaultCard(raw); if (signal.aborted) return;
      body.append(node('p', { text: value.bypass ? 'No saved payment card has been verified for this account.' : value.card ? cardLabel(value.card) : 'No default payment card is saved.' }));
      openBilling.hidden = value.bypass || !/^cus_[A-Za-z0-9_]{1,200}$/.test(raw.customerId || ''); status.textContent = route.query.get('billing') === 'return' ? 'The current saved card is shown below.' : ''; section.dataset.state = 'ready'; onRead?.(value);
    } catch { if (!signal.aborted) { status.textContent = 'The saved card couldn’t be checked. Try again.'; section.dataset.state = 'error'; } }
    finally { if (!signal.aborted) { busy = false; controls(); } }
  }
  async function portal() {
    if (portalRequest || signal.aborted) return;
    portalId ||= crypto.randomUUID(); const controller = new AbortController(); portalRequest = controller;
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true }); const timer = setTimeout(abort, 45000); controls(); billing.replaceChildren(node('p', { role: 'status', text: 'Opening Stripe billing…' }));
    try { const target = billingUrl(await api.openAttorneyBilling(portalId, { ownerId, signal: controller.signal }), ownerId); await api.verifyOwner({ ownerId, signal: controller.signal }); if (!controller.signal.aborted && !signal.aborted) window.location.assign(target); }
    catch (error) {
      if (!signal.aborted) billing.replaceChildren(node('p', { role: 'status', text: [401, 403].includes(error.status) || error.kind === 'authentication' ? 'Billing is no longer available to this account.' : error.code === 'PAYMENT_SETUP_PORTAL_CARD_REQUIRED' ? 'Add a payment card before opening billing.' : 'Stripe billing couldn’t open. No Matter funding was requested.' }), ...([401, 403].includes(error.status) || error.kind === 'authentication' ? [] : [button('Try opening billing again', () => void portal())]));
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); portalRequest = null; if (!signal.aborted) controls(); }
  }
  signal.addEventListener('abort', () => { portalRequest?.abort(); section.replaceChildren(); }, { once: true }); section.readiness = load(); return section;
}
export function createPaymentHiringReturn({ api, signal, ownerId, routeBase = '' }) {
  const base = routePrefix(routeBase), section = node('div', { 'data-payment-hiring-return': '' }); section.hidden = true;
  async function load() {
    section.replaceChildren(); section.hidden = true;
    try {
      const value = readHiringReturn(await boundedRead(signal, ownerId, options => api.readPendingHire(options)), ownerId); if (signal.aborted || !value.pending) return;
      const href = hiringReturnHref(value.pending); section.hidden = false;
      section.append(node('p', { text: href ? `Continue hiring: ${value.pending.caseTitle} · ${value.pending.paralegalName}` : 'An earlier application return is saved. Review it before continuing.' }), link(href ? 'Return to this application' : 'Review saved application return', `${base}${href || '#/payments/setup'}`));
    } catch { if (!signal.aborted) { section.hidden = false; section.append(node('p', { role: 'status', text: 'The saved application return couldn’t be checked.' }), button('Check application return', () => void load())); } }
  }
  signal.addEventListener('abort', () => section.replaceChildren(), { once: true }); section.readiness = load(); return section;
}
