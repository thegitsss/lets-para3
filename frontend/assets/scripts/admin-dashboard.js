import { secureFetch, fetchCSRF } from "./auth.js";

const chartCache = {
userLine: null,
combo: null,
escrow: null,
revenue: null,
expense: null,
  escrowReport: null,
};

let analyticsInFlight = false;
let latestAnalytics = null;
let lastAnalyticsRenderAt = 0;
let adminSettingsCache = null;
let settingsBound = false;
const ANALYTICS_COOLDOWN_MS = 30_000;
const removedUserIds = new Set();
let recentUsersCache = [];
const NEW_USERS_PAGE_SIZE = 5;
let newUsersPage = 1;
const newUsersPageSelect = document.getElementById("newUsersPageSelect");

async function loadAnalytics() {
if (analyticsInFlight) return null;
analyticsInFlight = true;
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
} finally {
analyticsInFlight = false;
}
}

function cacheCharts() {
if (!window.Chart?.getChart) return;
chartCache.userLine = Chart.getChart("userChart") || chartCache.userLine;
chartCache.combo = Chart.getChart("userMgmtComboChart") || chartCache.combo;
chartCache.escrow = Chart.getChart("escrowChart") || chartCache.escrow;
chartCache.revenue = Chart.getChart("revMainChart") || chartCache.revenue;
chartCache.expense = Chart.getChart("revExpenseChart") || chartCache.expense;
  chartCache.escrowReport = Chart.getChart("escrowReportChart") || chartCache.escrowReport;
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

function showToast(message, type = "info") {
  const toast = window.toastUtils;
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else if (message) {
    alert(message);
  }
}

function formatDate(value) {
if (!value) return "";
const date = new Date(value);
if (Number.isNaN(date.getTime())) return value;
return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function getNewUsersTotalPages(total) {
return Math.max(1, Math.ceil(total / NEW_USERS_PAGE_SIZE));
}

function clampNewUsersPage(page, total) {
const safePage = Number(page) || 1;
const totalPages = getNewUsersTotalPages(total);
return Math.min(totalPages, Math.max(1, safePage));
}

function updateNewUsersPageSelect(total, page) {
if (!newUsersPageSelect) return;
const totalPages = getNewUsersTotalPages(total);
newUsersPageSelect.innerHTML = "";
for (let i = 1; i <= totalPages; i += 1) {
const option = document.createElement("option");
option.value = String(i);
option.textContent = `Page ${i} of ${totalPages}`;
newUsersPageSelect.appendChild(option);
}
newUsersPageSelect.value = String(page);
newUsersPageSelect.disabled = totalPages <= 1;
}

function renderNewUsersPage() {
const list = document.getElementById("newUsersList");
if (!list) return;
const users = filterActiveUsers(recentUsersCache || []);
const total = users.length;
newUsersPage = clampNewUsersPage(newUsersPage, total);
updateNewUsersPageSelect(total, newUsersPage);
const start = (newUsersPage - 1) * NEW_USERS_PAGE_SIZE;
const pageItems = users.slice(start, start + NEW_USERS_PAGE_SIZE);
if (!total) {
list.innerHTML = '<li style="color:var(--muted)">No recent users found.</li>';
return;
}
list.innerHTML = "";
pageItems.forEach((user) => {
  const li = document.createElement("li");
  const created = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "";
  const name = user.name || user.email || "User";
  const role = (user.role || "user").toLowerCase();
  const profilePath = role === "paralegal" ? "profile-paralegal" : "profile-attorney";
  const link = document.createElement("a");
  link.href = `${profilePath}.html?id=${encodeURIComponent(user.id || user._id || "")}`;
  link.textContent = name;
  link.className = "user-link";
  const roleSpan = document.createElement("span");
  roleSpan.textContent = user.role || "—";
  const time = document.createElement("small");
  time.style.display = "block";
  time.style.color = "var(--muted)";
  time.textContent = created;
  const actions = document.createElement("div");
  actions.className = "user-actions";
  const deactivateBtn = document.createElement("button");
  deactivateBtn.type = "button";
  deactivateBtn.textContent = "Remove";
  deactivateBtn.className = "btn danger";
  deactivateBtn.dataset.userId = user.id || user._id || "";
  deactivateBtn.addEventListener("click", () => {
    const userId = deactivateBtn.dataset.userId;
    if (!userId) return;
    deactivateUser(userId, { source: "recent" });
  });
  actions.appendChild(deactivateBtn);
  li.appendChild(link);
  li.appendChild(roleSpan);
  li.appendChild(time);
  li.appendChild(actions);
  list.appendChild(li);
});
}

function clampNumber(value, min, max) {
const num = Number(value);
if (!Number.isFinite(num)) return null;
return Math.min(max, Math.max(min, num));
}

function formatTaxRatePercent(rate) {
if (!Number.isFinite(Number(rate))) return "";
const percent = Number(rate) * 100;
return percent % 1 === 0 ? String(percent) : percent.toFixed(1);
}

function setSettingsStatus(message = "") {
const status = document.getElementById("settingsStatus");
if (status) status.textContent = message;
}

function applySettingsToForm(settings = {}) {
const allowInput = document.getElementById("settingAllowSignups");
if (allowInput) allowInput.checked = settings.allowSignups !== false;
const maintenanceInput = document.getElementById("settingMaintenanceMode");
if (maintenanceInput) maintenanceInput.checked = !!settings.maintenanceMode;
const emailInput = document.getElementById("settingSupportEmail");
if (emailInput) emailInput.value = settings.supportEmail || "";
const taxInput = document.getElementById("settingTaxRate");
if (taxInput) taxInput.value = formatTaxRatePercent(settings.taxRate);
const updatedLabel = document.getElementById("settingsUpdatedAt");
if (updatedLabel) {
const updated = settings.updatedAt ? formatDate(settings.updatedAt) : "";
updatedLabel.textContent = updated ? `Last updated ${updated}` : "";
}
}

async function loadAdminSettings() {
try {
const res = await secureFetch("/api/admin/settings", {
headers: { Accept: "application/json" },
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
throw new Error(data?.error || data?.msg || "Unable to load settings.");
}
const settings = data.settings || data;
adminSettingsCache = settings;
applySettingsToForm(settings);
setSettingsStatus("");
return settings;
} catch (err) {
console.error("Failed to load admin settings", err);
showToast(err?.message || "Unable to load settings.", "err");
setSettingsStatus("Unable to load settings.");
return null;
}
}

function readSettingsFromForm() {
const allowInput = document.getElementById("settingAllowSignups");
const maintenanceInput = document.getElementById("settingMaintenanceMode");
const emailInput = document.getElementById("settingSupportEmail");
const taxInput = document.getElementById("settingTaxRate");

const payload = {
allowSignups: !!allowInput?.checked,
maintenanceMode: !!maintenanceInput?.checked,
supportEmail: emailInput ? emailInput.value.trim() : "",
};
if (taxInput) {
const normalized = clampNumber(taxInput.value, 0, 50);
if (normalized !== null) {
payload.taxRate = normalized / 100;
}
}
return payload;
}

async function saveAdminSettings() {
const saveBtn = document.getElementById("saveAdminSettings");
const original = saveBtn?.textContent || "Save Settings";
if (saveBtn) {
saveBtn.disabled = true;
saveBtn.textContent = "Saving...";
}
setSettingsStatus("");
try {
const payload = readSettingsFromForm();
const res = await secureFetch("/api/admin/settings", {
method: "PUT",
body: payload,
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
throw new Error(data?.error || data?.msg || "Unable to save settings.");
}
const settings = data.settings || data;
adminSettingsCache = settings;
applySettingsToForm(settings);
showToast("Settings saved.", "ok");
setSettingsStatus("Saved.");
await hydrateAnalytics();
return settings;
} catch (err) {
console.error("Failed to save settings", err);
showToast(err?.message || "Unable to save settings.", "err");
setSettingsStatus("Save failed.");
return null;
} finally {
if (saveBtn) {
saveBtn.disabled = false;
saveBtn.textContent = original;
}
}
}

function bindSettingsActions() {
if (settingsBound) return;
const saveBtn = document.getElementById("saveAdminSettings");
if (saveBtn) {
saveBtn.addEventListener("click", () => {
saveAdminSettings();
});
}
settingsBound = true;
}

function formatReportDate(value = new Date()) {
const date = value instanceof Date ? value : new Date(value);
if (Number.isNaN(date.getTime())) return "";
return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function csvEscape(value) {
const normalized = String(value ?? "").replace(/\r?\n/g, " ").trim();
return `"${normalized.replace(/"/g, "\"\"")}"`;
}

function buildTaxReportRows(data) {
const { taxSummary = {}, ledger = [] } = data || {};
const reportDate = formatReportDate(new Date());
const rows = [
["Lets-ParaConnect Tax Report"],
["Generated", reportDate || formatDate(new Date())],
[],
["Tax Summary"],
["Gross Earnings", formatCurrency(taxSummary.grossEarnings)],
["Deductible Expenses", formatCurrency(taxSummary.deductibleExpenses)],
["Estimated Tax Owed (22%)", formatCurrency(taxSummary.estimatedTax)],
["Next Filing Deadline", taxSummary.nextFilingDeadline || "—"],
];

if (Array.isArray(ledger) && ledger.length) {
rows.push([]);
rows.push(["Ledger Entries"]);
rows.push(["Date", "Category", "Description", "Amount", "Type", "Status"]);
ledger.forEach((entry) => {
rows.push([
formatDate(entry.date),
entry.category || "—",
entry.description || "—",
formatCurrency(entry.amount),
toTitle(entry.type || "income"),
toTitle(entry.status || "pending"),
]);
});
}

return rows;
}

function downloadTaxReport(data) {
const rows = buildTaxReportRows(data);
const csv = rows
.map((row) => (row.length ? row.map(csvEscape).join(",") : ""))
.join("\n");
const blob = new Blob([csv], { type: "text/csv" });
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
const stamp = new Date().toISOString().split("T")[0];
a.href = url;
a.download = `LetsParaConnect_TaxReport_${stamp}.csv`;
a.click();
URL.revokeObjectURL(url);
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
const taxRateLabel = formatTaxRatePercent(taxSummary.taxRate) || "22";
if (items[0]) items[0].innerHTML = `<strong>Gross Earnings:</strong> ${formatCurrency(taxSummary.grossEarnings)}`;
if (items[1]) items[1].innerHTML = `<strong>Deductible Expenses:</strong> ${formatCurrency(taxSummary.deductibleExpenses)}`;
if (items[2]) items[2].innerHTML = `<strong>Estimated Tax Owed (${taxRateLabel}%):</strong> ${formatCurrency(taxSummary.estimatedTax)}`;
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

function populateEscrowReportChart(data) {
  cacheCharts();
  const chart = chartCache.escrowReport;
  if (!chart) return;
  const trends = data?.escrowTrends || {};
  const months = Array.isArray(trends.months) ? trends.months : [];
  const labels = months.map((m) => formatMonthLabel(m));
  const held = (Array.isArray(trends.held) ? trends.held : []).map((v) =>
    Math.round((Number(v) || 0) / 100)
  );
  const released = (Array.isArray(trends.released) ? trends.released : []).map((v) =>
    Math.round((Number(v) || 0) / 100)
  );

  if (!chart.data.datasets[0]) {
    chart.data.datasets[0] = {
      label: "Held",
      data: [],
      borderColor: "#b6a47a",
      backgroundColor: "rgba(182,164,122,0.15)",
      tension: 0.4,
      fill: true,
    };
  }
  if (!chart.data.datasets[1]) {
    chart.data.datasets[1] = {
      label: "Released",
      data: [],
      borderColor: "#1f78d1",
      backgroundColor: "rgba(31,120,209,0.15)",
      tension: 0.4,
      fill: true,
    };
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = months.map((_, idx) => held[idx] || 0);
  chart.data.datasets[1].data = months.map((_, idx) => released[idx] || 0);
  chart.update("none");
}

function populateNewUsers(data) {
const users = filterActiveUsers(data?.recentUsers || recentUsersCache);
recentUsersCache = users;
newUsersPage = 1;
renderNewUsersPage();
}

if (newUsersPageSelect) {
  newUsersPageSelect.addEventListener("change", () => {
    newUsersPage = Number(newUsersPageSelect.value) || 1;
    renderNewUsersPage();
  });
}

function applyAnalyticsPayload(data) {
latestAnalytics = data;
lastAnalyticsRenderAt = Date.now();
populateMetrics(data);
populateCharts(data);
populateExpenseChart(data);
  populateEscrowReportChart(data);
populateLedger(data);
populateTaxSummary(data);
populatePayoutSchedule(data);
populateRegistrationChart(data);
populateEscrowChart(data);
populateNewUsers(data);
}

async function hydrateAnalytics() {
const now = Date.now();
if (latestAnalytics && now - lastAnalyticsRenderAt < ANALYTICS_COOLDOWN_MS) {
return latestAnalytics;
}
const data = await loadAnalytics();
if (!data) return null;
applyAnalyticsPayload(data);
return data;
}

function destroyCharts() {
cacheCharts();
Object.keys(chartCache).forEach((key) => {
const chart = chartCache[key];
if (chart?.destroy) {
try {
chart.destroy();
} catch (err) {
console.warn("Failed to destroy chart", err);
}
}
chartCache[key] = null;
});
}

window.deactivateUser = deactivateUser;
window.filterActiveUsers = filterActiveUsers;
window.removedUserIds = removedUserIds;
function filterActiveUsers(users = []) {
  return (users || []).filter((user) => {
    const id = String(user.id || user._id || "").trim();
    if (removedUserIds.has(id)) return false;
    const status = String(user.status || "").toLowerCase();
    if (status === "denied") return false;
    return true;
  });
}

async function deactivateUser(userId, { source } = {}) {
  if (!userId) return;
  const confirmed = window.confirm("Remove/deactivate this user?");
  if (!confirmed) return;
  try {
    await fetchCSRF();
  } catch (_) {}
  try {
    const res = await secureFetch(`/api/admin/users/${encodeURIComponent(userId)}/deny`, {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.msg || payload?.error || "Unable to remove user.");
    }
    showToast("User removed/deactivated.", "info");
    removedUserIds.add(String(userId));
    recentUsersCache = recentUsersCache.filter((u) => String(u.id || u._id) !== String(userId));
    if (source === "recent") {
      populateNewUsers({ recentUsers: recentUsersCache });
    }
    if (Array.isArray(window.pendingUsers)) {
      window.pendingUsers = window.pendingUsers.filter((u) => String(u.id || u._id) !== String(userId));
      window.renderPendingUsers?.();
      window.updatePendingCount?.(window.pendingUsers.length);
    }
    await hydrateAnalytics();
  } catch (err) {
    showToast(err?.message || "Unable to remove user.", "err");
  }
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

function buildFileHref(value) {
const raw = String(value || "").trim();
if (!raw) return "";
if (/^https?:\/\//i.test(raw)) return raw;
if (raw.startsWith("/api/uploads/view")) return raw;
return `/api/uploads/view?key=${encodeURIComponent(raw)}`;
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
const certificateHref = buildFileHref(p.certificateURL);
const certificate = certificateHref
? `<p><a href="${escapeAttribute(certificateHref)}" target="_blank" rel="noopener">Certificate</a></p>`
: "<p>Certificate not uploaded.</p>";
    return `
       <div class="verify-card" data-id="${id}">
         <strong>${lastName || "N/A"}, ${firstName || "N/A"}</strong>
         <p>Email: ${email || "N/A"}</p>
         <p>Years Experience: ${yearsLabel}</p>
         ${linkedIn}
         ${certificate}
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

bindSettingsActions();
await loadAdminSettings();
await hydrateAnalytics();

const taxReportBtn = document.getElementById("taxReportBtn");
if (taxReportBtn) {
taxReportBtn.addEventListener("click", async () => {
const originalLabel = taxReportBtn.textContent || "Generate Tax Report";
taxReportBtn.disabled = true;
taxReportBtn.textContent = "Generating...";
try {
const payload = latestAnalytics || (await hydrateAnalytics());
if (!payload) throw new Error("Unable to load tax summary.");
downloadTaxReport(payload);
showToast("Tax report generated.", "ok");
} catch (err) {
showToast(err?.message || "Unable to generate tax report.", "err");
} finally {
taxReportBtn.disabled = false;
taxReportBtn.textContent = originalLabel;
}
});
}
});

document.addEventListener("visibilitychange", () => {
if (document.hidden) {
destroyCharts();
}
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
await hydrateAnalytics();
if (typeof window.loadPendingUsers === "function") {
await window.loadPendingUsers();
}
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
await hydrateAnalytics();
if (typeof window.loadPendingUsers === "function") {
await window.loadPendingUsers();
}
} catch (err) {
console.error("Failed to reject paralegal", err);
}
}
});
