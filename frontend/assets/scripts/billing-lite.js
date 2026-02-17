import { secureFetch } from "./auth.js";
import { createElements, mountPaymentElement, confirmSetup } from "./payments.js";

const ATTORNEY_ONBOARDING_STEP_KEY = "lpc_attorney_onboarding_step";

function getAttorneyOnboardingStep() {
  try {
    return sessionStorage.getItem(ATTORNEY_ONBOARDING_STEP_KEY);
  } catch {
    return null;
  }
}

function setAttorneyOnboardingStep(step) {
  try {
    if (!step) {
      sessionStorage.removeItem(ATTORNEY_ONBOARDING_STEP_KEY);
      return;
    }
    sessionStorage.setItem(ATTORNEY_ONBOARDING_STEP_KEY, step);
  } catch {}
}

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
  const CASE_PREVIEW_STORAGE_KEY = "lpc_case_preview_id";
  const CASE_PREVIEW_RECEIPT_KEY = "lpc_case_preview_receipt";

  let cachedEscrows = [];
  let openDrawerEl = null;
  let openDrawerTrigger = null;
  let setupElements = null;
  let setupPaymentElement = null;
  let pendingHire = null;
  let pendingHireLoaded = false;

  const STRIPE_JS_SRC = "https://js.stripe.com/v3/";
  let stripeJsPromise = null;

  (async function initBillingSurface() {
    console.log("billing-lite loaded");
    bindEvents();
    pendingHire = await loadPendingHire();
    if (pendingHire?.message) {
      showToast(pendingHire.message, "info");
    }
    const paymentStatus = await loadPaymentMethodStatus();
    if (getAttorneyOnboardingStep() === "payment") {
      const targetBtn = addCardBtn && !addCardBtn.hidden ? addCardBtn : replaceCardBtn;
      if (targetBtn) {
        targetBtn.classList.add("onboarding-pulse");
        targetBtn.addEventListener("click", () => targetBtn.classList.remove("onboarding-pulse"), { once: true });
      }
    }
    if (pendingHire && paymentStatus?.paymentMethod) {
      resumePendingHire(pendingHire);
    }
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
    const receiptUrl = btn.getAttribute("data-receipt-url") || "";
    if (receiptUrl) {
      try {
        sessionStorage.setItem(
          CASE_PREVIEW_RECEIPT_KEY,
          JSON.stringify({ caseId: String(caseId), receiptUrl })
        );
      } catch {}
    } else {
      try {
        sessionStorage.removeItem(CASE_PREVIEW_RECEIPT_KEY);
      } catch {}
    }
    if (typeof window.openCasePreview === "function") {
      window.openCasePreview(caseId, { keepView: true });
      return;
    }
    showToast("Unable to load details right now.", "info");
  });
  refreshEscrowsBtn?.addEventListener("click", () => {
    loadActiveEscrows(true, { syncAlerts: true });
  });
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
    escrowTableBody.innerHTML = renderEscrowSkeletonRows();
  }
  try {
    const res = await secureFetch("/api/payments/escrow/active", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => ({}));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    cachedEscrows = items;
    if (!items.length) {
      escrowTableBody.innerHTML = `<tr><td colspan="5" class="history-empty">No funds currently held in Stripe.</td></tr>`;
    } else {
      escrowTableBody.innerHTML = items.map(renderEscrowRow).join("");
    }
    if (syncAlerts) {
      await loadFinanceAlerts(items);
    }
    return items;
  } catch (err) {
    console.warn("Unable to load active funds", err);
    escrowTableBody.innerHTML = `<tr><td colspan="5" class="history-empty error">Unable to load active Stripe records.</td></tr>`;
    return [];
  }
}

function renderEscrowRow(entry = {}) {
  const caseName = escapeHtml(entry.caseName || entry.caseTitle || entry.title || "Case");
  const paralegal = escapeHtml(entry.paralegalName || "Paralegal pending");
  const amount = formatCurrency(entry.amountHeld ?? entry.amount ?? entry.lockedTotalAmount ?? entry.totalAmount);
  const funded = formatDate(entry.fundedAt || entry.updatedAt);
  const statusLabel = formatStatusLabel(entry.status || "");
  return `
    <tr>
      <td>${caseName}</td>
      <td>${paralegal}</td>
      <td>${amount}</td>
      <td>${funded}</td>
      <td><span class="pill">${statusLabel}</span></td>
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
    const summary = count === 1 ? `${first.paralegalName || "Your paralegal"} is ready to start.` : "Fund Stripe to unblock your assignments.";
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
  return alerts;
}

function renderFinanceAlerts(alerts = []) {
  if (!financeAlertsEl) return;
  if (!alerts.length) {
    financeAlertsEl.innerHTML = "";
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
  historyList.innerHTML = renderHistorySkeleton();
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
    if (getAttorneyOnboardingStep() === "payment") {
      setAttorneyOnboardingStep("case");
      window.location.href = "dashboard-attorney.html#cases";
      return;
    }
    if (!pendingHire) pendingHire = await loadPendingHire(true);
    if (pendingHire?.caseId) {
      resumePendingHire(pendingHire);
    }
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

async function loadPendingHire(force = false) {
  if (pendingHireLoaded && !force) return pendingHire;
  pendingHireLoaded = true;
  try {
    const res = await secureFetch("/api/users/me/pending-hire", { headers: { Accept: "application/json" } });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      pendingHire = null;
      return null;
    }
    pendingHire = payload?.pendingHire || null;
    return pendingHire;
  } catch (err) {
    console.warn("Unable to load pending hire", err);
    pendingHire = null;
    return null;
  }
}

async function clearPendingHire() {
  pendingHire = null;
  pendingHireLoaded = true;
  try {
    await secureFetch("/api/users/me/pending-hire", { method: "DELETE", headers: { Accept: "application/json" } });
  } catch {
    /* ignore */
  }
}

function resumePendingHire(pending) {
  if (!pending?.caseId) return;
  pendingHire = null;
  void clearPendingHire();
  const target = pending.fundUrl || `dashboard-attorney.html?openApplicants=1&caseId=${encodeURIComponent(pending.caseId)}#cases:inquiries`;
  showToast("Payment method ready. Return to the case to hire the paralegal.", "success");
  setTimeout(() => {
    window.location.href = target;
  }, 600);
}

function renderHistoryCard(entry = {}) {
  const caseName = escapeHtml(entry.caseName || entry.caseTitle || entry.title || "Case");
  const paralegal = escapeHtml(entry.paralegalName || "Assigned Paralegal");
  const amount = formatCurrency(entry.jobAmount ?? entry.amount ?? entry.lockedTotalAmount ?? entry.totalAmount);
  const datePaid = formatDate(entry.releaseDate || entry.paidOutAt || entry.completedAt);
  const receipt = sanitizeUrl(entry.stripeReceiptUrl || entry.receiptUrl || entry.receipt);
  const caseId = String(entry.caseId || entry.id || "");
  const receiptAttr = receipt ? ` data-receipt-url="${receipt}"` : "";
  return `
    <article class="history-card">
      <div class="history-primary">
        <div class="case-name">${caseName}</div>
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
        <button type="button" data-case-id="${caseId}"${receiptAttr}>Details</button>
      </div>
    </article>
  `;
}

function releaseEscrowCase(caseId, trigger) {
  if (!caseId) return;
  showToast("Funds are released only via the case completion flow.", "info");
  return;
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
  window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}#case-messages`;
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

function renderEscrowSkeletonRows(count = 3) {
  const cell = (size) => `<div class="skeleton-line ${size}"></div>`;
  return Array.from({ length: count })
    .map(
      () => `
        <tr class="skeleton-row">
          <td>${cell("long")}</td>
          <td>${cell("medium")}</td>
          <td>${cell("short")}</td>
          <td>${cell("short")}</td>
          <td>${cell("short")}</td>
        </tr>
      `
    )
    .join("");
}

function renderHistorySkeleton(count = 2) {
  const line = (size) => `<div class="skeleton-line ${size}"></div>`;
  return Array.from({ length: count })
    .map(
      () => `
        <article class="history-card">
          <div class="history-primary">
            ${line("long")}
            ${line("short")}
          </div>
          <div class="history-meta">
            <div class="meta-item">${line("short")}</div>
            <div class="meta-item">${line("short")}</div>
          </div>
          <div class="history-actions">
            ${line("short")}
            ${line("short")}
          </div>
        </article>
      `
    )
    .join("");
}

function viewCase(caseId) {
  if (!caseId) return;
  if (typeof window.openCasePreview === "function") {
    window.openCasePreview(caseId, { keepView: true });
    return;
  }
  window.location.href = `dashboard-attorney.html?previewCaseId=${encodeURIComponent(caseId)}#cases`;
}

function viewArchivedCase(caseId) {
  if (!caseId) return;
  try {
    sessionStorage.setItem(CASE_PREVIEW_STORAGE_KEY, String(caseId));
  } catch {
    /* ignore */
  }
  if (window.location.pathname.endsWith("dashboard-attorney.html")) {
    if (window.location.hash !== "#cases:archived") {
      window.location.hash = "cases:archived";
    } else {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    return;
  }
  window.location.href = `dashboard-attorney.html?previewCaseId=${encodeURIComponent(caseId)}#cases:archived`;
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
