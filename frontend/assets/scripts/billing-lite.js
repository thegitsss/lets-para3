import { secureFetch } from "./auth.js";
import { createElements, mountPaymentElement, confirmSetup } from "./payments.js";

function initBillingLite() {
  const surface = document.querySelector("[data-billing-surface]");
  if (!surface) return;

  const historyList = document.getElementById("historyList");
  const portalBtn = document.getElementById("openPortalBtn");
  const financeAlertsEl = document.getElementById("financeAlerts");
  const escrowTableBody = document.getElementById("escrowTableBody");
  const refreshEscrowsBtn = document.getElementById("refreshEscrowsBtn");
  const currencyFormatter = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  const paymentSummaryEl = document.getElementById("paymentMethodSummary");
  const paymentFormEl = document.getElementById("paymentMethodForm");
  const paymentElementHost = document.getElementById("paymentMethodElement");
  const paymentErrorsEl = document.getElementById("paymentMethodErrors");
  const paymentModalEl = document.getElementById("paymentMethodModal");
  const addCardBtn = document.getElementById("addPaymentMethodBtn");
  const replaceCardBtn = document.getElementById("replacePaymentMethodBtn");
  const saveCardBtn = document.getElementById("savePaymentMethodBtn");
  const cancelCardBtn = document.getElementById("cancelPaymentMethodBtn");

  let cachedEscrows = [];
  let openDrawerEl = null;
  let openDrawerTrigger = null;
  let setupElements = null;
  let setupPaymentElement = null;

  const STRIPE_JS_SRC = "https://js.stripe.com/v3/";
  let stripeJsPromise = null;

  (async function initBillingSurface() {
    console.log("billing-lite loaded");
    bindEvents();
    await loadPaymentMethodStatus();
    const activeItems = await loadActiveEscrows(true);
    await Promise.all([loadFinanceAlerts(activeItems), loadHistory()]);
  })();

function bindEvents() {
  portalBtn?.addEventListener("click", openBillingPortal);
  historyList?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-case-id]");
    if (!btn) return;
    const caseId = btn.getAttribute("data-case-id");
    if (!caseId) return;
    viewCase(caseId);
  });
  refreshEscrowsBtn?.addEventListener("click", () => {
    loadActiveEscrows(true, { syncAlerts: true });
  });
  escrowTableBody?.addEventListener("click", handleEscrowClick);
  financeAlertsEl?.addEventListener("click", handleAlertAction);
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openDrawerEl) {
      const trigger = openDrawerTrigger || openDrawerEl.querySelector(".action-toggle");
      closeActionDrawers();
      trigger?.focus();
    }
  });
  addCardBtn?.addEventListener("click", () => startPaymentMethodFlow());
  replaceCardBtn?.addEventListener("click", () => startPaymentMethodFlow());
  saveCardBtn?.addEventListener("click", () => savePaymentMethod());
  cancelCardBtn?.addEventListener("click", () => cancelPaymentFlow());
}

async function loadActiveEscrows(showLoading = false, { syncAlerts = false } = {}) {
  if (!escrowTableBody) return [];
  if (showLoading) {
    escrowTableBody.innerHTML = `<tr><td colspan="6" class="history-empty">Loading active escrows…</td></tr>`;
  }
  try {
    const res = await secureFetch("/api/payments/escrow/active", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => ({}));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    cachedEscrows = items;
    if (!items.length) {
      escrowTableBody.innerHTML = `<tr><td colspan="6" class="history-empty">No funds currently held in escrow.</td></tr>`;
    } else {
      escrowTableBody.innerHTML = items.map(renderEscrowRow).join("");
    }
    if (syncAlerts) {
      await loadFinanceAlerts(items);
    }
    return items;
  } catch (err) {
    console.warn("Unable to load active escrows", err);
    escrowTableBody.innerHTML = `<tr><td colspan="6" class="history-empty error">Unable to load active escrow records.</td></tr>`;
    return [];
  }
}

function renderEscrowRow(entry = {}) {
  const caseName = escapeHtml(entry.caseName || entry.caseTitle || entry.title || "Case");
  const paralegal = escapeHtml(entry.paralegalName || "Paralegal pending");
  const amount = formatCurrency(entry.amountHeld ?? entry.amount ?? entry.totalAmount);
  const funded = formatDate(entry.fundedAt || entry.updatedAt);
  const statusLabel = formatStatusLabel(entry.status || "");
  const caseId = String(entry.caseId || entry.id || "");
  const safeCaseId = String(caseId || "case").replace(/[^a-z0-9_-]/gi, "");
  const menuId = `escrow-actions-${safeCaseId || "case"}`;
  return `
    <tr>
      <td>${caseName}</td>
      <td>${paralegal}</td>
      <td>${amount}</td>
      <td>${funded}</td>
      <td><span class="pill">${statusLabel}</span></td>
      <td>
        <div class="action-drawer" data-case-id="${caseId}">
          <button type="button" class="action-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
            Actions <span aria-hidden="true">⋯</span>
          </button>
          <div class="action-menu" id="${menuId}" role="menu">
            <button type="button" data-escrow-action="view" data-case-id="${caseId}">View Case</button>
            <button type="button" data-escrow-action="release" data-case-id="${caseId}">Approve &amp; Release Funds</button>
            <button type="button" data-escrow-action="messages" data-case-id="${caseId}">Message Paralegal</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

async function loadFinanceAlerts(activeItems) {
  if (!financeAlertsEl) return;
  financeAlertsEl.innerHTML = `<div class="finance-alert"><div><div class="alert-title">Checking finance alerts…</div><p>Give us a moment.</p></div></div>`;
  try {
    const [summaryRes, pendingRes] = await Promise.all([
      secureFetch("/api/payments/summary", { headers: { Accept: "application/json" } }),
      secureFetch("/api/payments/escrow/pending", { headers: { Accept: "application/json" } }),
    ]);
    if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`);
    if (!pendingRes.ok) throw new Error(`HTTP ${pendingRes.status}`);
    const summary = await summaryRes.json().catch(() => ({}));
    const pendingPayload = await pendingRes.json().catch(() => ({}));
    const pendingItems = Array.isArray(pendingPayload?.items) ? pendingPayload.items : [];
    const activeList = Array.isArray(activeItems) ? activeItems : cachedEscrows;
    const alerts = buildFinanceAlerts({ summary, active: activeList, pending: pendingItems });
    renderFinanceAlerts(alerts);
  } catch (err) {
    console.warn("Unable to load finance alerts", err);
    financeAlertsEl.innerHTML = `<div class="finance-alert"><div><div class="alert-title">Finance alerts unavailable</div><p class="muted">Please refresh the page or try again shortly.</p></div></div>`;
  }
}

function buildFinanceAlerts({ active = [], pending = [] } = {}) {
  const alerts = [];
  if (pending.length) {
    const first = pending[0];
    const count = pending.length;
    const label = count === 1 ? first.caseName || "This case" : `${count} cases`;
    const summary = count === 1 ? `${first.paralegalName || "Your paralegal"} is ready to start.` : "Fund escrow to unblock your assignments.";
    alerts.push({
      id: `fund-${first.caseId}`,
      type: "fund",
      title: `${label} ${count === 1 ? "needs" : "need"} funding`,
      body: summary,
      actions: [
        first.checkoutUrl
          ? { type: "link", label: "Fund Now", href: first.checkoutUrl, external: true, primary: true }
          : { type: "view", label: "View Case", caseId: first.caseId, primary: true },
        { type: "view", label: "View Case", caseId: first.caseId },
      ],
    });
  }
  const releaseCandidates = active.filter((item) => isReleaseCandidate(item.status)).slice(0, 3);
  releaseCandidates.forEach((item) => {
    alerts.push({
      id: `release-${item.caseId}`,
      type: "release",
      title: `Approve & release funds for ${item.caseName || "a case"}`,
      body: "The paralegal has wrapped. Approve & release funds to pay them.",
      actions: [
        { type: "release", label: "Approve & Release Funds", caseId: item.caseId, primary: true },
        { type: "view", label: "View Case", caseId: item.caseId },
        { type: "messages", label: "Message Paralegal", caseId: item.caseId },
      ],
    });
  });
  return alerts;
}

function renderFinanceAlerts(alerts = []) {
  if (!financeAlertsEl) return;
  if (!alerts.length) {
    financeAlertsEl.innerHTML = `
      <div class="finance-alert calm">
        <div>
          <div class="alert-title">No urgent finance actions</div>
          <p>You're caught up on escrow, funding, and payouts.</p>
        </div>
      </div>`;
    return;
  }
  financeAlertsEl.innerHTML = alerts.map(renderFinanceAlert).join("");
}

function renderFinanceAlert(alert) {
  const actionsHtml = (alert.actions || [])
    .map((action) => {
      if (action.type === "link" && action.href) {
        const target = action.external ? ' target="_blank" rel="noopener"' : "";
        return `<a class="pill-btn ${action.primary ? "primary" : ""}" href="${action.href}"${target}>${escapeHtml(action.label)}</a>`;
      }
      const attrs = [
        `class="pill-btn ${action.primary ? "primary" : ""}"`,
        `data-alert-action="${action.type}"`,
        action.caseId ? `data-case-id="${action.caseId}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button type="button" ${attrs}>${escapeHtml(action.label)}</button>`;
    })
    .join("");
  return `
    <article class="finance-alert ${alert.type || ""}">
      <div>
        <div class="alert-title">${escapeHtml(alert.title)}</div>
        <p>${escapeHtml(alert.body)}</p>
      </div>
      ${actionsHtml ? `<div class="alert-actions">${actionsHtml}</div>` : ""}
    </article>
  `;
}

function handleEscrowClick(event) {
  const toggle = event.target.closest(".action-toggle");
  if (toggle) {
    const drawer = toggle.closest(".action-drawer");
    toggleActionDrawer(drawer);
    return;
  }
  const actionBtn = event.target.closest("[data-escrow-action]");
  if (actionBtn) {
    const action = actionBtn.dataset.escrowAction;
    const caseId = actionBtn.dataset.caseId;
    closeActionDrawers();
    if (action === "view") {
      viewCase(caseId);
    } else if (action === "messages") {
      jumpToMessages(caseId);
    } else if (action === "release") {
      releaseEscrowCase(caseId, actionBtn);
    }
  }
}

function handleAlertAction(event) {
  const btn = event.target.closest("[data-alert-action]");
  if (!btn) return;
  const action = btn.dataset.alertAction;
  const caseId = btn.dataset.caseId;
  if (action === "view") {
    viewCase(caseId);
  } else if (action === "messages") {
    jumpToMessages(caseId);
  } else if (action === "release") {
    releaseEscrowCase(caseId, btn);
  }
}

function toggleActionDrawer(drawer) {
  if (!drawer) return;
  const willOpen = openDrawerEl !== drawer;
  closeActionDrawers();
  if (willOpen) {
    drawer.classList.add("open");
    drawer.querySelector(".action-toggle")?.setAttribute("aria-expanded", "true");
    openDrawerEl = drawer;
    openDrawerTrigger = drawer.querySelector(".action-toggle");
  }
}

function closeActionDrawers() {
  document.querySelectorAll(".action-drawer.open").forEach((drawer) => {
    drawer.classList.remove("open");
    drawer.querySelector(".action-toggle")?.setAttribute("aria-expanded", "false");
  });
  openDrawerEl = null;
  openDrawerTrigger = null;
}

function handleGlobalClick(event) {
  if (event.target.closest(".action-drawer")) return;
  closeActionDrawers();
}

async function loadHistory() {
  if (!historyList) return;
  historyList.innerHTML = `<div class="history-empty">Loading payment history…</div>`;
  try {
    const res = await secureFetch("/api/payments/history", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => ({}));
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.history)
      ? payload.history
      : Array.isArray(payload)
      ? payload
      : [];
    if (!items.length) {
      historyList.innerHTML = `<div class="history-empty">No completed payments yet.</div>`;
      return;
    }
    historyList.innerHTML = items.map(renderHistoryCard).join("");
  } catch (err) {
    console.warn("Unable to load payment history", err);
    historyList.innerHTML = `<div class="history-empty error">Unable to load payment history right now.</div>`;
  }
}

async function openBillingPortal() {
  if (!portalBtn) return;
  const originalText = portalBtn.textContent;
  portalBtn.disabled = true;
  portalBtn.textContent = "Opening…";
  try {
    const res = await secureFetch("/api/payments/portal", { method: "POST" });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok || !data?.url) {
      throw new Error(data?.error || "Unable to open the Stripe portal right now.");
    }
    window.location.href = data.url;
  } catch (err) {
    console.error("Billing portal error", err);
    showToast(err.message || "Unable to open the Stripe portal.", "error");
    portalBtn.disabled = false;
    portalBtn.textContent = originalText;
  }
}

function ensureStripeJs() {
  if (window.Stripe) return Promise.resolve();
  if (!stripeJsPromise) {
    stripeJsPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${STRIPE_JS_SRC}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () =>
          reject(new Error("We couldn't load the secure payment form. Please allow js.stripe.com or disable ad blockers and try again."))
        );
        return;
      }
      const script = document.createElement("script");
      script.src = STRIPE_JS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("We couldn't load the secure payment form. Please allow js.stripe.com or disable ad blockers and try again."));
      document.head.appendChild(script);
    });
  }
  return stripeJsPromise;
}

async function loadPaymentMethodStatus() {
  if (!paymentSummaryEl) return null;
  paymentSummaryEl.innerHTML = `<p class="muted">Checking saved payment method…</p>`;
  try {
    const res = await secureFetch("/api/payments/payment-method/default", { headers: { Accept: "application/json" } });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
    renderPaymentMethodSummary(payload);
    return payload;
  } catch (err) {
    console.warn("Unable to load default payment method", err);
    paymentSummaryEl.innerHTML = `<p class="muted">Unable to load saved payment method right now.</p>`;
    return null;
  }
}

function renderPaymentMethodSummary(payload = {}) {
  if (!paymentSummaryEl) return;
  const pm = payload.paymentMethod;
  if (pm) {
    const brand = (pm.brand || pm.type || "Card").toString().toUpperCase();
    const last4 = pm.last4 || "••••";
    const exp =
      pm.exp_month && pm.exp_year
        ? ` · Expires ${String(pm.exp_month).padStart(2, "0")}/${pm.exp_year}`
        : "";
    paymentSummaryEl.innerHTML = `
      <div class="pm-row">
        <div class="pm-icon" aria-hidden="true">💳</div>
        <div>
          <div class="pm-label">Primary payment method</div>
          <div class="pm-meta">${escapeHtml(brand)} ending in ${escapeHtml(last4)}${escapeHtml(exp)}</div>
          <div class="pm-helper">Used to fund escrow securely. Funds are released only after approval.</div>
        </div>
      </div>
    `;
    addCardBtn?.setAttribute("hidden", "hidden");
    replaceCardBtn?.removeAttribute("hidden");
  } else {
    paymentSummaryEl.innerHTML = "";
    addCardBtn?.removeAttribute("hidden");
    replaceCardBtn?.setAttribute("hidden", "hidden");
  }
}

function resetPaymentElement() {
  if (setupPaymentElement?.destroy) {
    setupPaymentElement.destroy();
  }
  setupPaymentElement = null;
  setupElements = null;
  if (paymentElementHost) paymentElementHost.innerHTML = "";
}

async function startPaymentMethodFlow() {
  if (!paymentFormEl || !paymentElementHost) return;
  if (paymentErrorsEl) paymentErrorsEl.textContent = "";
  if (paymentModalEl) {
    paymentModalEl.classList.remove("hidden");
    paymentModalEl.setAttribute("aria-hidden", "false");
  }
  paymentFormEl.hidden = false;
  paymentElementHost.innerHTML = `<p class="muted">Loading secure card form…</p>`;
  addCardBtn?.setAttribute("aria-busy", "true");
  replaceCardBtn?.setAttribute("aria-busy", "true");
  try {
    await ensureStripeJs();
    const session = await createSetupIntentSession();
    resetPaymentElement();
    setupElements = await createElements(session.clientSecret, { appearance: { theme: "flat" } });
    setupPaymentElement = mountPaymentElement(setupElements, paymentElementHost);
    paymentElementHost.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    console.warn("Unable to start payment method flow", err);
    if (paymentErrorsEl) paymentErrorsEl.textContent = err?.message || "Unable to start card setup.";
    showToast(err?.message || "Unable to start card setup.", "error");
    if (paymentElementHost) {
      paymentElementHost.innerHTML = `<p class="muted">${escapeHtml(err?.message || "Unable to load the secure card form right now.")}</p>`;
    }
  } finally {
    addCardBtn?.removeAttribute("aria-busy");
    replaceCardBtn?.removeAttribute("aria-busy");
  }
}

async function createSetupIntentSession() {
  const res = await secureFetch("/api/payments/payment-method/setup-intent", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload?.clientSecret) {
    throw new Error(payload?.error || "Unable to start card setup.");
  }
  return payload;
}

async function savePaymentMethod() {
  if (!setupElements) {
    showToast("Start by adding a card.", "info");
    return;
  }
  if (paymentErrorsEl) paymentErrorsEl.textContent = "";
  saveCardBtn?.setAttribute("disabled", "disabled");
  saveCardBtn?.setAttribute("aria-busy", "true");
  try {
    await ensureStripeJs();
    const { error, setupIntent } = await confirmSetup(setupElements);
    if (error) throw new Error(error.message || "Unable to save card.");
    const pmId = setupIntent?.payment_method;
    if (!pmId) throw new Error("No payment method returned from Stripe.");
    await setDefaultPaymentMethod(pmId);
    showToast("Card saved and set as default.", "success");
    await loadPaymentMethodStatus();
    cancelPaymentFlow();
  } catch (err) {
    if (paymentErrorsEl) paymentErrorsEl.textContent = err?.message || "Unable to save card.";
  } finally {
    saveCardBtn?.removeAttribute("disabled");
    saveCardBtn?.removeAttribute("aria-busy");
  }
}

async function setDefaultPaymentMethod(paymentMethodId) {
  const res = await secureFetch("/api/payments/payment-method/default", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: { paymentMethodId },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Unable to save payment method.");
  }
  return payload;
}

function cancelPaymentFlow() {
  resetPaymentElement();
  if (paymentFormEl) paymentFormEl.hidden = true;
  if (paymentErrorsEl) paymentErrorsEl.textContent = "";
  if (paymentModalEl) {
    paymentModalEl.classList.add("hidden");
    paymentModalEl.setAttribute("aria-hidden", "true");
  }
}

function renderHistoryCard(entry = {}) {
  const caseName = escapeHtml(entry.caseName || entry.caseTitle || entry.title || "Case");
  const jobTitle = escapeHtml(entry.jobTitle || caseName);
  const paralegal = escapeHtml(entry.paralegalName || "Assigned Paralegal");
  const amount = formatCurrency(entry.jobAmount ?? entry.amount ?? entry.totalAmount);
  const datePaid = formatDate(entry.releaseDate || entry.paidOutAt || entry.completedAt);
  const receipt = sanitizeUrl(entry.stripeReceiptUrl || entry.receiptUrl || entry.receipt);
  const receiptLink = receipt
    ? `<a class="pill-btn" href="${receipt}" target="_blank" rel="noopener">View Stripe Receipt</a>`
    : '<span class="muted">Receipt unavailable</span>';
  const caseId = String(entry.caseId || entry.id || "");
  return `
    <article class="history-card">
      <div class="history-primary">
        <div class="case-name">${caseName}</div>
        <div class="job-title">${jobTitle}</div>
        <div class="paralegal-name">Paralegal: ${paralegal}</div>
      </div>
      <div class="history-meta">
        <div class="meta-item">
          <span>Amount</span>
          <strong>${amount}</strong>
        </div>
        <div class="meta-item">
          <span>Date Paid</span>
          <strong>${datePaid}</strong>
        </div>
      </div>
      <div class="history-actions">
        ${receiptLink}
        <button type="button" data-case-id="${caseId}">View Case</button>
      </div>
    </article>
  `;
}

function releaseEscrowCase(caseId, trigger) {
  if (!caseId) return;
  const confirmRelease = window.confirm("Release funds for this case?");
  if (!confirmRelease) return;
  const btn = trigger;
  if (btn) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  }
  secureFetch("/api/payments/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseId }),
  })
    .then(async (res) => {
      let payload = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (!res.ok) throw new Error(payload?.error || payload?.msg || "Unable to release funds.");
      showToast("Funds released successfully.", "success");
      void loadActiveEscrows(true, { syncAlerts: true });
    })
    .catch((err) => {
      console.error("Release escrow error", err);
      showToast(err.message || "Unable to release funds.", "error");
    })
    .finally(() => {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
      }
    });
}

function jumpToMessages(caseId) {
  if (!caseId) {
    showToast("Open a case to view messages.", "info");
    return;
  }
  window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}#messages`;
}

function formatCurrency(value) {
  const cents = normalizeToCents(value);
  return currencyFormatter.format(cents / 100);
}

function normalizeToCents(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.-]/g, "");
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    if (Number.isNaN(parsed)) return 0;
    return cleaned.includes(".") ? Math.round(parsed * 100) : Math.round(parsed);
  }
  return 0;
}

function isReleaseCandidate(status = "") {
  const normalized = String(status).toLowerCase();
  return ["awaiting_release", "release", "ready", "complete"].some((term) => normalized.includes(term));
}

function formatStatusLabel(status = "") {
  const safe = String(status || "In progress")
    .replace(/[_-]/g, " ")
    .trim();
  return safe ? safe.replace(/\b\w/g, (c) => c.toUpperCase()) : "In Progress";
}

function viewCase(caseId) {
  if (!caseId) return;
  window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
}

function formatDate(raw) {
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function sanitizeUrl(url = "") {
  if (!url) return "";
  const trimmed = String(url).trim();
  if (/^(https?:\/\/|\/)/i.test(trimmed)) {
    return trimmed.replace(/"/g, "%22");
  }
  return "";
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  }
}

}

document.addEventListener("DOMContentLoaded", initBillingLite);
