import { secureFetch } from "./auth.js";

const METRICS_ENDPOINT = "/api/admin/metrics";
const REFRESH_INTERVAL_MS = 60_000;

const chartCache = {
  userLine: null,
  combo: null,
  escrow: null,
};

let refreshTimer;

function cacheCharts() {
  if (window.Chart?.getChart) {
    chartCache.userLine = Chart.getChart("userChart") || chartCache.userLine;
    chartCache.combo = Chart.getChart("userMgmtComboChart") || chartCache.combo;
    chartCache.escrow = Chart.getChart("escrowChart") || chartCache.escrow;
  }
}

async function loadMetrics() {
  try {
    const res = await secureFetch(METRICS_ENDPOINT, {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderMetrics(payload);
  } catch (err) {
    console.warn("Unable to load admin metrics", err);
    renderMetrics(null);
  }
}

function renderMetrics(data) {
  if (!chartCache.userLine && window.Chart?.getChart) {
    cacheCharts();
  }
  const totals = data?.totals || {};
  setNumber("totalUsers", totals.totalUsers);
  setCurrency("escrowTotal", totals.escrowHeld);
  setNumber("activeCases", totals.activeCases);
  setNumber("pendingUsers", totals.pendingApprovals);

  setNumber("metricAttorneys", totals.attorneys);
  setNumber("metricParalegals", totals.paralegals);
  setNumber("metricPending", totals.pendingApprovals);
  setNumber("metricSuspended", totals.suspendedUsers);

  updateRevenueWidgets(totals);
  updateRecentUsers(data?.recentUsers || []);
  updateRegistrationCharts(data?.monthlyRegistrations || []);
  updateEscrowChart(totals);
}

function setNumber(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const number = Number.isFinite(value) ? Number(value) : 0;
  el.textContent = number.toLocaleString();
}

function setCurrency(id, cents) {
  const el = document.getElementById(id);
  if (!el) return;
  const amount = (Number(cents) || 0) / 100;
  el.textContent = amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function updateRevenueWidgets(totals) {
  const progressEl = document.getElementById("weeklySalesProgress");
  const listEl = document.getElementById("weeklySalesList");
  const revenueCents = Number(totals.totalRevenue) || 0;
  const revenueDollars = revenueCents / 100;
  const target = 50_000; // $50k target for visual progress
  const progress = target > 0 ? Math.min(100, Math.round((revenueDollars / target) * 100)) : 0;

  if (progressEl) {
    progressEl.textContent = `${progress}% Progress`;
  }

  if (listEl) {
    listEl.innerHTML = `
      <li><strong>Total Revenue</strong> – ${revenueDollars.toLocaleString(undefined, { style: "currency", currency: "USD" })}</li>
      <li><strong>Active Cases</strong> – ${Number(totals.activeCases || 0).toLocaleString()}</li>
      <li><strong>Completed Cases</strong> – ${Number(totals.completedCases || 0).toLocaleString()}</li>
    `;
  }
}

function updateRecentUsers(users) {
  const list = document.getElementById("newUsersList");
  if (!list) return;
  if (!users.length) {
    list.innerHTML = '<li style="color:var(--muted)">No recent users found.</li>';
    return;
  }
  list.innerHTML = "";
  users.forEach((user) => {
    const li = document.createElement("li");
    const name = escapeHTML(user.name || user.email || "User");
    const role = escapeHTML(user.role || "—");
    const created = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "";
    li.innerHTML = `<strong>${name}</strong> <span>${role}</span> <small style="display:block;color:var(--muted)">${created}</small>`;
    list.appendChild(li);
  });
}

function updateRegistrationCharts(registrations) {
  cacheCharts();
  const labels = registrations.length
    ? registrations.map((entry) => entry.month)
    : ["No data"];
  const counts = registrations.length ? registrations.map((entry) => entry.count) : [0];

  if (chartCache.combo) {
    chartCache.combo.data.labels = labels;
    chartCache.combo.data.datasets[0].data = counts;
    if (chartCache.combo.data.datasets[1]) {
      chartCache.combo.data.datasets[1].data = counts;
    }
    chartCache.combo.update("none");
  }

  if (chartCache.userLine) {
    chartCache.userLine.data.labels = labels;
    chartCache.userLine.data.datasets[0].data = counts;
    chartCache.userLine.update("none");
  }
}

function updateEscrowChart(totals) {
  cacheCharts();
  if (!chartCache.escrow) return;
  const held = (Number(totals.escrowHeld) || 0) / 100;
  const released = Number(totals.completedCases || 0);
  const pending = Number(totals.pendingApprovals || 0);
  chartCache.escrow.data.datasets[0].data = [held, released, pending];
  chartCache.escrow.update("none");
}

function escapeHTML(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c] || c;
  });
}

function startMetrics() {
  cacheCharts();
  loadMetrics();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadMetrics, REFRESH_INTERVAL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startMetrics, { once: true });
} else {
  startMetrics();
}
