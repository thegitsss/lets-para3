import { secureFetch } from "./auth.js";

const REFRESH_INTERVAL_MS = 60_000;

const chartCache = {
  userLine: null,
  combo: null,
  escrow: null,
  revenue: null,
  expense: null,
};

let analyticsTimer;
let latestAnalytics = null;

async function loadAnalytics() {
  try {
    const res = await fetch("/api/admin/analytics", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("Failed to load analytics");
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("Failed to load analytics", err);
    return null;
  }
}

function cacheCharts() {
  if (!window.Chart?.getChart) return;
  chartCache.userLine = Chart.getChart("userChart") || chartCache.userLine;
  chartCache.combo = Chart.getChart("userMgmtComboChart") || chartCache.combo;
  chartCache.escrow = Chart.getChart("escrowChart") || chartCache.escrow;
  chartCache.revenue = Chart.getChart("revMainChart") || chartCache.revenue;
  chartCache.expense = Chart.getChart("revExpenseChart") || chartCache.expense;
}

function updateText(selector, value) {
  if (!selector) return;
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}

function formatCurrency(value) {
  const dollars = Number(value || 0) / 100;
  return dollars.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Number(value).toLocaleString();
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatMonthLabel(value) {
  if (!value) return "";
  const [year, month] = value.split("-");
  if (!year || !month) return value;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function toTitle(value) {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function populateMetrics(data) {
  const { userMetrics = {}, escrowMetrics = {}, revenueMetrics = {}, caseMetrics = {}, expenses = {} } = data || {};

  updateText("#totalUsers", formatNumber(userMetrics.totalUsers));
  updateText("#activeCases", formatNumber(caseMetrics.activeCases));
  updateText("#pendingUsers", formatNumber(userMetrics.pendingApprovals));
  updateText("#escrowTotal", formatCurrency(escrowMetrics.totalEscrowHeld));

  updateText("#metricAttorneys", formatNumber(userMetrics.totalAttorneys));
  updateText("#metricParalegals", formatNumber(userMetrics.totalParalegals));
  updateText("#metricPending", formatNumber(userMetrics.pendingApprovals));
  updateText("#metricSuspended", formatNumber(userMetrics.suspendedUsers));

  const pendingLabel = document.getElementById("pendingUsersCountLabel");
  if (pendingLabel) {
    const pendingCount = Number(userMetrics.pendingApprovals) || 0;
    pendingLabel.textContent = `${pendingCount.toLocaleString()} pending user${pendingCount === 1 ? "" : "s"}`;
  }

  populateQuickStats(userMetrics, caseMetrics, escrowMetrics);

  const revenueCards = document.querySelectorAll("#section-revenue .grid-four .card p");
  if (revenueCards[0]) revenueCards[0].textContent = formatCurrency(revenueMetrics.totalRevenue);
  if (revenueCards[1]) revenueCards[1].textContent = formatCurrency(escrowMetrics.totalEscrowReleased);
  if (revenueCards[2]) revenueCards[2].textContent = formatCurrency(escrowMetrics.pendingPayouts);
  if (revenueCards[3]) revenueCards[3].textContent = formatCurrency(revenueMetrics.platformFeesCollected);

  updateText("#payoutTotal", formatCurrency(expenses.payoutTotal));
  const payoutCountEl = document.getElementById("payoutCount");
  if (payoutCountEl) {
    const payoutCount = Number(expenses.payoutCount) || 0;
    payoutCountEl.textContent = `${payoutCount.toLocaleString()} payout${payoutCount === 1 ? "" : "s"} recorded`;
  }

  updateText("#incomeTotal", formatCurrency(revenueMetrics.platformFeesCollected));
  const incomeCountEl = document.getElementById("incomeCount");
  if (incomeCountEl) {
    const incomeCount = Number(revenueMetrics.platformFeeCount) || 0;
    incomeCountEl.textContent = `${incomeCount.toLocaleString()} income record${incomeCount === 1 ? "" : "s"}`;
  }
}

function populateQuickStats(userMetrics = {}, caseMetrics = {}, escrowMetrics = {}) {
  const nodes = document.querySelectorAll(".quick-stats div");
  const configs = [
    { label: "Total Users", value: formatNumber(userMetrics.totalUsers) },
    { label: "Pending Approvals", value: formatNumber(userMetrics.pendingApprovals) },
    { label: "Active Cases", value: formatNumber(caseMetrics.activeCases) },
    { label: "Completed Cases", value: formatNumber(caseMetrics.completedCases) },
    { label: "Escrow In Progress", value: formatCurrency(escrowMetrics.totalEscrowHeld) },
    { label: "Escrow Released", value: formatCurrency(escrowMetrics.totalEscrowReleased) },
  ];
  nodes.forEach((node, index) => {
    const strong = node.querySelector("strong") || node.appendChild(document.createElement("strong"));
    const span = node.querySelector("span") || node.appendChild(document.createElement("span"));
    const config = configs[index];
    if (config) {
      strong.textContent = config.value;
      span.textContent = config.label;
    } else {
      strong.textContent = "—";
      span.textContent = "";
    }
  });
}

function populateCharts(data) {
  cacheCharts();
  const { revenueMetrics = {} } = data || {};
  const chart = chartCache.revenue;
  if (!chart) return;
  const entries = revenueMetrics.monthlyRevenue || [];
  const labels = entries.map((entry) => formatMonthLabel(entry.month));
  const revenueData = entries.map((entry) => Math.round((Number(entry.revenue) || 0) / 100));
  const marginData = entries.map((entry) => Number(entry.margin) || 0);

  chart.data.labels = labels;
  if (chart.data.datasets[0]) chart.data.datasets[0].data = revenueData;
  if (chart.data.datasets[1]) chart.data.datasets[1].data = marginData;
  chart.update("none");
}

function populateExpenseChart(data) {
  cacheCharts();
  const { revenueMetrics = {}, taxSummary = {}, expenses = {} } = data || {};
  const chart = chartCache.expense;
  if (!chart) return;
  const values = [
    Math.round((Number(revenueMetrics.platformFeesCollected) || 0) / 100),
    Math.round((Number(taxSummary.taxOwed ?? taxSummary.estimatedTax) || 0) / 100),
    Math.round((Number(expenses.operationalCosts) || 0) / 100),
    Math.round((Number(expenses.payoutTotal) || 0) / 100),
  ];
  if (chart.data.datasets[0]) {
    chart.data.datasets[0].data = values;
    chart.update("none");
  }
}

function populateLedger(data) {
  const tbody = document.getElementById("ledgerBody");
  if (!tbody) return;
  const entries = data?.ledger || [];
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No ledger entries found.</td></tr>';
    return;
  }
  tbody.innerHTML = "";
  entries.forEach((entry) => {
    const row = document.createElement("tr");
    const statusLabel = toTitle(entry.status || "Pending");
    const statusSlug = statusLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    row.innerHTML = `
      <td>${formatDate(entry.date)}</td>
      <td>${entry.category || "—"}</td>
      <td>${entry.description || "—"}</td>
      <td>${formatCurrency(entry.amount)}</td>
      <td>${toTitle(entry.type || "income")}</td>
      <td><span class="status ${statusSlug}">${statusLabel}</span></td>
    `;
    tbody.appendChild(row);
  });
}

function populateTaxSummary(data) {
  const list = document.querySelector(".tax-summary");
  if (!list) return;
  const { taxSummary = {} } = data || {};
  const items = list.querySelectorAll("li");
  if (items[0]) items[0].innerHTML = `<strong>Gross Earnings:</strong> ${formatCurrency(taxSummary.grossEarnings)}`;
  if (items[1]) items[1].innerHTML = `<strong>Deductible Expenses:</strong> ${formatCurrency(taxSummary.deductibleExpenses)}`;
  if (items[2]) items[2].innerHTML = `<strong>Estimated Tax Owed (22%):</strong> ${formatCurrency(taxSummary.estimatedTax)}`;
  if (items[3]) items[3].innerHTML = `<strong>Next Filing Deadline:</strong> ${taxSummary.nextFilingDeadline || "—"}`;
}

function populatePayoutSchedule(data) {
  const container = document.querySelector(".payout-schedule");
  if (!container) return;
  const payouts = data?.upcomingPayouts || [];
  container.innerHTML = "";
  if (!payouts.length) {
    container.innerHTML = "<li>No upcoming payouts scheduled.</li>";
    return;
  }
  payouts.forEach((payout) => {
    const item = document.createElement("li");
    item.textContent = `${formatDate(payout.date)} – ${formatCurrency(payout.amount)} to ${payout.recipient || "Recipient"}`;
    container.appendChild(item);
  });
}

function populateRegistrationChart(data) {
  cacheCharts();
  const entries = data?.userMetrics?.registrationsByMonth || [];
  const labels = entries.map((entry) => formatMonthLabel(entry.month));
  const counts = entries.map((entry) => entry.count || 0);
  const growth = counts.map((count, index) => {
    if (index === 0) return 0;
    const prev = counts[index - 1] || 1;
    return Math.round(((count - prev) / prev) * 100);
  });

  if (chartCache.combo) {
    chartCache.combo.data.labels = labels;
    if (chartCache.combo.data.datasets[0]) chartCache.combo.data.datasets[0].data = counts;
    if (chartCache.combo.data.datasets[1]) chartCache.combo.data.datasets[1].data = growth;
    chartCache.combo.update("none");
  }

  if (chartCache.userLine) {
    chartCache.userLine.data.labels = labels;
    if (chartCache.userLine.data.datasets[0]) chartCache.userLine.data.datasets[0].data = counts;
    chartCache.userLine.update("none");
  }
}

function populateEscrowChart(data) {
  cacheCharts();
  const chart = chartCache.escrow;
  if (!chart) return;
  const { escrowMetrics = {} } = data || {};
  const held = Math.round((Number(escrowMetrics.totalEscrowHeld) || 0) / 100);
  const released = Math.round((Number(escrowMetrics.totalEscrowReleased) || 0) / 100);
  const pending = Math.round((Number(escrowMetrics.pendingPayouts) || 0) / 100);
  if (chart.data.datasets[0]) {
    chart.data.datasets[0].data = [held, released, pending];
    chart.update("none");
  }
}

function populateNewUsers(data) {
  const list = document.getElementById("newUsersList");
  if (!list) return;
  const users = data?.recentUsers || [];
  if (!users.length) {
    list.innerHTML = '<li style="color:var(--muted)">No recent users found.</li>';
    return;
  }
  list.innerHTML = "";
  users.forEach((user) => {
    const li = document.createElement("li");
    const created = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "";
    li.innerHTML = `<strong>${escapeHTML(user.name || user.email || "User")}</strong> <span>${escapeHTML(user.role || "—")}</span> <small style="display:block;color:var(--muted)">${created}</small>`;
    list.appendChild(li);
  });
}

function applyAnalyticsPayload(data) {
  latestAnalytics = data;
  populateMetrics(data);
  populateCharts(data);
  populateExpenseChart(data);
  populateLedger(data);
  populateTaxSummary(data);
  populatePayoutSchedule(data);
  populateRegistrationChart(data);
  populateEscrowChart(data);
  populateNewUsers(data);
}

async function hydrateAnalytics() {
  const data = await loadAnalytics();
  if (!data) return null;
  applyAnalyticsPayload(data);
  return data;
}

async function loadPendingParalegals() {
  try {
    const res = await secureFetch("/api/admin/pending-paralegals", {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    const payload = await res.json().catch(() => ({}));
    renderVerificationList(Array.isArray(payload?.items) ? payload.items : []);
  } catch (err) {
    console.warn("Unable to load pending paralegals", err);
    renderVerificationList([]);
  }
}

function escapeHTML(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c] || c;
  });
}

function escapeAttribute(value = "") {
  return String(value || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function renderVerificationList(items) {
  const list = document.getElementById("paralegalVerificationList");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = "<p>No paralegals awaiting verification.</p>";
    return;
  }
  const cards = items
    .map((p) => {
      const id = escapeAttribute(p._id || p.id || "");
      const firstName = escapeHTML(p.firstName || "");
      const lastName = escapeHTML(p.lastName || "");
      const email = escapeHTML(p.email || "");
      const years = Number.isFinite(Number(p.yearsExperience)) ? Number(p.yearsExperience) : null;
      const yearsLabel = years === null ? "N/A" : `${years} year${years === 1 ? "" : "s"}`;
      const linkedIn = p.linkedInURL
        ? `<p><a href="${escapeAttribute(p.linkedInURL)}" target="_blank" rel="noopener">LinkedIn Profile</a></p>`
        : "<p>LinkedIn profile not provided.</p>";
      const certificateHref = p.certificateURL
        ? `/api/uploads/view/${encodeURIComponent(p.certificateURL)}`
        : "";
      const certificate = certificateHref
        ? `<p><a href="${escapeAttribute(certificateHref)}" target="_blank" rel="noopener">Certificate</a></p>`
        : "<p>Certificate not uploaded.</p>";
      const ref1 = `${escapeHTML(p.ref1Name || "N/A")} — ${escapeHTML(p.ref1Email || "N/A")}`;
      const ref2 = `${escapeHTML(p.ref2Name || "N/A")} — ${escapeHTML(p.ref2Email || "N/A")}`;
      return `
        <div class="verify-card" data-id="${id}">
          <strong>${lastName || "N/A"}, ${firstName || "N/A"}</strong>
          <p>Email: ${email || "N/A"}</p>
          <p>Years Experience: ${yearsLabel}</p>
          ${linkedIn}
          ${certificate}
          <details>
            <summary>References</summary>
            <p>${ref1}</p>
            <p>${ref2}</p>
          </details>
          <button class="approveParalegalBtn" data-id="${id}">Approve</button>
          <button class="rejectParalegalBtn" data-id="${id}">Reject</button>
          <div class="user-card-actions">
            <button class="disableUserBtn" data-id="${id}">Disable</button>
            <button class="enableUserBtn" data-id="${id}">Enable</button>
          </div>
        </div>
      `;
    })
    .join("");
  list.innerHTML = cards;
}

function applyRoleVisibility(user) {
  const role = String(user?.role || "").toLowerCase();
  if (role === "paralegal") {
    document.querySelectorAll("[data-attorney-only]").forEach((el) => {
      el.style.display = "none";
    });
  }
  if (role === "attorney") {
    document.querySelectorAll("[data-paralegal-only]").forEach((el) => {
      el.style.display = "none";
    });
  }
}

async function bootAdminDashboard() {
  const user = typeof window.requireRole === "function" ? await window.requireRole("admin") : null;
  if (!user) return null;
  applyRoleVisibility(user);
  await loadPendingParalegals();
  return user;
}

async function loadUsers() {
  await Promise.allSettled([loadPendingParalegals(), hydrateAnalytics()]);
}

document.addEventListener("DOMContentLoaded", async () => {
  const user = await bootAdminDashboard();
  if (!user) return;

  const data = await loadAnalytics();
  if (!data) return;

  applyAnalyticsPayload(data);
  if (analyticsTimer) clearInterval(analyticsTimer);
  analyticsTimer = setInterval(hydrateAnalytics, REFRESH_INTERVAL_MS);
});

document.addEventListener("click", async (evt) => {
  const disableBtn = evt.target.closest(".disableUserBtn");
  if (disableBtn) {
    const id = disableBtn.dataset.id;
    if (!id) return;
    try {
      await secureFetch(`/api/admin/disable/${encodeURIComponent(id)}`, { method: "POST" });
      await loadUsers();
    } catch (err) {
      console.error("Failed to disable user", err);
    }
    return;
  }

  const enableBtn = evt.target.closest(".enableUserBtn");
  if (enableBtn) {
    const id = enableBtn.dataset.id;
    if (!id) return;
    try {
      await secureFetch(`/api/admin/enable/${encodeURIComponent(id)}`, { method: "POST" });
      await loadUsers();
    } catch (err) {
      console.error("Failed to enable user", err);
    }
    return;
  }

  const approveBtn = evt.target.closest(".approveParalegalBtn");
  const rejectBtn = evt.target.closest(".rejectParalegalBtn");
  if (approveBtn) {
    const id = approveBtn.dataset.id;
    if (!id) return;
    try {
      await secureFetch(`/api/admin/approve/${encodeURIComponent(id)}`, { method: "POST" });
      await loadPendingParalegals();
    } catch (err) {
      console.error("Failed to approve paralegal", err);
    }
    return;
  }
  if (rejectBtn) {
    const id = rejectBtn.dataset.id;
    if (!id) return;
    try {
      await secureFetch(`/api/admin/reject/${encodeURIComponent(id)}`, { method: "POST" });
      await loadPendingParalegals();
    } catch (err) {
      console.error("Failed to reject paralegal", err);
    }
  }
});
