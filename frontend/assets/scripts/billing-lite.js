import { getStoredSession } from "./auth.js";
import { createApiClient } from "./attorney-v2/api-client.mjs";
import { createFinancialHistory } from "./attorney-v2/financial-history.mjs";
import { classifySession } from "./attorney-v2/session-boundary.mjs";
import { createPaymentCard, createPaymentHiringReturn } from "./attorney-v2/payment-card.mjs";
import { createPaymentSetup } from "./attorney-v2/payment-setup.mjs";
import { clearCardSetupRecovery } from "./attorney-v2/payment-setup-recovery.mjs";

const ATTORNEY_ONBOARDING_STEP_KEY = "lpc_attorney_onboarding_step";
let historyList = null, historyController = null, cardHost = null, cardController = null, initialized = false;
function denyBilling() { clearCardSetupRecovery(); cardController?.abort(); historyController?.abort(); cardHost?.replaceChildren(); historyList?.replaceChildren(); window.location.replace('/login.html'); }
function initBillingLite() {
  if (initialized || !document.querySelector('[data-billing-surface]')) return;
  initialized = true; historyList = document.getElementById('historyList'); cardHost = document.querySelector('[data-payment-card-host]');
  cardHost?.addEventListener('click', event => {
    if (!event.target.closest('a,button')) return;
    window.dispatchEvent(new CustomEvent('lpc:attorney-tour-pause')); window.stopAttorneyTour?.();
  });
  consumeCheckoutReturnStatus();
  void Promise.allSettled([loadCardSurface(), loadHistory()]).then(applySettingsEntryContext);
}
async function loadCardSurface() {
  if (!cardHost) return;
  cardController?.abort(); cardController = new AbortController(); const controller = cardController;
  window.addEventListener('pagehide', () => controller.abort(), { once: true });
  const api = createApiClient({ onAuthenticationLost: denyBilling }), cached = getStoredSession()?.user, cachedOwnerId = String(cached?.id || cached?._id || '');
  cardHost.innerHTML = '<h2 id="payment-method-heading">Payment card</h2><p role="status">Checking the saved card…</p>';
  let timedOut = false, ownerId; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  try {
    const session = classifySession(await api.get('/api/auth/me', { signal: controller.signal }));
    if (controller.signal.aborted) return;
    if (session.state !== 'ready' || cachedOwnerId && cachedOwnerId !== session.identity.id) { denyBilling(); return; }
    ownerId = session.identity.id;
  } catch {
    if (controller.signal.aborted && !timedOut) return;
    cardHost.querySelector('[role="status"]').textContent = 'The saved card couldn’t be checked. Try again.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn secondary'; retry.textContent = 'Retry saved card'; retry.addEventListener('click', () => void loadCardSurface()); cardHost.append(retry); return;
  } finally { clearTimeout(timer); }
  if (new URLSearchParams(window.location.search).get('cardSetup') === '1') {
    const privateState = { paymentSetup: {}, hiringReturn: {} };
    const setup = createPaymentSetup({}, { id: ownerId }, { api, signal: controller.signal, privateState });
    const title = setup.querySelector('h1');
    if (title) { const heading = document.createElement('h2'); heading.textContent = title.textContent; title.replaceWith(heading); }
    cardHost.replaceChildren(setup);
    const unfinished = () => Object.values(privateState).some(state => state.dirty || state.busy || state.pending);
    const beforeLeave = event => { if (unfinished()) { event.preventDefault(); event.returnValue = ''; } };
    const changedAccount = event => {
      if (event.key !== 'lpc_user') return;
      const stored = getStoredSession()?.user;
      if (String(stored?.id || stored?._id || '') !== ownerId || stored?.role !== 'attorney') { clearCardSetupRecovery(); denyBilling(); }
    };
    window.addEventListener('beforeunload', beforeLeave);
    window.addEventListener('storage', changedAccount);
    controller.signal.addEventListener('abort', () => { window.removeEventListener('beforeunload', beforeLeave); window.removeEventListener('storage', changedAccount); api.clear(); }, { once: true });
    await setup.readiness;
    return;
  }
  const options = { api, signal: controller.signal, ownerId, routeBase: '/attorney-v2.html' };
  const card = createPaymentCard({ query: new URLSearchParams(window.location.search) }, { ...options, originalSetup: true, onRead: value => {
    try {
      if (value.card) sessionStorage.removeItem(ATTORNEY_ONBOARDING_STEP_KEY);
      else if (sessionStorage.getItem(ATTORNEY_ONBOARDING_STEP_KEY) === 'payment') cardHost.querySelector('#addPaymentMethodBtn')?.classList.add('onboarding-pulse');
    } catch { /* Saved-card verification does not depend on browser storage. */ }
  } });
  const hiring = createPaymentHiringReturn(options); cardHost.replaceChildren(card, hiring); await Promise.all([card.readiness, hiring.readiness]);
}

function applySettingsEntryContext() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  if (params.get("from") !== "settings") return;
  document.getElementById("paymentsSettingsBackLink")?.removeAttribute("hidden");
  const targetId = params.get("settingsTarget") === "billing-history"
    ? "history-heading"
    : "payment-method-heading";
  const target = document.getElementById(targetId);
  if (!target) return;
  target.setAttribute("tabindex", "-1");
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }));
}

function consumeCheckoutReturnStatus() {
  let url;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  const status = String(url.searchParams.get("payment") || "").trim().toLowerCase();
  if (!["success", "cancel"].includes(status)) return;

  showToast(
    "You returned from Checkout. Review the Matter’s current payment status.",
    "info"
  );
  url.searchParams.delete("payment");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function loadHistory() {
  if (!historyList) return;
  historyController?.abort(); historyController = new AbortController();
  const controller = historyController;
  const user = getStoredSession()?.user;
  const cachedOwnerId = String(user?.id || user?._id || '');
  const onDenied = denyBilling;
  const api = createApiClient({ onAuthenticationLost: onDenied });
  window.addEventListener('pagehide', () => controller.abort(), { once: true });
  historyList.innerHTML = '<h2 id="history-heading">Financial history</h2><p role="status">Loading financial history…</p>';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  let ownerId;
  try {
    const session = classifySession(await api.get('/api/auth/me', { signal: controller.signal }));
    if (controller.signal.aborted) return;
    if (session.state !== 'ready' || cachedOwnerId && cachedOwnerId !== session.identity.id) { onDenied(); return; }
    ownerId = session.identity.id;
  } catch (error) {
    if (controller.signal.aborted && !timedOut) return;
    historyList.querySelector('[role="status"]').textContent = 'Financial history could not be verified. Try again.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn secondary'; retry.textContent = 'Retry financial history'; retry.addEventListener('click', () => void loadHistory()); historyList.append(retry);
    return;
  } finally { clearTimeout(timer); }
  // Matter links share this document with the background Payments surface.
  // Their search and selected record belong to the Matter list.
  const historyQuery = new URLSearchParams(/^#cases(?::|$)/.test(window.location.hash) ? '' : window.location.search);
  const history = createFinancialHistory({ query: historyQuery }, { api, signal: controller.signal, ownerId, onDenied, routeBase: '/attorney-v2.html' });
  history.querySelector('h2').id = 'history-heading'; historyList.replaceChildren(history); await history.readiness;
}

function showToast(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initBillingLite, { once: true });
} else {
  initBillingLite();
}
