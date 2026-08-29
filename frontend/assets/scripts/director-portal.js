import { requireAuth, secureFetch } from "./auth.js";

requireAuth("director");

const stageFilter = document.getElementById("stageFilter");
const rangeFilter = document.getElementById("rangeFilter");
const selectedStateSelect = document.getElementById("selectedStateSelect");
const clearSelectedRowsBtn = document.getElementById("clearSelectedRowsBtn");
const bulkStateBar = document.getElementById("bulkStateBar");
const selectedRowsCount = document.getElementById("selectedRowsCount");
const selectPageRowsCheckbox = document.getElementById("selectPageRowsCheckbox");
const recordSearchInput = document.getElementById("recordSearchInput");
const statusEl = document.getElementById("directorStatus");
const recordsBody = document.getElementById("recordsBody");
const identityEl = document.getElementById("directorIdentity");
const openZohoBtn = document.getElementById("openZohoBtn");
const recordsSortButtons = Array.from(document.querySelectorAll("[data-sort-key]"));
const RECORDS_PER_PAGE = 10;
const ZOHO_MAIL_URL = "https://mail.zoho.com/";
const ZOHO_MAIL_APP_URL = "zohomail://";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const US_STATE_CODES = Object.freeze([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);
const US_STATE_NAMES = Object.freeze({
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
});
let currentRecords = [];
let currentPage = 1;
let statusTimer = null;
let autoRefreshTimer = null;
let portalLoadInFlight = false;
let recordsSort = { key: "", direction: "asc" };
let recordSearchQuery = "";
const selectedRecordIds = new Set();

function getSelectedRangeDays() {
  const value = Number(rangeFilter?.value || 7);
  return [1, 7, 30].includes(value) ? value : 7;
}

function populateSelectedStateOptions() {
  if (!selectedStateSelect) return;
  selectedStateSelect.innerHTML = [
    `<option value="">Choose state…</option>`,
    ...US_STATE_CODES.map(
      (state) => `<option value="${escapeHTML(state)}">${escapeHTML(state)} — ${escapeHTML(US_STATE_NAMES[state])}</option>`
    ),
  ].join("");
}

function syncSelectionControls() {
  const selectedCount = selectedRecordIds.size;
  if (bulkStateBar) bulkStateBar.hidden = selectedCount === 0;
  if (selectedRowsCount) selectedRowsCount.textContent = `${selectedCount} attorney${selectedCount === 1 ? "" : "s"} selected`;
  if (selectedStateSelect && !selectedStateSelect.disabled) selectedStateSelect.value = "";
  syncPageSelectCheckbox();
}

function clearSelectedRows() {
  selectedRecordIds.clear();
  syncSelectionControls();
  renderCurrentRecordsPage();
}

function pruneSelectedRows() {
  const availableIds = new Set(currentRecords.map((record) => String(record.id || "")).filter(Boolean));
  Array.from(selectedRecordIds).forEach((id) => {
    if (!availableIds.has(id)) selectedRecordIds.delete(id);
  });
  syncSelectionControls();
}

function setRowSelected(recordId, selected) {
  const id = String(recordId || "");
  if (!id) return;
  if (selected) selectedRecordIds.add(id);
  else selectedRecordIds.delete(id);
  const row = recordsBody?.querySelector?.(`[data-record-row-id="${CSS.escape(id)}"]`);
  row?.classList.toggle("is-selected", selectedRecordIds.has(id));
  row?.setAttribute("aria-selected", selectedRecordIds.has(id) ? "true" : "false");
  const checkbox = row?.querySelector?.("[data-record-select-id]");
  if (checkbox) checkbox.checked = selectedRecordIds.has(id);
  syncSelectionControls();
}

function getCurrentPageRecords() {
  const visibleRecords = getFilteredRecords();
  const totalPages = Math.max(1, Math.ceil(visibleRecords.length / RECORDS_PER_PAGE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (currentPage - 1) * RECORDS_PER_PAGE;
  return getSortedRecords(visibleRecords).slice(start, start + RECORDS_PER_PAGE);
}

function getFilteredRecords() {
  if (!recordSearchQuery) return currentRecords;
  return currentRecords.filter((record) => (
    `${record.attorneyName || ""} ${record.attorneyEmail || ""}`.toLowerCase().includes(recordSearchQuery)
  ));
}

function getCurrentPageRecordIds() {
  return getCurrentPageRecords().map((record) => String(record.id || "")).filter(Boolean);
}

function syncPageSelectCheckbox() {
  if (!selectPageRowsCheckbox) return;
  const pageIds = getCurrentPageRecordIds();
  const selectedOnPage = pageIds.filter((id) => selectedRecordIds.has(id)).length;
  selectPageRowsCheckbox.disabled = pageIds.length === 0;
  selectPageRowsCheckbox.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
  selectPageRowsCheckbox.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
}

function setPageRowsSelected(selected) {
  getCurrentPageRecordIds().forEach((id) => {
    if (selected) selectedRecordIds.add(id);
    else selectedRecordIds.delete(id);
  });
  syncSelectionControls();
  renderCurrentRecordsPage();
}

function setStatus(message, { tone = "", transient = false } = {}) {
  if (!statusEl) return;
  clearTimeout(statusTimer);
  statusEl.classList.remove("success", "error", "fade-out");
  if (tone) statusEl.classList.add(tone);
  statusEl.textContent = message || "";
  if (transient && message) {
    statusTimer = setTimeout(() => {
      statusEl.classList.add("fade-out");
      statusTimer = setTimeout(() => {
        statusEl.textContent = "";
        statusEl.classList.remove("success", "error", "fade-out");
      }, 260);
    }, 2600);
  }
}

function isMobileDevice() {
  return (
    window.matchMedia?.("(max-width: 760px)")?.matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
  );
}

function openZohoMail() {
  if (isMobileDevice()) {
    const startedAt = Date.now();
    window.location.href = ZOHO_MAIL_APP_URL;
    window.setTimeout(() => {
      if (Date.now() - startedAt < 1800) {
        window.location.href = ZOHO_MAIL_URL;
      }
    }, 900);
    return;
  }
  window.open(ZOHO_MAIL_URL, "_blank", "noopener,noreferrer");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatExactDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return "just now";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  if (elapsedSeconds < 604800) return `${Math.floor(elapsedSeconds / 86400)}d ago`;
  return formatExactDateTime(value);
}

function renderRelativeMeta(element, value, label) {
  if (!element || !value) {
    if (element) {
      element.textContent = "";
      element.removeAttribute("title");
    }
    return;
  }
  const exact = formatExactDateTime(value);
  if (!exact) return;
  element.textContent = `${label} ${formatRelativeTime(value)}`;
  element.title = `${label}: ${exact}`;
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);
}

function payoutStatusLabel(record = {}) {
  const hasCommission = Number(record.commissionEarnedCents || 0) > 0;
  if (!hasCommission) return "—";
  const paid = String(record.commissionPayoutStatus || "unpaid").toLowerCase() === "paid";
  if (!paid) return "Payable";
  return record.commissionPaidAt ? `Paid ${formatDate(record.commissionPaidAt)}` : "Paid";
}

function getRecordSortValue(record = {}, key = "") {
  switch (key) {
    case "outreach":
      return { type: "date", value: record.firstOutreachSentAt };
    case "followUp":
      return { type: "date", value: record.followUpSentAt };
    case "registered":
      return { type: "date", value: record.registeredAt };
    case "matter":
      return { type: "date", value: record.firstMatterPostedAt || record.firstMatterCompletedAt };
    case "commission":
      return { type: "number", value: Number(record.commissionEarnedCents || 0) };
    case "state":
      return { type: "text", value: record.state };
    case "attorney":
      return { type: "text", value: record.attorneyName };
    case "email":
      return { type: "text", value: record.attorneyEmail };
    case "stage":
      return { type: "text", value: record.stageLabel || record.stage };
    default:
      return { type: "text", value: "" };
  }
}

function normalizeSortValue({ type, value } = {}) {
  if (type === "date") {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (type === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  const text = String(value || "").trim().toLowerCase();
  return text || null;
}

function compareRecordValues(aRecord = {}, bRecord = {}, key = "", direction = "asc") {
  const aMeta = getRecordSortValue(aRecord, key);
  const bMeta = getRecordSortValue(bRecord, key);
  const aValue = normalizeSortValue(aMeta);
  const bValue = normalizeSortValue(bMeta);
  const aMissing = aValue === null;
  const bMissing = bValue === null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  let result = 0;
  if (aMeta.type === "text") {
    result = String(aValue).localeCompare(String(bValue), undefined, { sensitivity: "base" });
  } else {
    result = aValue - bValue;
  }
  return direction === "desc" ? result * -1 : result;
}

function getSortedRecords(records = []) {
  if (!recordsSort.key) return records;
  return [...records].sort((a, b) => compareRecordValues(a, b, recordsSort.key, recordsSort.direction));
}

function updateSortHeaders() {
  recordsSortButtons.forEach((button) => {
    const active = button.dataset.sortKey === recordsSort.key;
    const direction = active ? recordsSort.direction : "";
    button.dataset.sortActive = active ? "true" : "false";
    button.dataset.sortIcon = direction === "desc" ? "↓" : "↑";
    button.setAttribute(
      "aria-label",
      `${button.textContent.trim()} sort ${active && direction === "asc" ? "descending" : "ascending"}`
    );
    button.closest("th")?.setAttribute(
      "aria-sort",
      !active ? "none" : direction === "desc" ? "descending" : "ascending"
    );
  });
}

function renderStateSelect(record = {}) {
  const recordId = String(record.id || "");
  const currentState = String(record.state || "").toUpperCase();
  const options = [
    `<option value="">Choose state…</option>`,
    ...US_STATE_CODES.map((state) => (
      `<option value="${escapeHTML(state)}"${currentState === state ? " selected" : ""}>${escapeHTML(state)} — ${escapeHTML(US_STATE_NAMES[state])}</option>`
    )),
  ].join("");
  return `<select class="record-state-select" data-record-state-id="${escapeHTML(recordId)}" aria-label="State for ${escapeHTML(record.attorneyName || record.attorneyEmail || "attorney")}">${options}</select>`;
}

async function updateRecordState(select) {
  const recordId = select?.dataset?.recordStateId || "";
  const state = String(select?.value || "").toUpperCase();
  if (!recordId || !state) return;
  const previousRecord = currentRecords.find((record) => String(record.id || "") === recordId);
  const previousState = previousRecord?.state || "";
  select.disabled = true;
  try {
    const res = await secureFetch(`/api/director/records/${encodeURIComponent(recordId)}/state`, {
      method: "PATCH",
      body: { state },
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to update attorney state.");
    currentRecords = currentRecords.map((record) => (String(record.id || "") === recordId ? payload.record || record : record));
    setStatus(`State set to ${state}.`, { tone: "success", transient: true });
    renderCurrentRecordsPage();
  } catch (err) {
    if (previousRecord) previousRecord.state = previousState;
    select.value = previousState;
    select.disabled = false;
    setStatus(err?.message || "Unable to update attorney state.", { tone: "error" });
  }
}

async function applyStateToSelectedRows() {
  const state = String(selectedStateSelect?.value || "").toUpperCase();
  if (!state || !US_STATE_CODES.includes(state)) {
    setStatus("Choose a state for the selected rows.", { tone: "error", transient: true });
    return;
  }
  const recordIds = Array.from(selectedRecordIds);
  if (!recordIds.length) {
    setStatus("Select at least one row first.", { tone: "error", transient: true });
    return;
  }

  if (clearSelectedRowsBtn) clearSelectedRowsBtn.disabled = true;
  if (selectPageRowsCheckbox) selectPageRowsCheckbox.disabled = true;
  if (selectedStateSelect) selectedStateSelect.disabled = true;
  setStatus(`Applying ${state} to ${recordIds.length} selected row${recordIds.length === 1 ? "" : "s"}...`);

  let updated = 0;
  try {
    for (const recordId of recordIds) {
      const res = await secureFetch(`/api/director/records/${encodeURIComponent(recordId)}/state`, {
        method: "PATCH",
        body: { state },
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonOrThrow(res, "Unable to update attorney state.");
      currentRecords = currentRecords.map((record) => (String(record.id || "") === recordId ? payload.record || record : record));
      updated += 1;
    }
    selectedRecordIds.clear();
    setStatus(`Set ${updated} attorney${updated === 1 ? "" : "s"} to ${US_STATE_NAMES[state]} (${state}).`, { tone: "success", transient: true });
    await loadPortal({ silent: true, preservePage: true });
  } catch (err) {
    setStatus(err?.message || "Unable to apply selected state.", { tone: "error" });
    renderCurrentRecordsPage();
  } finally {
    if (selectedStateSelect) selectedStateSelect.disabled = false;
    if (clearSelectedRowsBtn) clearSelectedRowsBtn.disabled = false;
    syncSelectionControls();
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readJsonOrThrow(res, fallback) {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || payload?.message || fallback);
  return payload;
}

function renderOverview(payload = {}) {
  const counts = payload.counts || {};
  const total = Number(counts.total || 0);
  const emailsSent = total;
  const registered =
    Number(counts.attorney_registered || 0) +
    Number(counts.follow_up_needed || 0) +
    Number(counts.follow_up_sent || 0);
  const completedMatterCount = Math.min(50, Number(counts.commissionableMatterCount || 0));
  const conversionPct = emailsSent ? Math.round((registered / emailsSent) * 100) : 0;
  const rangeDays = Number(payload.range?.days || getSelectedRangeDays());
  const rangeLabel = rangeDays === 1 ? "today" : rangeDays === 7 ? "last 7 days" : "last 30 days";

  const countFollowUpEl = document.getElementById("countFollowUp");
  if (countFollowUpEl) countFollowUpEl.textContent = String(counts.follow_up_sent || 0);
  const countAttentionEl = document.getElementById("countAttention");
  if (countAttentionEl) countAttentionEl.textContent = String(counts.founder_attention || 0);
  const commissionEarnedCents = Number(counts.commissionEarnedCents || 0);
  renderRelativeMeta(document.getElementById("lastSyncedAt"), payload.lastSyncedAt, "Synced");
  const emptyState = document.getElementById("directorEmptyState");
  if (emptyState) emptyState.classList.toggle("visible", total === 0);

  const attention = payload.attention || {};
  const attentionRepliesEl = document.getElementById("attentionReplies");
  if (attentionRepliesEl) attentionRepliesEl.textContent = String(attention.founderReplies || counts.founder_attention || 0);
  const attentionFollowUpsEl = document.getElementById("attentionFollowUps");
  if (attentionFollowUpsEl) attentionFollowUpsEl.textContent = String(attention.followUpsAutoSent || counts.follow_up_sent || 0);
  const failedFollowUpsEl = document.getElementById("attentionFailedFollowUps");
  if (failedFollowUpsEl) failedFollowUpsEl.textContent = String(attention.followUpsFailed || counts.follow_up_failed || 0);
  const attentionStrip = document.getElementById("attentionStrip");
  const commissionItem = document.getElementById("attentionCommissionItem");
  const attentionCommissionEl = document.getElementById("attentionCommission");
  if (commissionItem && attentionCommissionEl) {
    const hasEarnedCommission = commissionEarnedCents > 0;
    if (attentionStrip) attentionStrip.hidden = !hasEarnedCommission;
    commissionItem.hidden = !hasEarnedCommission;
    attentionCommissionEl.textContent = commissionEarnedCents > 0 ? formatMoney(commissionEarnedCents) : "—";
  }

  const emailsSentEl = document.getElementById("metricEmailsSent");
  const conversionEl = document.getElementById("metricConversionRate");
  const completedEl = document.getElementById("metricCompletedMatters");
  const completedCapEl = document.getElementById("metricCompletedCap");
  const completedBarEl = document.getElementById("completedMatterBar");

  if (emailsSentEl) emailsSentEl.textContent = String(emailsSent);
  if (conversionEl) conversionEl.textContent = `${conversionPct}%`;
  if (completedEl) completedEl.textContent = String(completedMatterCount);
  if (completedCapEl) completedCapEl.textContent = `${completedMatterCount}/50`;
  if (completedBarEl) completedBarEl.style.width = `${Math.min(100, completedMatterCount * 2)}%`;

  if (payload.profile) {
    if (identityEl) identityEl.textContent = `${payload.profile.displayName || "Director"} · ${payload.profile.zohoEmail}`;
  }
  document.querySelectorAll("[data-range-note]").forEach((node) => {
    node.textContent = rangeLabel;
  });
}

function seriesValues(series = [], key = "") {
  return (Array.isArray(series) ? series : []).map((item) => Number(item?.[key] || 0));
}

function setMiniBars(selector, values = []) {
  const bars = Array.from(document.querySelectorAll(`${selector} span`));
  if (!bars.length) return;
  const data = values.slice(-bars.length);
  while (data.length < bars.length) data.unshift(0);
  const hasData = data.some((value) => Number(value) > 0);
  document.querySelector(selector)?.classList.toggle("is-empty", !hasData);
  const max = Math.max(1, ...data);
  bars.forEach((bar, index) => {
    const value = data[index] || 0;
    bar.style.height = value ? `${Math.max(12, Math.round((value / max) * 82))}%` : "0%";
    bar.style.opacity = value ? "1" : "0";
  });
}

function setDotGrid(selector, activeCount = 0) {
  const dots = Array.from(document.querySelectorAll(`${selector} span`));
  if (!dots.length) return;
  const active = Math.min(dots.length, Math.max(0, Number(activeCount) || 0));
  document.querySelector(selector)?.classList.toggle("is-empty", active === 0);
  dots.forEach((dot, index) => {
    dot.style.background = index < active ? "rgba(104, 198, 138, 0.62)" : "var(--director-dot-idle)";
  });
}

function setArcGauge(percent = 0) {
  const arc = document.querySelector(".arc-chart");
  if (!arc) return;
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  arc.classList.toggle("is-empty", clamped === 0);
  if (clamped === 0) {
    arc.style.background = "none";
    return;
  }
  const end = 16 + clamped * 0.6;
  arc.style.background = `
    radial-gradient(circle at center bottom, var(--director-card-bg) 0 52%, transparent 53%),
    conic-gradient(from 245deg, transparent 0 16%, #8bb7f4 16% ${end}%, var(--director-soft-track) ${end}% 76%, transparent 76% 100%)
  `;
}

function pointsForSeries(values = [], { width = 900, height = 246, padding = 18, max = 1 } = {}) {
  const data = values.length ? values : [0];
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const denominator = Math.max(1, data.length - 1);
  return data
    .map((value, index) => {
      const x = padding + (index / denominator) * usableWidth;
      const y = height - padding - (Number(value || 0) / max) * usableHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function renderPerformanceChart(analytics = {}) {
  const chart = document.querySelector(".performance-chart");
  const svg = chart?.querySelector("svg");
  if (!chart || !svg) return;
  const series = Array.isArray(analytics.series) ? analytics.series : [];
  const registrationValues = seriesValues(series, "registrations");
  const followUpValues = seriesValues(series, "followUps");
  const completedValues = seriesValues(series, "mattersCompleted");
  const hasData = [...registrationValues, ...followUpValues, ...completedValues]
    .some((value) => Number(value) > 0);
  chart.classList.toggle("is-empty", !hasData);
  chart.closest(".director-performance")?.classList.toggle("is-empty", !hasData);
  chart.setAttribute(
    "aria-label",
    hasData ? "Outreach performance chart for the selected period" : "No outreach performance data for this period"
  );
  if (!hasData) {
    svg.replaceChildren();
    return;
  }
  const max = Math.max(1, ...registrationValues, ...followUpValues, ...completedValues);
  svg.innerHTML = `
    <polyline points="${pointsForSeries(registrationValues, { max })}" fill="none" stroke="var(--director-graph-primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <polyline points="${pointsForSeries(followUpValues, { max })}" fill="none" stroke="var(--director-graph-secondary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <polyline points="${pointsForSeries(completedValues, { max })}" fill="none" stroke="var(--director-graph-tertiary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
  `;
}

function renderAnalytics(analytics = {}) {
  const totals = analytics.totals || {};
  const series = Array.isArray(analytics.series) ? analytics.series : [];
  const emailsSent = Number(totals.emailsSent || 0);
  const conversionPct = Number(totals.conversionRatePct || 0);
  const completedMatterCount = Math.min(50, Number(totals.commissionableMatters || 0));
  const registeredCount = Number(totals.registrations || 0);
  const followUpsSent = Number(totals.followUps || 0);

  const emailsSentEl = document.getElementById("metricEmailsSent");
  const registeredEl = document.getElementById("metricRegisteredCount");
  const conversionEl = document.getElementById("metricConversionRate");
  const completedEl = document.getElementById("metricCompletedMatters");
  const completedCapEl = document.getElementById("metricCompletedCap");
  const completedBarEl = document.getElementById("completedMatterBar");
  const followUpsSentEl = document.getElementById("metricFollowUpsSent");

  if (emailsSentEl) emailsSentEl.textContent = String(emailsSent);
  if (registeredEl) registeredEl.textContent = String(registeredCount);
  if (conversionEl) conversionEl.textContent = `${conversionPct}%`;
  if (completedEl) completedEl.textContent = String(completedMatterCount);
  if (completedCapEl) completedCapEl.textContent = `${completedMatterCount}/50`;
  if (completedBarEl) completedBarEl.style.width = `${Math.min(100, completedMatterCount * 2)}%`;
  if (followUpsSentEl) followUpsSentEl.textContent = String(followUpsSent);

  document.querySelector(".tiny-line")?.classList.toggle("is-empty", followUpsSent === 0);

  setArcGauge(emailsSent ? Math.min(100, emailsSent * 8) : 0);
  setDotGrid(".open-card .dot-grid", registeredCount);
  setMiniBars(".conversion-card .mini-bars", seriesValues(series, "registrations"));
  renderPerformanceChart(analytics);
}

function renderRecords(records = [], { preservePage = false } = {}) {
  const previousPage = currentPage;
  currentRecords = Array.isArray(records) ? records : [];
  currentPage = preservePage ? previousPage : 1;
  pruneSelectedRows();
  renderCurrentRecordsPage();
}

function renderCurrentRecordsPage() {
  if (!recordsBody) return;
  updateSortHeaders();
  const visibleRecords = getFilteredRecords();
  if (!visibleRecords.length) {
    const filterLabel = stageFilter?.selectedOptions?.[0]?.textContent || "this view";
    const emptyMessage = recordSearchQuery
      ? `No attorneys match “${recordSearchInput?.value?.trim() || recordSearchQuery}”.`
      : filterLabel === "All stages" ? "Import today to add records." : `No records match ${filterLabel}.`;
    recordsBody.innerHTML = `
      <tr class="records-empty">
        <td colspan="11">
          <strong>No attorneys found</strong>
          ${escapeHTML(emptyMessage)}
        </td>
      </tr>
    `;
    renderPagination();
    return;
  }
  const pageRecords = getCurrentPageRecords();

  recordsBody.innerHTML = pageRecords
    .map((record) => {
      const recordId = String(record.id || "");
      const stage = String(record.stage || "");
      const stageClass =
        stage === "founder_attention"
          ? " attention"
          : stage === "follow_up_failed"
          ? " attention"
          : stage === "attorney_registered" || stage === "follow_up_needed"
          ? " registered"
          : stage === "follow_up_sent"
          ? " registered"
          : stage === "matter_posted" || stage === "matter_completed"
          ? " matter"
          : stage === "commission_complete"
          ? " commission"
          : "";
      return `
        <tr data-record-row-id="${escapeHTML(recordId)}" tabindex="0" aria-selected="${selectedRecordIds.has(recordId) ? "true" : "false"}" class="${selectedRecordIds.has(recordId) ? "is-selected" : ""}">
          <td class="director-select-cell" data-label="Select">
            <input type="checkbox" class="director-row-checkbox" data-record-select-id="${escapeHTML(recordId)}" aria-label="Select ${escapeHTML(record.attorneyName || record.attorneyEmail || "row")}"${selectedRecordIds.has(recordId) ? " checked" : ""}>
          </td>
          <td data-label="Outreach">${escapeHTML(formatDate(record.firstOutreachSentAt))}</td>
          <td data-label="State">${renderStateSelect(record)}</td>
          <td data-label="Attorney">${escapeHTML(record.attorneyName || "—")}</td>
          <td data-label="Email">${escapeHTML(record.attorneyEmail || "—")}</td>
          <td data-label="Stage"><span class="director-badge${stageClass}">${escapeHTML(record.stageLabel || record.stage || "—")}</span></td>
          <td data-label="Follow-Up" data-responsive-priority="low">${escapeHTML(formatDate(record.followUpSentAt))}</td>
          <td data-label="Registered" data-responsive-priority="medium">${escapeHTML(formatDate(record.registeredAt))}</td>
          <td data-label="Matter" data-responsive-priority="low">${escapeHTML(formatDate(record.firstMatterPostedAt || record.firstMatterCompletedAt))}</td>
          <td data-label="Commission" data-responsive-priority="medium">${escapeHTML(Number(record.commissionEarnedCents || 0) > 0 ? formatMoney(record.commissionEarnedCents) : "—")}</td>
          <td data-label="Payout" data-responsive-priority="low">${escapeHTML(payoutStatusLabel(record))}</td>
        </tr>
      `;
    })
    .join("");
  syncSelectionControls();
  renderPagination();
}

function renderPagination() {
  const pagination = document.getElementById("recordsPagination");
  const pageInfo = document.getElementById("recordsPageInfo");
  const prevBtn = document.getElementById("recordsPrevBtn");
  const nextBtn = document.getElementById("recordsNextBtn");
  if (!pagination || !pageInfo || !prevBtn || !nextBtn) return;

  const total = getFilteredRecords().length;
  const totalPages = Math.max(1, Math.ceil(total / RECORDS_PER_PAGE));
  const shouldShow = total > RECORDS_PER_PAGE;
  pagination.hidden = !shouldShow;
  if (!shouldShow) return;

  const start = (currentPage - 1) * RECORDS_PER_PAGE + 1;
  const end = Math.min(total, currentPage * RECORDS_PER_PAGE);
  pageInfo.textContent = `${start}-${end} of ${total}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}

async function loadPortal({ silent = false, preservePage = false } = {}) {
  if (portalLoadInFlight) return;
  portalLoadInFlight = true;
  if (!silent) setStatus("");
  try {
    const rangeDays = getSelectedRangeDays();
    const recordParams = new URLSearchParams({
      stage: stageFilter?.value || "",
      rangeDays: String(rangeDays),
      limit: "250",
    });
    const [overviewRes, analyticsRes, recordsRes] = await Promise.all([
      secureFetch(`/api/director/overview?${new URLSearchParams({ rangeDays: String(rangeDays) })}`, { headers: { Accept: "application/json" } }),
      secureFetch(`/api/director/analytics?${new URLSearchParams({ days: String(rangeDays) })}`, { headers: { Accept: "application/json" } }),
      secureFetch(`/api/director/records?${recordParams}`, {
        headers: { Accept: "application/json" },
      }),
    ]);
    const overview = await readJsonOrThrow(overviewRes, "Unable to load director overview.");
    const analytics = await readJsonOrThrow(analyticsRes, "Unable to load director analytics.");
    const records = await readJsonOrThrow(recordsRes, "Unable to load director records.");
    renderOverview(overview);
    renderAnalytics(analytics);
    renderRecords(records.records || [], { preservePage });
    if (!silent) setStatus("");
  } catch (err) {
    if (!silent) {
      renderRecords([], { preservePage });
      setStatus("Unable to load.", { tone: "error" });
    } else {
      console.warn("[director] auto refresh failed", err);
    }
  } finally {
    portalLoadInFlight = false;
  }
}

function scheduleAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    loadPortal({ silent: true, preservePage: true }).catch((error) => {
      console.warn("[director] scheduled refresh rejected", error);
    });
  }, AUTO_REFRESH_MS);
}

async function importToday() {
  setStatus("Syncing Zoho...");
  try {
    const res = await secureFetch("/api/director/import-today", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to import today's outreach.");
    await checkReplies({ silent: true, reload: false });
    await loadPortal();
    setStatus(`Sync complete: ${payload.imported || 0} sent message${Number(payload.imported || 0) === 1 ? "" : "s"} imported.`, {
      tone: "success",
      transient: true,
    });
  } catch (err) {
    setStatus(err?.message || "Import unavailable. Try again later.", { tone: "error" });
  }
}

async function checkReplies({ silent = false, reload = true } = {}) {
  if (!silent) setStatus("Checking replies...");
  try {
    const res = await secureFetch("/api/director/import-replies", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to check replies.");
    if (reload) await loadPortal();
    if (!silent) {
      setStatus(`Replies flagged: ${payload.imported || 0}`);
    }
  } catch (err) {
    if (!silent) setStatus(err?.message || "Unable to check replies.");
    else console.warn("[director] automatic reply check failed", err);
  }
}

document.getElementById("importTodayBtn")?.addEventListener("click", importToday);
openZohoBtn?.addEventListener("click", openZohoMail);
recordsSortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sortKey || "";
    if (!key) return;
    recordsSort = {
      key,
      direction: recordsSort.key === key && recordsSort.direction === "asc" ? "desc" : "asc",
    };
    currentPage = 1;
    renderCurrentRecordsPage();
  });
});
recordsBody?.addEventListener("change", (event) => {
  const checkbox = event.target?.closest?.("[data-record-select-id]");
  if (checkbox) {
    setRowSelected(checkbox.dataset.recordSelectId || "", checkbox.checked);
    return;
  }
  const select = event.target?.closest?.("[data-record-state-id]");
  if (!select) return;
  updateRecordState(select);
});
recordsBody?.addEventListener("click", (event) => {
  if (event.target?.closest?.("a, button, input, select, label, summary, details")) return;
  const row = event.target?.closest?.("[data-record-row-id]");
  if (!row) return;
  const recordId = row.dataset.recordRowId || "";
  setRowSelected(recordId, !selectedRecordIds.has(recordId));
});
recordsBody?.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key) || event.target?.closest?.("a, button, input, select, label, summary, details")) return;
  const row = event.target?.closest?.("[data-record-row-id]");
  if (!row) return;
  event.preventDefault();
  const recordId = row.dataset.recordRowId || "";
  setRowSelected(recordId, !selectedRecordIds.has(recordId));
});
document.getElementById("recordsPrevBtn")?.addEventListener("click", () => {
  currentPage -= 1;
  renderCurrentRecordsPage();
});
document.getElementById("recordsNextBtn")?.addEventListener("click", () => {
  currentPage += 1;
  renderCurrentRecordsPage();
});
stageFilter?.addEventListener("change", () => loadPortal().catch((error) => {
  console.error("[director] stage filter refresh rejected", error);
}));
rangeFilter?.addEventListener("change", () => loadPortal().catch((error) => {
  console.error("[director] range filter refresh rejected", error);
}));
recordSearchInput?.addEventListener("input", () => {
  recordSearchQuery = String(recordSearchInput.value || "").trim().toLowerCase();
  currentPage = 1;
  renderCurrentRecordsPage();
});
selectPageRowsCheckbox?.addEventListener("change", () => setPageRowsSelected(selectPageRowsCheckbox.checked));
clearSelectedRowsBtn?.addEventListener("click", clearSelectedRows);
selectedStateSelect?.addEventListener("change", () => {
  if (!selectedStateSelect.value) return;
  applyStateToSelectedRows().catch((error) => {
    console.error("[director] bulk state update rejected", error);
  });
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadPortal({ silent: true, preservePage: true }).catch((error) => {
      console.warn("[director] visibility refresh rejected", error);
    });
  }
});

populateSelectedStateOptions();
syncSelectionControls();
loadPortal()
  .then(() => {
    scheduleAutoRefresh();
  })
  .catch(() => {
    scheduleAutoRefresh();
  });
