import { secureFetch } from "./auth.js";
import { createElements, mountPaymentElement, confirmSetup } from "./payments.js";

const ATTORNEY_ONBOARDING_STEP_KEY = "lpc_attorney_onboarding_step";
const STRIPE_JS_SRC = "https://js.stripe.com/v3/";
const CASE_PREVIEW_STORAGE_KEY = "lpc_case_preview_id";
const CASE_PREVIEW_RECEIPT_KEY = "lpc_case_preview_receipt";

let historyList = null;
let portalBtn = null;
let currencyFormatter = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
let paymentSummaryEl = null;
let paymentFormEl = null;
let paymentElementHost = null;
let paymentPanelActionsEl = null;
let paymentErrorsEl = null;
let paymentModalEl = null;
let addCardBtn = null;
let replaceCardBtn = null;
let saveCardBtn = null;
let cancelCardBtn = null;

let setupElements = null;
let setupPaymentElement = null;
let pendingHire = null;
let pendingHireLoaded = false;
let paymentFlowOpening = false;
let stripeJsPromise = null;
let billingLiteInitialized = false;

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
  if (!surface || billingLiteInitialized) return;

  billingLiteInitialized = true;
  historyList = document.getElementById("historyList");
  portalBtn = document.getElementById("openPortalBtn");
  currencyFormatter = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  paymentSummaryEl = document.getElementById("paymentMethodSummary");
  paymentFormEl = document.getElementById("paymentMethodForm");
  paymentElementHost = document.getElementById("paymentMethodElement");
  paymentPanelActionsEl = document.querySelector(".payment-method-panel .panel-actions");
  paymentErrorsEl = document.getElementById("paymentMethodErrors");
  paymentModalEl = document.getElementById("paymentMethodModal");
  addCardBtn = document.getElementById("addPaymentMethodBtn");
  replaceCardBtn = document.getElementById("replacePaymentMethodBtn");
  saveCardBtn = document.getElementById("savePaymentMethodBtn");
  cancelCardBtn = document.getElementById("cancelPaymentMethodBtn");

  bindEvents();
  void initBillingSurface();
}

async function initBillingSurface() {
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
  await loadHistory();
}

function bindEvents() {
  const pauseTour = () => {
    try {
      window.dispatchEvent(new CustomEvent("lpc:attorney-tour-pause"));
    } catch {}
    if (typeof window.stopAttorneyTour === "function") {
      window.stopAttorneyTour();
    }
  };

  portalBtn?.addEventListener("click", () => {
    pauseTour();
    openBillingPortal();
  });
  historyList?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-case-id]");
    if (!card) return;
    const caseId = card.getAttribute("data-case-id");
    if (!caseId) return;
    const receiptUrl = card.getAttribute("data-receipt-url") || "";
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
  historyList?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".history-card[data-case-id]");
    if (!card) return;
    event.preventDefault();
    card.click();
  });
  addCardBtn?.addEventListener("click", () => {
    pauseTour();
    startPaymentMethodFlow();
  });
  replaceCardBtn?.addEventListener("click", () => {
    pauseTour();
    startPaymentMethodFlow();
  });
  saveCardBtn?.addEventListener("click", () => savePaymentMethod());
  cancelCardBtn?.addEventListener("click", () => cancelPaymentFlow());
  paymentModalEl?.addEventListener("click", (event) => {
    if (event.target === paymentModalEl) {
      cancelPaymentFlow();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (paymentModalEl?.classList.contains("hidden")) return;
    cancelPaymentFlow();
  });
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
    const res = await secureFetch("/api/payments/portal", { method: "POST", noRedirect: true });
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
    const res = await secureFetch("/api/payments/payment-method/default", {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
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
  window.__lpcBillingPaymentMethod = pm || null;
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
  if (paymentFlowOpening) return;
  paymentFlowOpening = true;
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
    setupElements = await createElements(session.clientSecret, { theme: "flat" });
    setupPaymentElement = mountPaymentElement(setupElements, paymentElementHost);
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
    paymentFlowOpening = false;
  }
}

async function createSetupIntentSession() {
  const res = await secureFetch("/api/payments/payment-method/setup-intent", {
    method: "POST",
    headers: { Accept: "application/json" },
    noRedirect: true,
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
      setAttorneyOnboardingStep("");
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
    noRedirect: true,
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
  const caseName = escapeHtml(entry.caseName || entry.caseTitle || entry.title || "Matter");
  const paralegal = escapeHtml(entry.paralegalName || "Assigned Paralegal");
  const amount = formatCurrency(entry.jobAmount ?? entry.amount ?? entry.lockedTotalAmount ?? entry.totalAmount);
  const datePaid = formatDate(entry.releaseDate || entry.paidOutAt || entry.completedAt);
  const receipt = sanitizeUrl(entry.stripeReceiptUrl || entry.receiptUrl || entry.receipt);
  const caseId = String(entry.caseId || entry.id || "");
  const receiptAttr = receipt ? ` data-receipt-url="${receipt}"` : "";
  return `
    <article class="history-card" role="button" tabindex="0" data-case-id="${caseId}"${receiptAttr}>
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
    </article>
  `;
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initBillingLite, { once: true });
} else {
  initBillingLite();
}
