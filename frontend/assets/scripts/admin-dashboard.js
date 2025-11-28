import { secureFetch } from "./auth.js";

const METRICS_ENDPOINT = "/api/admin/metrics";
const SUMMARY_ENDPOINT = "/api/admin/summary";
const REFRESH_INTERVAL_MS = 60_000;

const chartCache = {
  userLine: null,
  combo: null,
  escrow: null,
};

let refreshTimer;
let summaryTimer;

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

async function loadSummary() {
  try {
    const res = await secureFetch(SUMMARY_ENDPOINT, {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderSummary(payload);
  } catch (err) {
    console.warn("Unable to load admin summary", err);
    renderSummary(null);
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

async function loadUsers() {
  await Promise.allSettled([loadPendingParalegals(), loadMetrics()]);
}

function renderSummary(data) {
  const totals = {
    totalUsers: Number(data?.totalUsers) || 0,
    pendingUsers: Number(data?.pendingUsers) || 0,
    activeCases: Number(data?.activeCases) || 0,
    completedCases: Number(data?.completedCases) || 0,
    escrowHold: Number(data?.totalEscrowHold) || 0,
    escrowReleased: Number(data?.totalEscrowReleased) || 0,
  };
  const metricCards = document.querySelectorAll(".metrics .metric");
  const cardDefinitions = [
    { label: "Total Users", value: formatSummaryNumber(totals.totalUsers) },
    { label: "Pending Approvals", value: formatSummaryNumber(totals.pendingUsers) },
    { label: "Active Cases", value: formatSummaryNumber(totals.activeCases) },
    { label: "Completed Cases", value: formatSummaryNumber(totals.completedCases) },
  ];
  cardDefinitions.forEach((def, index) => {
    const card = metricCards[index];
    if (!card) return;
    const title = card.querySelector("h3");
    const value = card.querySelector("p");
    if (title) title.textContent = def.label;
    if (value) value.textContent = def.value;
  });
  renderQuickStats(totals);
}

function renderQuickStats(totals) {
  const quickStatNodes = document.querySelectorAll(".quick-stats div");
  const configs = [
    { label: "Total Users", value: formatSummaryNumber(totals.totalUsers) },
    { label: "Pending Approvals", value: formatSummaryNumber(totals.pendingUsers) },
    { label: "Active Cases", value: formatSummaryNumber(totals.activeCases) },
    { label: "Completed Cases", value: formatSummaryNumber(totals.completedCases) },
    { label: "Escrow In Progress", value: formatSummaryCurrency(totals.escrowHold) },
    { label: "Escrow Released", value: formatSummaryCurrency(totals.escrowReleased) },
  ];
  configs.forEach((config, index) => {
    const node = quickStatNodes[index];
    if (!node) return;
    let strong = node.querySelector("strong");
    let span = node.querySelector("span");
    if (!strong) {
      strong = document.createElement("strong");
      node.prepend(strong);
    }
    if (!span) {
      span = document.createElement("span");
      node.appendChild(span);
    }
    strong.textContent = config.value;
    span.textContent = config.label;
  });
  for (let i = configs.length; i < quickStatNodes.length; i += 1) {
    const node = quickStatNodes[i];
    if (!node) continue;
    const strong = node.querySelector("strong");
    const span = node.querySelector("span");
    if (strong) strong.textContent = "—";
    if (span) span.textContent = "";
  }
}

function formatSummaryNumber(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString() : "0";
}

function formatSummaryCurrency(cents) {
  if (!Number.isFinite(cents)) return "$0";
  const dollars = Number(cents) / 100;
  return dollars.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function renderMetrics(data) {
  if (!chartCache.userLine && window.Chart?.getChart) {
    cacheCharts();
  }
  const totals = data?.totals || {};
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
      const bio = escapeHTML(p.bio || "No bio provided yet.");
      const educationItems = Array.isArray(p.education)
        ? p.education.filter((entry) => entry && (entry.degree || entry.institution || entry.certification || entry.year))
        : [];
      const educationMarkup = educationItems.length
        ? `<ul>${educationItems
            .map((entry) => {
              const parts = [
                entry.degree ? escapeHTML(entry.degree) : "",
                entry.institution ? escapeHTML(entry.institution) : "",
                entry.year ? escapeHTML(entry.year) : "",
                entry.certification ? escapeHTML(entry.certification) : "",
              ]
                .filter(Boolean)
                .join(" • ");
              return `<li>${parts || "Education detail"}</li>`;
            })
            .join("")}</ul>`
        : "<p>No education listed.</p>";
      const awardsList = Array.isArray(p.awards) ? p.awards.filter(Boolean) : [];
      const awardsMarkup = awardsList.length
        ? `<ul>${awardsList.map((award) => `<li>${escapeHTML(award)}</li>`).join("")}</ul>`
        : "<p>No awards listed.</p>";
      const skillsList = Array.isArray(p.highlightedSkills) ? p.highlightedSkills.filter(Boolean) : [];
      const skillsMarkup = skillsList.length
        ? `<p>${skillsList.map((skill) => `<span>${escapeHTML(skill)}</span>`).join(", ")}</p>`
        : "<p>No highlighted skills provided.</p>";
      return `
        <div class="verify-card" data-id="${id}">
          <strong>${lastName || "N/A"}, ${firstName || "N/A"}</strong>
          <p>Email: ${email || "N/A"}</p>
          <p>Years Experience: ${yearsLabel}</p>
          ${linkedIn}
          ${certificate}
          <div>
            <strong>Bio</strong>
            <p>${bio}</p>
          </div>
          <div>
            <strong>Education</strong>
            ${educationMarkup}
          </div>
          <div>
            <strong>Awards</strong>
            ${awardsMarkup}
          </div>
          <div>
            <strong>Highlighted Skills</strong>
            ${skillsMarkup}
          </div>
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

function startMetrics() {
  cacheCharts();
  loadMetrics();
  loadPendingParalegals();
  startSummary();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadMetrics();
    loadPendingParalegals();
  }, REFRESH_INTERVAL_MS);
}

function startSummary() {
  loadSummary();
  if (summaryTimer) clearInterval(summaryTimer);
  summaryTimer = setInterval(loadSummary, REFRESH_INTERVAL_MS);
}

async function bootAdminDashboard() {
  const user = typeof window.requireRole === "function" ? await window.requireRole("admin") : null;
  if (!user) return;
  applyRoleVisibility(user);
  await loadPendingParalegals();
  startMetrics();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadSummary();
    }
  });
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootAdminDashboard, { once: true });
} else {
  bootAdminDashboard();
}

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
