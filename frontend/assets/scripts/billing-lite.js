import { secureFetch } from "./auth.js";

const surface = document.querySelector("[data-billing-surface]");
if (!surface) {
  return;
}

const historyList = document.getElementById("historyList");
const portalBtn = document.getElementById("openPortalBtn");
const financeAlertsEl = document.getElementById("financeAlerts");
const escrowTableBody = document.getElementById("escrowTableBody");
const refreshEscrowsBtn = document.getElementById("refreshEscrowsBtn");
const currencyFormatter = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

let cachedEscrows = [];
let openDrawerEl = null;

initBillingSurface();

async function initBillingSurface() {
  bindEvents();
  const activeItems = await loadActiveEscrows(true);
  await Promise.all([loadFinanceAlerts(activeItems), loadHistory()]);
}

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
  return `
    <tr>
      <td>${caseName}</td>
      <td>${paralegal}</td>
      <td>${amount}</td>
      <td>${funded}</td>
      <td><span class="pill">${statusLabel}</span></td>
      <td>
        <div class="action-drawer" data-case-id="${caseId}">
          <button type="button" class="action-toggle" aria-haspopup="true" aria-expanded="false">
            Actions <span aria-hidden="true">⋯</span>
          </button>
          <div class="action-menu" role="menu">
            <button type="button" data-escrow-action="view" data-case-id="${caseId}">View Case</button>
            <button type="button" data-escrow-action="release" data-case-id="${caseId}">Release Funds</button>
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
      title: `Release funds for ${item.caseName || "a case"}`,
      body: "The paralegal has wrapped. Release escrow to pay them.",
      actions: [
        { type: "release", label: "Release Funds", caseId: item.caseId, primary: true },
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
  }
}

function closeActionDrawers() {
  document.querySelectorAll(".action-drawer.open").forEach((drawer) => {
    drawer.classList.remove("open");
    drawer.querySelector(".action-toggle")?.setAttribute("aria-expanded", "false");
  });
  openDrawerEl = null;
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
