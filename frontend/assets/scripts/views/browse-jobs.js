import { secureFetch } from "../auth.js";
import { getStripeConnectStatus, isStripeConnected, STRIPE_GATE_MESSAGE } from "../utils/stripe-connect.js";

const jobsGrid = document.getElementById("jobs-grid");
const pagination = document.getElementById("pagination");
const jobModal = document.getElementById("jobModal");
const jobModalClose = document.getElementById("jobModalClose");
const jobModalBackdrop = jobModal?.querySelector(".job-modal-backdrop");
const jobTitleEl = document.getElementById("jobTitle");
const jobSummaryEl = document.getElementById("jobSummary");
const jobBodyEl = document.getElementById("jobBody");
const jobCompensationEl = document.getElementById("jobCompensation");
const jobApplyBtn = document.getElementById("jobApplyBtn");
const jobAttorneyButton = document.getElementById("jobAttorneyButton");
const jobAttorneyAvatar = document.getElementById("jobAttorneyAvatar");
const jobAttorneyName = document.getElementById("jobAttorneyName");
const jobAttorneyFirm = document.getElementById("jobAttorneyFirm");
const FALLBACK_AVATAR = "https://via.placeholder.com/64x64.png?text=A";
const attorneyPreviewCache = new Map();
const urlParams = new URLSearchParams(window.location.search);
const explicitCaseId = (urlParams.get("caseId") || urlParams.get("caseID") || urlParams.get("case_id") || "").trim();
const idParam = (urlParams.get("id") || "").trim();

let allJobs = [];
let filteredJobs = [];
const APPLY_MAX_CHARS = 2000;
const APPLIED_STORAGE_KEY = "lpc_applied_jobs";
const REAPPLY_BYPASS_EMAILS = new Set(["samanthasider+0@gmail.com"]);
const appliedJobs = new Map(); // applyKey -> appliedAt ISO
let viewerId = "";
let applyModal = null;
let applyTextarea = null;
let applyStatus = null;
let applySubmitBtn = null;
let applyTitle = null;
let applyCounter = null;
let applyConfirmModal = null;
let applyConfirmTitle = null;
let applyConfirmMessage = null;
let currentApplyJob = null;
let csrfToken = "";
const toast = window.toastUtils;
let expandedJobId = "";
let stripeConnected = false;
let viewerRole = "";
let allowApply = false;
let viewerState = "";
let viewerStateExperience = [];
let autoStateFilterApplied = false;
const initialJobParam = (idParam || explicitCaseId || "").trim();
const STRIPE_BYPASS_EMAILS = new Set([
  "samanthasider+11@gmail.com",
  "samanthasider+56@gmail.com",
]);
let viewerEmail = "";
const FLAG_REASONS = [
  { value: "inappropriate", label: "Inappropriate content" },
  { value: "spam", label: "Spam or misleading" },
  { value: "compensation", label: "Compensation issue" },
  { value: "duplicate", label: "Duplicate posting" },
  { value: "other", label: "Other" },
];
let openFlagMenu = null;
let flagMenuHandlersBound = false;

const STATE_NAME_MAP = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
const STATE_CODE_MAP = Object.fromEntries(
  Object.entries(STATE_NAME_MAP).map(([code, name]) => [name.toLowerCase(), code])
);

// Elements
const filterToggle = document.getElementById("filterToggle");
const filterMenu = document.getElementById("filterMenu");

const practiceAreaSelect = document.getElementById("filterPracticeArea");
const stateSelect = document.getElementById("filterState");
const sortSelect = document.getElementById("sortBy");

const minPaySlider = document.getElementById("filterMinPay");
const minPayValue = document.getElementById("minPayValue");

const minExpSlider = document.getElementById("filterMinExp");
const minExpValue = document.getElementById("minExpValue");

const applyFiltersBtn = document.getElementById("applyFilters");
const clearFiltersBtn = document.getElementById("clearFilters");

let sessionReady = false;
let modalJob = null;

function readStoredRole() {
  try {
    const raw = localStorage.getItem("lpc_user");
    if (!raw) return "";
    const user = JSON.parse(raw);
    return String(user?.role || "").toLowerCase();
  } catch {
    return "";
  }
}

function readStoredUserId() {
  try {
    const raw = localStorage.getItem("lpc_user");
    if (!raw) return "";
    const user = JSON.parse(raw);
    return String(user?.id || user?._id || "");
  } catch {
    return "";
  }
}

function readStoredUserEmail() {
  try {
    const raw = localStorage.getItem("lpc_user");
    if (!raw) return "";
    const user = JSON.parse(raw);
    return String(user?.email || "").toLowerCase().trim();
  } catch {
    return "";
  }
}

function isReapplyBypassUser() {
  return REAPPLY_BYPASS_EMAILS.has(viewerEmail);
}

function readStoredState() {
  try {
    const raw = localStorage.getItem("lpc_user");
    if (!raw) return "";
    const user = JSON.parse(raw);
    return String(user?.state || user?.location || "");
  } catch {
    return "";
  }
}

function readStoredStateExperience() {
  try {
    const raw = localStorage.getItem("lpc_user");
    if (!raw) return [];
    const user = JSON.parse(raw);
    return user?.stateExperience || [];
  } catch {
    return [];
  }
}

function normalizeViewerState(value) {
  return String(value || "").trim();
}

function normalizeStateExperience(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function resolveStateOption(rawState, options = []) {
  const trimmed = String(rawState || "").trim();
  if (!trimmed) return "";
  const direct = options.find((value) => value.toLowerCase() === trimmed.toLowerCase());
  if (direct) return direct;
  const upper = trimmed.toUpperCase();
  const mappedName = STATE_NAME_MAP[upper];
  if (mappedName) {
    const nameMatch = options.find((value) => value.toLowerCase() === mappedName.toLowerCase());
    if (nameMatch) return nameMatch;
  }
  const mappedCode = STATE_CODE_MAP[trimmed.toLowerCase()];
  if (mappedCode) {
    const codeMatch = options.find((value) => value.toLowerCase() === mappedCode.toLowerCase());
    if (codeMatch) return codeMatch;
  }
  return mappedName || mappedCode || trimmed;
}

function getAppliedStorageKey() {
  return viewerId ? `${APPLIED_STORAGE_KEY}:${viewerId}` : APPLIED_STORAGE_KEY;
}

async function resolveViewerRole() {
  const stored = readStoredRole();
  if (stored) return stored;
  if (typeof window.getSessionData === "function") {
    try {
      const data = await window.getSessionData();
      return String(data?.role || data?.user?.role || "").toLowerCase();
    } catch {
      return "";
    }
  }
  return "";
}

async function ensureSession() {
  if (sessionReady) return true;
  let session = null;
  try {
    if (typeof window.checkSession === "function") {
      session = await window.checkSession("paralegal", { redirectOnFail: false });
    }
    viewerRole = String(session?.role || session?.user?.role || "").toLowerCase();
    viewerId = String(session?.user?.id || session?.user?._id || session?.id || session?._id || readStoredUserId());
    viewerEmail = String(session?.user?.email || session?.email || "").toLowerCase().trim();
    if (!viewerEmail) viewerEmail = readStoredUserEmail();
    viewerState = normalizeViewerState(session?.user?.state || session?.user?.location || readStoredState());
    viewerStateExperience = normalizeStateExperience(
      session?.user?.stateExperience || readStoredStateExperience()
    );
    allowApply = viewerRole === "paralegal";
    sessionReady = true;
    if (!allowApply) {
      redirectNonParalegal(viewerRole);
      return false;
    }
    if (document.body) {
      document.body.classList.remove("auth-guarded");
    }
    return !!session;
  } catch (err) {
    console.warn("Paralegal session required", err);
    const storedRole = await resolveViewerRole();
    if (storedRole && storedRole !== "paralegal") {
      redirectNonParalegal(storedRole);
      return false;
    }
    window.location.href = "login.html";
    return false;
  }
}

function redirectNonParalegal(role) {
  const normalized = String(role || "").toLowerCase();
  if (!normalized || normalized === "paralegal") return;
  if (typeof window.redirectUserDashboard === "function") {
    window.redirectUserDashboard(normalized);
    return;
  }
  if (normalized === "admin") {
    window.location.href = "admin-dashboard.html";
  } else {
    window.location.href = "dashboard-attorney.html";
  }
}

function notifyStripeGate(message = STRIPE_GATE_MESSAGE) {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type: "error" });
  } else {
    alert(message);
  }
}

function stripeAllowed() {
  return stripeConnected || STRIPE_BYPASS_EMAILS.has(viewerEmail);
}

async function refreshStripeStatus() {
  const data = await getStripeConnectStatus();
  stripeConnected = isStripeConnected(data) || STRIPE_BYPASS_EMAILS.has(viewerEmail);
  return data;
}

// Toggle filter menu
if (filterToggle && filterMenu) {
  filterToggle.addEventListener("click", () => {
    filterMenu.classList.toggle("active");
  });

  document.addEventListener("click", (e) => {
    if (!filterMenu.contains(e.target) && !filterToggle.contains(e.target)) {
      filterMenu.classList.remove("active");
    }
  });
}

function quantizePayValue(raw) {
  const value = Math.max(0, Math.min(500, Number(raw) || 0));
  if (value <= 100) {
    return Math.max(0, Math.min(100, Math.round(value / 20) * 20));
  }
  const remainder = value - 100;
  const increments = Math.ceil(remainder / 50);
  return Math.min(500, 100 + increments * 50);
}

function updatePayLabel(value) {
  if (!minPayValue) return;
  const display = value >= 500 ? "$500+" : `$${value.toLocaleString()}`;
  minPayValue.textContent = display;
}

function clampExperienceValue(raw) {
  return Math.max(0, Math.min(10, Number(raw) || 0));
}

function updateExperienceLabel(value) {
  if (!minExpValue) return;
  const label = value <= 0 ? "Any" : value >= 10 ? "10+ years" : `${value} year${value === 1 ? "" : "s"}`;
  minExpValue.textContent = label;
}

// Dynamic filter population
function populateFilters() {
  if (!practiceAreaSelect || !stateSelect || !minPaySlider || !minExpSlider) return;

  // Practice areas
  const areas = [...new Set(allJobs.map((j) => j.practiceArea).filter(Boolean))];
  practiceAreaSelect.innerHTML =
    `<option value="">Any</option>` + areas.map((a) => `<option value="${a}">${a}</option>`).join("");

  // States
  const states = [...new Set(allJobs.map((j) => getJobState(j)).filter(Boolean))];
  const preferredState = resolveStateOption(viewerState, states);
  if (preferredState && !states.some((value) => value.toLowerCase() === preferredState.toLowerCase())) {
    states.push(preferredState);
  }
  const experienceStates = normalizeStateExperience(viewerStateExperience);
  experienceStates.forEach((entry) => {
    const preferred = resolveStateOption(entry, states);
    if (preferred && !states.some((value) => value.toLowerCase() === preferred.toLowerCase())) {
      states.push(preferred);
    }
  });
  stateSelect.innerHTML =
    `<option value="">Any</option>` + states.map((s) => `<option value="${s}">${s}</option>`).join("");

  // Pay slider
  minPaySlider.min = 0;
  minPaySlider.max = 500;
  minPaySlider.step = 10;
  minPaySlider.value = 0;
  updatePayLabel(0);

  // Experience slider
  minExpSlider.min = 0;
  minExpSlider.max = 10;
  minExpSlider.step = 1;
  minExpSlider.value = 0;
  updateExperienceLabel(0);
}

// Slider displays
minPaySlider?.addEventListener("input", () => {
  const value = quantizePayValue(minPaySlider.value);
  minPaySlider.value = value;
  updatePayLabel(value);
});

minExpSlider?.addEventListener("input", () => {
  const value = clampExperienceValue(minExpSlider.value);
  minExpSlider.value = value;
  updateExperienceLabel(value);
});

// Apply filters
function applyFilters(options = {}) {
  const { render = true } = options;
  const area = practiceAreaSelect?.value || "";
  const state = stateSelect?.value || "";
  const minPay = quantizePayValue(minPaySlider?.value || 0);
  const maxExpValue = clampExperienceValue(minExpSlider?.value || 0);
  const expLimit = maxExpValue >= 10 ? Infinity : maxExpValue;

  filteredJobs = allJobs.filter((job) => {
    if (shouldHideAppliedJob(job)) return false;
    const payUSD = getJobPayUSD(job);
    const exp = getJobExperience(job);
    const jobState = getJobState(job);

    if (area && job.practiceArea !== area) return false;
    if (state && jobState !== state) return false;
    if (payUSD < minPay) return false;
    if (expLimit !== Infinity && exp > expLimit) return false;

    return true;
  });

  applySort();
  if (render) {
    renderJobs();
    filterMenu?.classList.remove("active");
  }
}

applyFiltersBtn?.addEventListener("click", applyFilters);

function applyDefaultStateFilter() {
  if (autoStateFilterApplied || !viewerState || !stateSelect) return false;
  const options = Array.from(stateSelect.options || [])
    .map((opt) => opt.value)
    .filter(Boolean);
  const preferred = resolveStateOption(viewerState, options);
  if (!preferred) return false;
  stateSelect.value = preferred;
  autoStateFilterApplied = true;
  applyFilters({ render: false });
  if (!filteredJobs.length) {
    stateSelect.value = "";
    autoStateFilterApplied = false;
    applyFilters({ render: false });
    return false;
  }
  return true;
}

// Clear filters
function clearFilters() {
  if (practiceAreaSelect) practiceAreaSelect.value = "";
  if (stateSelect) stateSelect.value = "";
  if (minPaySlider) {
    minPaySlider.value = 0;
    updatePayLabel(0);
  }
  if (minExpSlider) {
    minExpSlider.value = 0;
    updateExperienceLabel(0);
  }
  if (sortSelect) sortSelect.value = "";

  filteredJobs = allJobs.filter((job) => !shouldHideAppliedJob(job));
  applySort();
  renderJobs();
  filterMenu?.classList.remove("active");
}

clearFiltersBtn?.addEventListener("click", clearFilters);

// Helpers
function getJobPayUSD(job) {
  if (!job) return 0;
  if (typeof job.remainingAmount === "number" && job.remainingAmount > 0) {
    return Math.max(0, job.remainingAmount / 100);
  }
  if (typeof job.lockedTotalAmount === "number" && job.lockedTotalAmount > 0) {
    return Math.max(0, job.lockedTotalAmount / 100);
  }
  if (typeof job.totalAmount === "number" && job.totalAmount > 0) return Math.max(0, job.totalAmount / 100);
  if (typeof job.payAmount === "number" && job.payAmount > 0) return Math.max(0, job.payAmount);
  const parsedBudget = Number(job.budget);
  if (Number.isFinite(parsedBudget) && parsedBudget > 0) return Math.max(0, parsedBudget);
  return 0;
}

function getJobExperience(job) {
  return Number(job?.minimumExperienceRequired ?? job?.minExperience ?? 0) || 0;
}

function getJobState(job) {
  return (
    job?.state ||
    job?.locationState ||
    job?.location?.state ||
    job?.jurisdiction ||
    job?.region ||
    ""
  );
}

function formatPay(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return rounded.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatAppliedDate(value) {
  if (!value) return "Applied";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Applied";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatAppliedLabel(value) {
  const dateLabel = formatAppliedDate(value);
  if (dateLabel === "Applied") return "Applied";
  return `Applied · ${dateLabel}`;
}

function isHiddenJob(job) {
  const title = String(job?.title || job?.caseTitle || "").trim().toLowerCase();
  const jobId = getJobIdForApply(job);
  return title.includes("job not found") || !jobId;
}

function isRelistedJob(job) {
  return Boolean(job?.relistRequestedAt);
}

function shouldHideAppliedJob(job) {
  if (!isAppliedJob(job)) return false;
  return !isRelistedJob(job);
}

function normalizeContentLines(raw) {
  const normalized = String(raw || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n");
  return normalized
    .split(/[\r\n]+|<[^>]+>/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isStateLine(line, jobState) {
  const state = String(jobState || "").trim().toLowerCase();
  const cleaned = String(line || "")
    .replace(/^[\s>*•\-–—]+/, "")
    .trim();
  const normalized = cleaned.toLowerCase();
  if (/^state\b/i.test(cleaned)) return true;
  if (state && normalized === state) return true;
  if (state && normalized === `state: ${state}`) return true;
  return false;
}

function scrubStateLines(raw, jobState) {
  const lines = normalizeContentLines(raw);
  return lines.filter((line) => !isStateLine(line, jobState)).join("\n");
}

function prepareExpandedContent(raw, jobState) {
  const cleaned = stripDuplicateStateLine(raw, jobState);
  const lines = normalizeContentLines(cleaned);
  let experienceLine = "";
  const filtered = lines.filter((line) => {
    if (!line) return false;
    if (!experienceLine && /^Experience\s*:/i.test(line)) {
      experienceLine = line;
      return false;
    }
    return true;
  });
  const description = filtered.join("\n").trim() || "No additional description provided for this case.";
  return { description, experienceLine: experienceLine.trim() };
}

function stripDuplicateStateLine(text, jobState) {
  const lines = normalizeContentLines(text);
  return lines
    .filter((line) => !isStateLine(line, jobState))
    .join("\n");
}

function applySort() {
  if (!sortSelect || !sortSelect.value) return;
  const mode = sortSelect.value;
  switch (mode) {
    case "newest":
      filteredJobs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      break;
    case "oldest":
      filteredJobs.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      break;
    case "payHigh":
      filteredJobs.sort((a, b) => getJobPayUSD(b) - getJobPayUSD(a));
      break;
    case "payLow":
      filteredJobs.sort((a, b) => getJobPayUSD(a) - getJobPayUSD(b));
      break;
    default:
      break;
  }
}

// Render jobs
function renderJobs() {
  if (!jobsGrid) return;
  jobsGrid.innerHTML = "";
  syncExpansionLayout();

  if (expandedJobId) {
    const expanded = filteredJobs.find((job) => getJobUniqueId(job) === expandedJobId);
    if (expanded) {
      jobsGrid.appendChild(renderExpandedJob(expanded));
      if (pagination) pagination.textContent = "";
      return;
    }
    expandedJobId = "";
    syncExpansionLayout();
  }

  if (!filteredJobs.length) {
    const empty = document.createElement("p");
    empty.className = "area";
    empty.style.textAlign = "center";
    empty.textContent = "No matters match your filters yet. Try adjusting filters or check back soon.";
    jobsGrid.appendChild(empty);
    if (pagination) pagination.textContent = "";
    return;
  }

  filteredJobs.forEach((job, idx) => {
    const card = document.createElement("div");
    card.classList.add("job-card");

    const payUSD = getJobPayUSD(job);
    const jobState = getJobState(job);
    const title = escapeHtml(job.title || "Untitled Matter");
    const practice = escapeHtml(job.practiceArea || "General Practice");
    const when = job.createdAt ? new Date(job.createdAt).toLocaleDateString() : "Recently posted";
    const jobId = getJobIdForApply(job);
    const caseId = getJobUniqueId(job) || jobId;
    const applyKey = getJobIdForApply(job);
    const appliedAt = getAppliedAt(job);

    card.innerHTML = `
      <div class="job-card-header">
        <div>
          <h3>${title}</h3>
          <div class="area">${practice}</div>
        </div>
      </div>
      <div class="meta">
        <span>${escapeHtml(jobState || "—")}</span>
        <span>$${formatPay(payUSD)}</span>
        <span>${escapeHtml(when)}</span>
      </div>
    `;

    const header = card.querySelector(".job-card-header");
    if (header) {
      const { button: flagButton, menu: flagMenu } = buildFlagButton(job);
      header.appendChild(flagButton);
      card.appendChild(flagMenu);
    }

    const actions = document.createElement("div");
    actions.className = "job-actions";

    const caseBtn = document.createElement("button");
    caseBtn.type = "button";
    caseBtn.className = "clear-button";
    caseBtn.textContent = "View Case";
    caseBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (caseId) {
        expandJob(job);
        return;
      }
      openJobModal(job);
    });
    actions.appendChild(caseBtn);

    actions.appendChild(buildApplyButton(job, applyKey || jobId || caseId, appliedAt));

    card.appendChild(actions);

    card.addEventListener("click", () => {
      openJobModal(job);
    });

    jobsGrid.appendChild(card);

    requestAnimationFrame(() => {
      setTimeout(() => card.classList.add("visible"), idx * 40);
    });
  });

  if (pagination) pagination.textContent = "";
}

// Fetch jobs
async function fetchJobs() {
  if (!sessionReady) return;
  try {
    const res = await fetch("/api/jobs/open", {
      headers: { Accept: "application/json" },
      credentials: "include",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (Array.isArray(data)) {
      allJobs = data;
    } else if (Array.isArray(data?.items)) {
      allJobs = data.items;
    } else {
      allJobs = [];
    }
    allJobs = allJobs.filter((job) => !isHiddenJob(job));
    allJobs = allJobs.filter((job) => !shouldHideAppliedJob(job));
    filteredJobs = [...allJobs];

    populateFilters();
    const autoFiltered = applyDefaultStateFilter();
    if (!autoFiltered) {
      applySort();
    }
    if (initialJobParam) {
      const match = filteredJobs.find((job) => getJobUniqueId(job) === initialJobParam);
      if (match) {
        expandedJobId = getJobUniqueId(match);
      }
    }
    renderJobs();
  } catch (err) {
    console.error("Failed to load jobs", err);
    allJobs = [];
    filteredJobs = [];
    renderJobs();
    if (jobsGrid) {
      const error = document.createElement("p");
      error.className = "area";
      error.style.textAlign = "center";
      error.textContent = "Unable to load open cases right now. Please refresh.";
      jobsGrid.appendChild(error);
    }
  }
}


ensureSession().then(async (ready) => {
  if (!ready) return;
  if (allowApply) {
    await refreshStripeStatus();
  }
  await hydrateAppliedJobs();
  fetchJobs();
});

sortSelect?.addEventListener("change", () => {
  applySort();
  renderJobs();
});

function openApplyModal(job) {
  if (!job) return;
  if (!allowApply) {
    showToast("Only paralegals can apply to cases.", "info");
    return;
  }
  if (!stripeAllowed()) {
    notifyStripeGate();
    return;
  }
  ensureApplyModal();
  const existingConfirm = applyModal.querySelector(".apply-confirm");
  if (existingConfirm) existingConfirm.remove();
  currentApplyJob = job;
  const target = resolveApplyTarget(job);
  if (!target) {
    showToast("Unable to apply to this case right now.", "error");
    return;
  }
  applyModal.dataset.applyType = target.type;
  applyModal.dataset.jobId = target.id;
  applyTitle.textContent = `Apply to ${escapeHtml(job.title || "this job")}`;
  applyTextarea.value = "";
  applyStatus.textContent = "";
  applyCounter.textContent = `0 / ${APPLY_MAX_CHARS}`;
  applySubmitBtn.disabled = false;
  applySubmitBtn.textContent = "Submit application";
  applyModal.classList.add("show");
  applyTextarea.focus();
}

function closeApplyModal() {
  if (applyModal) {
    applyModal.classList.remove("show");
    applyModal.querySelector(".apply-confirm")?.remove();
  }
  currentApplyJob = null;
}

function openApplyConfirmModal(jobTitle = "") {
  ensureApplyConfirmModal();
  if (applyConfirmTitle) applyConfirmTitle.textContent = "Applied";
  if (applyConfirmMessage) {
    const title = String(jobTitle || "").trim();
    applyConfirmMessage.textContent = title
      ? `Your application to ${title} has been submitted.`
      : "Your application has been submitted.";
  }
  if (applyConfirmModal) {
    applyConfirmModal.classList.add("show");
    const focusTarget = applyConfirmModal.querySelector("[data-apply-confirm-close]");
    focusTarget?.focus();
  }
}

function closeApplyConfirmModal() {
  if (applyConfirmModal) applyConfirmModal.classList.remove("show");
}

function ensureApplyModal() {
  if (applyModal) return;
  injectApplyStyles();
  applyModal = document.createElement("div");
  applyModal.className = "job-apply-overlay";
  applyModal.innerHTML = `
    <div class="job-apply-dialog" role="dialog" aria-modal="true">
      <header>
        <h3 data-apply-title>Apply to this job</h3>
        <button type="button" class="close-btn" aria-label="Close apply form">&times;</button>
      </header>
      <p class="muted">Share why you are a great fit (max ${APPLY_MAX_CHARS} characters).</p>
      <textarea rows="6" data-apply-text></textarea>
      <p class="apply-footnote">Your résumé and LinkedIn profile are included automatically.</p>
      <div class="apply-meta">
        <span data-apply-counter>0 / ${APPLY_MAX_CHARS}</span>
        <span data-apply-status></span>
      </div>
      <div class="modal-actions">
        <button type="button" class="clear-button" data-apply-cancel>Cancel</button>
        <button type="button" class="apply-button" data-apply-submit>Submit application</button>
      </div>
    </div>
  `;
  document.body.appendChild(applyModal);
  applyTextarea = applyModal.querySelector("[data-apply-text]");
  applyStatus = applyModal.querySelector("[data-apply-status]");
  applySubmitBtn = applyModal.querySelector("[data-apply-submit]");
  applyTitle = applyModal.querySelector("[data-apply-title]");
  applyCounter = applyModal.querySelector("[data-apply-counter]");
  applyModal.querySelector(".close-btn")?.addEventListener("click", closeApplyModal);
  applyModal.querySelector("[data-apply-cancel]")?.addEventListener("click", closeApplyModal);
  applyTextarea?.addEventListener("input", updateApplyCounter);
  applySubmitBtn?.addEventListener("click", submitApplication);
  applyModal.addEventListener("click", (event) => {
    if (event.target === applyModal) closeApplyModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && applyModal?.classList.contains("show")) {
      closeApplyModal();
    }
  });
}

function ensureApplyConfirmModal() {
  if (applyConfirmModal) return;
  injectApplyStyles();
  applyConfirmModal = document.createElement("div");
  applyConfirmModal.className = "apply-confirm-overlay";
  applyConfirmModal.innerHTML = `
    <div class="apply-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="applyConfirmTitle">
      <header>
        <h3 id="applyConfirmTitle" data-apply-confirm-title>Applied</h3>
      </header>
      <p class="apply-confirm-message" data-apply-confirm-message>Your application has been submitted.</p>
      <div class="apply-confirm-actions">
        <a class="apply-confirm-link" href="dashboard-paralegal.html#cases">View my applications</a>
        <button type="button" class="apply-confirm-close" data-apply-confirm-close>Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(applyConfirmModal);
  applyConfirmTitle = applyConfirmModal.querySelector("[data-apply-confirm-title]");
  applyConfirmMessage = applyConfirmModal.querySelector("[data-apply-confirm-message]");
  applyConfirmModal.querySelectorAll("[data-apply-confirm-close]").forEach((btn) => {
    btn.addEventListener("click", closeApplyConfirmModal);
  });
  applyConfirmModal.addEventListener("click", (event) => {
    if (event.target === applyConfirmModal) closeApplyConfirmModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && applyConfirmModal?.classList.contains("show")) {
      closeApplyConfirmModal();
    }
  });
}

function updateApplyCounter() {
  if (!applyTextarea || !applyCounter) return;
  const length = applyTextarea.value.length;
  applyCounter.textContent = `${Math.min(length, APPLY_MAX_CHARS)} / ${APPLY_MAX_CHARS}`;
  if (length > APPLY_MAX_CHARS) {
    applyCounter.classList.add("error");
  } else {
    applyCounter.classList.remove("error");
  }
}

async function hydrateAppliedJobs() {
  appliedJobs.clear();
  const stored = loadAppliedJobs();
  stored.forEach(([key, appliedAt]) => {
    const normalizedKey = normalizeId(key);
    if (normalizedKey) appliedJobs.set(normalizedKey, appliedAt);
  });
  if (allowApply) {
    await loadAppliedJobsFromServer();
  }
}

async function loadAppliedJobsFromServer() {
  if (!allowApply) return;
  try {
    const res = await secureFetch("/api/applications/my", { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const apps = await res.json().catch(() => []);
    if (!Array.isArray(apps)) return;
    const serverApplied = new Map();
    apps.forEach((app) => {
      const job = app?.jobId || {};
      const jobId = normalizeId(job?._id || job?.id || app?.jobId || "");
      const appliedAt = app?.createdAt || new Date().toISOString();
      if (jobId) serverApplied.set(jobId, appliedAt);
    });
    appliedJobs.clear();
    serverApplied.forEach((appliedAt, jobId) => {
      appliedJobs.set(jobId, appliedAt);
    });
    persistAppliedJobs();
  } catch (err) {
    console.warn("Unable to load applied jobs", err);
  }
}

async function submitApplication() {
  if (!currentApplyJob || !applyTextarea || !applyStatus || !applySubmitBtn) return;
  const target = resolveApplyTarget(currentApplyJob);
  const jobId = target?.id || "";
  const applyPath =
    target?.type === "case"
      ? `/api/cases/${encodeURIComponent(jobId)}/apply`
      : `/api/jobs/${encodeURIComponent(jobId)}/apply`;
  if (!jobId) {
    applyStatus.textContent = "Unable to submit this application right now.";
    return;
  }
  const note = applyTextarea.value.trim();
  if (!note) {
    applyStatus.textContent = "Add a short cover letter before submitting.";
    return;
  }
  if (note.length > APPLY_MAX_CHARS) {
    applyStatus.textContent = `Messages must be under ${APPLY_MAX_CHARS} characters.`;
    return;
  }

  applySubmitBtn.disabled = true;
  applySubmitBtn.textContent = "Applying…";
  applyStatus.textContent = "Submitting application…";

  try {
    const active = await ensureSession();
    if (!active) throw new Error("Session expired. Refresh and try again.");
    const csrf = await ensureCsrfToken();
    const res = await fetch(applyPath, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify({ coverLetter: note }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error || "Unable to submit application.";
      if (res.status === 403 && /stripe/i.test(message)) {
        applyStatus.textContent = STRIPE_GATE_MESSAGE;
        applySubmitBtn.disabled = false;
        applySubmitBtn.textContent = "Submit application";
        notifyStripeGate();
        return;
      }
      throw new Error(message);
    }
    applyStatus.textContent = "";
    markJobAsApplied(jobId);
    closeApplyModal();
    openApplyConfirmModal(currentApplyJob?.title || "");
    fetchJobs();
  } catch (error) {
    console.error(error);
    applyStatus.textContent = error.message || "Unable to submit application.";
    applySubmitBtn.disabled = false;
    applySubmitBtn.textContent = "Submit application";
  }
}

function markJobAsApplied(jobId) {
  if (isReapplyBypassUser()) return;
  const now = new Date().toISOString();
  const normalizedJobId = normalizeId(jobId);
  if (normalizedJobId) appliedJobs.set(normalizedJobId, now);
  persistAppliedJobs();
  if (normalizedJobId) {
    const selector = `[data-job-id="${escapeAttr(normalizedJobId)}"]`;
    const label = `✓ ${formatAppliedLabel(now)}`;
    document.querySelectorAll(selector).forEach((btn) => {
      btn.disabled = true;
      btn.textContent = label;
    });
  }
  if (currentApplyJob && normalizedJobId) {
    currentApplyJob.appliedAt = now;
  }
  if (allJobs.length) {
    allJobs.forEach((job) => {
      const id = getJobIdForApply(job);
      if (normalizedJobId && id === normalizedJobId) job.appliedAt = now;
    });
  }
  if (normalizedJobId) {
    const shouldKeep = (job) => normalizeId(getApplyKey(job)) !== normalizedJobId;
    allJobs = allJobs.filter(shouldKeep);
    filteredJobs = filteredJobs.filter(shouldKeep);
  }
  renderJobs(); // refresh cards to show applied state/date
}

function loadAppliedJobs() {
  try {
    const storageKey = getAppliedStorageKey();
    let raw = sessionStorage.getItem(storageKey);
    if (!raw && storageKey !== APPLIED_STORAGE_KEY) {
      raw = sessionStorage.getItem(APPLIED_STORAGE_KEY);
      if (raw) {
        sessionStorage.setItem(storageKey, raw);
        sessionStorage.removeItem(APPLIED_STORAGE_KEY);
      }
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      if (parsed.length && Array.isArray(parsed[0])) return parsed;
      return parsed.map((id) => [id, new Date().toISOString()]); // legacy list, mark now
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistAppliedJobs() {
  try {
    const entries = [...appliedJobs.entries()];
    sessionStorage.setItem(getAppliedStorageKey(), JSON.stringify(entries));
  } catch {
    /* ignore */
  }
}

async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  try {
    const res = await fetch("/api/csrf", { credentials: "include" });
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    csrfToken = data?.csrfToken || "";
  } catch {
    csrfToken = "";
  }
  return csrfToken;
}

async function ensureAttorneyPreview(job) {
  if (!job) return null;
  const existing = job.attorney || {};
  if (existing && (existing.firstName || existing.lastName || existing.lawFirm || existing.profileImage)) {
    if (!existing._id && job.attorneyId) {
      existing._id = job.attorneyId;
    }
    return existing;
  }

  const id = job.attorneyId || existing._id;
  if (!id) return null;
  if (!attorneyPreviewCache.has(id)) {
    try {
      const res = await secureFetch(`/api/users/attorneys/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
        noRedirect: true,
      });
      if (!res.ok) throw new Error(`Attorney preview failed (${res.status})`);
      const data = await res.json().catch(() => ({}));
      attorneyPreviewCache.set(id, data);
    } catch (err) {
      console.warn("Unable to fetch attorney preview", err);
      attorneyPreviewCache.set(id, null);
    }
  }
  const preview = attorneyPreviewCache.get(id);
  if (preview) {
    job.attorney = {
      _id: preview._id || id,
      firstName: preview.firstName || preview.givenName || "",
      lastName: preview.lastName || preview.familyName || "",
      lawFirm: preview.lawFirm || preview.firmName || "",
      profileImage: preview.profileImage || preview.avatarURL || "",
    };
    return job.attorney;
  }
  return null;
}

async function openJobModal(job) {
  if (!jobModal || !job) return;
  modalJob = job;
  if (jobApplyBtn) {
    const applyKey = getApplyKey(job);
    const appliedAt = getAppliedAt(job);
    if (!allowApply) {
      jobApplyBtn.disabled = false;
      jobApplyBtn.textContent = "Apply for this case";
      jobApplyBtn.title = "Only paralegals can apply.";
      jobApplyBtn.classList.add("is-disabled");
      jobApplyBtn.setAttribute("aria-disabled", "true");
      jobApplyBtn.removeAttribute("data-stripe-required");
      jobApplyBtn.removeAttribute("data-hover-label");
    } else if (appliedAt) {
      jobApplyBtn.disabled = true;
      jobApplyBtn.textContent = `✓ ${formatAppliedLabel(appliedAt)}`;
      jobApplyBtn.removeAttribute("title");
      jobApplyBtn.classList.add("is-disabled");
      jobApplyBtn.removeAttribute("data-stripe-required");
      jobApplyBtn.removeAttribute("data-hover-label");
    } else if (!stripeAllowed()) {
      jobApplyBtn.disabled = false;
      jobApplyBtn.textContent = "Apply for this case";
      jobApplyBtn.title = STRIPE_GATE_MESSAGE;
      jobApplyBtn.classList.add("is-disabled");
      jobApplyBtn.setAttribute("aria-disabled", "true");
      jobApplyBtn.dataset.stripeRequired = "true";
      jobApplyBtn.dataset.hoverLabel = "Stripe Setup Required";
    } else {
      jobApplyBtn.disabled = false;
      jobApplyBtn.textContent = "Apply for this case";
      jobApplyBtn.removeAttribute("title");
      jobApplyBtn.classList.remove("is-disabled");
      jobApplyBtn.removeAttribute("aria-disabled");
      jobApplyBtn.removeAttribute("data-stripe-required");
      jobApplyBtn.removeAttribute("data-hover-label");
    }
  }
  try {
    await ensureAttorneyPreview(job);
  } catch (err) {
    console.warn("Attorney preview load failed", err);
  }

  const title = job.title || "Untitled job";
  const summary = job.shortDescription || job.practiceArea || job.briefSummary || "";
  const description = job.description || job.details || "No additional description provided.";
  const payUSD = getJobPayUSD(job);
  const budgetValue = Number(job.budget);
  const budget = Number.isFinite(budgetValue) && budgetValue > 0 ? budgetValue : null;
  const compensation =
    job.compensationDisplay ||
    (budget ? `$${formatPay(budget)} compensation` : payUSD ? `$${formatPay(payUSD)} total` : "Rate negotiable");

  if (jobTitleEl) jobTitleEl.textContent = title;
  if (jobSummaryEl) jobSummaryEl.textContent = summary;
  if (jobBodyEl) jobBodyEl.textContent = description;
  if (jobCompensationEl) jobCompensationEl.textContent = compensation;

  const attorney = job.attorney || {};
  const name = [attorney.firstName, attorney.lastName].filter(Boolean).join(" ") || "Attorney";
  if (jobAttorneyName) jobAttorneyName.textContent = name;
  if (jobAttorneyFirm) jobAttorneyFirm.textContent = attorney.lawFirm || "";
  if (jobAttorneyAvatar) {
    jobAttorneyAvatar.src = attorney.profileImage || FALLBACK_AVATAR;
    jobAttorneyAvatar.alt = `Profile photo of ${name}`;
  }
  if (jobAttorneyButton) {
    jobAttorneyButton.dataset.attorneyId = attorney._id || job.attorneyId || "";
    jobAttorneyButton.dataset.jobId = job.id || job._id || "";
  }

  jobModal.classList.remove("hidden");
  jobModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeJobModal() {
  if (!jobModal) return;
  jobModal.classList.add("hidden");
  jobModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  modalJob = null;
}

jobModalClose?.addEventListener("click", closeJobModal);
jobModalBackdrop?.addEventListener("click", closeJobModal);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !jobModal?.classList.contains("hidden")) {
    closeJobModal();
  }
});

jobAttorneyButton?.addEventListener("click", async () => {
  if (!jobAttorneyButton) return;
  let attorneyId = jobAttorneyButton.dataset.attorneyId || "";
  let jobId = jobAttorneyButton.dataset.jobId || "";
  if (!attorneyId && modalJob) {
    try {
      await ensureAttorneyPreview(modalJob);
    } catch {}
    attorneyId = modalJob?.attorney?._id || modalJob?.attorneyId || "";
    jobId = jobId || modalJob?.id || modalJob?._id || "";
  }
  if (!attorneyId) {
    if (toast?.show) {
      toast.show("Unable to open this attorney profile right now.");
    } else {
      alert("Unable to open this attorney profile right now.");
    }
    return;
  }
  const url = new URL("profile-attorney.html", window.location.href);
  url.searchParams.set("id", attorneyId);
  if (jobId) url.searchParams.set("job", jobId);
  window.location.href = url.toString();
});

jobApplyBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!allowApply) {
    showToast("Only paralegals can apply to cases.", "info");
    return;
  }
  if (!stripeAllowed()) {
    notifyStripeGate();
    return;
  }
  if (modalJob) {
    openApplyModal(modalJob);
  }
});

function injectApplyStyles() {
  if (document.getElementById("job-apply-styles")) return;
  const style = document.createElement("style");
  style.id = "job-apply-styles";
  style.textContent = `
    .job-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
    .job-apply-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1400;opacity:0;pointer-events:none;transition:opacity .2s ease}
    .job-apply-overlay.show{opacity:1;pointer-events:auto}
    .job-apply-dialog{background:#fff;border-radius:18px;padding:24px;max-width:520px;width:92%;box-shadow:0 30px 60px rgba(0,0,0,.15);display:grid;gap:14px}
    .job-apply-dialog header{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .job-apply-dialog [data-apply-title]{flex:1;text-align:center;font-family:'Cormorant Garamond',serif;font-weight:300;font-size:1.6rem;margin:0;}
    .job-apply-dialog .close-btn{border:none;background:none;font-size:1.5rem;line-height:1;cursor:pointer}
    .job-apply-dialog textarea{width:100%;max-width:100%;border:1px solid #d1d5db;border-radius:14px;padding:12px 14px;font:inherit;resize:vertical;min-height:120px;box-sizing:border-box;margin-top:4px;}
    .job-apply-dialog .apply-meta{display:flex;align-items:center;justify-content:space-between;font-size:.85rem;color:#6b7280}
    .job-apply-dialog .apply-meta .error{color:#b91c1c}
    .job-apply-dialog .modal-actions{display:flex;justify-content:flex-end;gap:10px}
    .job-apply-dialog .muted{color:#6b7280;font-size:.9rem;margin:0}
    .job-apply-dialog .apply-footnote{margin:4px 0 0;color:#6b7280;font-size:.8rem}
    .apply-confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;pointer-events:none;transition:opacity .2s ease}
    .apply-confirm-overlay.show{opacity:1;pointer-events:auto}
    .apply-confirm-dialog{background:#fff;border-radius:18px;padding:22px;max-width:420px;width:92%;box-shadow:0 30px 60px rgba(0,0,0,.15);display:grid;gap:12px;text-align:center}
    .apply-confirm-dialog header{display:flex;align-items:center;justify-content:center;gap:12px}
    .apply-confirm-dialog h3{margin:0;font-family:'Cormorant Garamond',serif;font-weight:300;font-size:1.5rem}
    .apply-confirm-dialog .close-btn{border:none;background:none;font-size:1.5rem;line-height:1;cursor:pointer}
    .apply-confirm-message{margin:0;color:#4b5563;font-size:.95rem}
    .apply-confirm-actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}
    .apply-confirm-link{background:#b6a47a;color:#fff;border-radius:999px;padding:0.55rem 1.2rem;text-decoration:none;font-weight:250;font-size:.95rem}
    .apply-confirm-close{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:0.55rem 1.2rem;font-weight:250;font-size:.95rem;cursor:pointer}
  `;
  document.head.appendChild(style);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message, type = "info") {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}

function closeFlagMenu(menu, button = null) {
  if (!menu) return;
  menu.hidden = true;
  menu.setAttribute("aria-hidden", "true");
  if (button) {
    button.setAttribute("aria-expanded", "false");
  }
  if (openFlagMenu === menu) openFlagMenu = null;
}

function bindFlagMenuHandlers() {
  if (flagMenuHandlersBound) return;
  flagMenuHandlersBound = true;
  document.addEventListener("click", (event) => {
    if (!openFlagMenu) return;
    const target = event.target;
    if (target?.closest?.(".flag-menu") || target?.closest?.(".flag-button")) return;
    closeFlagMenu(openFlagMenu);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openFlagMenu) {
      closeFlagMenu(openFlagMenu);
    }
  });
}

function toggleFlagMenu(menu, button) {
  if (!menu || !button) return;
  if (openFlagMenu && openFlagMenu !== menu) {
    closeFlagMenu(openFlagMenu);
  }
  const willOpen = menu.hidden;
  if (!willOpen) {
    closeFlagMenu(menu, button);
    return;
  }
  menu.hidden = false;
  menu.setAttribute("aria-hidden", "false");
  button.setAttribute("aria-expanded", "true");
  openFlagMenu = menu;
}

function buildFlagMenu(job) {
  const menu = document.createElement("div");
  menu.className = "flag-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-modal", "false");
  menu.setAttribute("aria-label", "Flag case");
  const rawGroup = `flag-reason-${normalizeId(getJobUniqueId(job) || "case") || "case"}`;
  const groupName = rawGroup.replace(/[^a-zA-Z0-9_-]/g, "") || "flag-reason-case";

  const optionsMarkup = FLAG_REASONS.map(
    (reason) => `
      <label class="flag-option">
        <input type="radio" name="${groupName}" value="${reason.value}" />
        <span>${reason.label}</span>
      </label>
    `
  ).join("");

  menu.innerHTML = `
    <div class="flag-menu-title">Flag this case</div>
    <div class="flag-menu-subtitle">Why are you reporting this case?</div>
    <form class="flag-menu-form">
      ${optionsMarkup}
      <div class="flag-menu-other" data-flag-other hidden>
        <textarea rows="3" placeholder="Optional details"></textarea>
      </div>
      <div class="flag-menu-actions">
        <button type="button" class="flag-cancel">Cancel</button>
        <button type="submit" class="flag-submit" disabled>Submit flag</button>
      </div>
    </form>
  `;

  const form = menu.querySelector(".flag-menu-form");
  const submitBtn = menu.querySelector(".flag-submit");
  const cancelBtn = menu.querySelector(".flag-cancel");
  const otherWrap = menu.querySelector("[data-flag-other]");
  const otherInput = otherWrap?.querySelector("textarea");
  const reasonInputs = Array.from(menu.querySelectorAll(`input[name="${groupName}"]`));

  const updateState = () => {
    const selected = reasonInputs.find((input) => input.checked);
    const selectedValue = selected?.value || "";
    if (otherWrap) {
      otherWrap.hidden = selectedValue !== "other";
    }
    if (submitBtn) submitBtn.disabled = !selectedValue;
  };

  reasonInputs.forEach((input) => {
    input.addEventListener("change", updateState);
  });

  cancelBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    closeFlagMenu(menu);
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = reasonInputs.find((input) => input.checked);
    if (!selected) return;
    const detail = otherInput?.value?.trim() || "";
    const caseId = job?.caseId || job?.contextCaseId || "";
    if (!caseId) {
      showToast("Unable to flag this posting right now.", "error");
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    secureFetch(`/api/cases/${encodeURIComponent(caseId)}/flag`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: {
        reason: selected.value,
        details: detail,
      },
    })
      .then(async (res) => {
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || "Unable to submit flag.");
        }
        showToast("Thanks for letting us know. We'll review this case.", "info");
        closeFlagMenu(menu);
      })
      .catch((err) => {
        showToast(err?.message || "Unable to submit flag.", "error");
      })
      .finally(() => {
        if (submitBtn) submitBtn.disabled = false;
      });
  });

  menu.addEventListener("click", (event) => event.stopPropagation());
  bindFlagMenuHandlers();
  return menu;
}

function buildFlagButton(job) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "flag-button";
  button.setAttribute("aria-label", "Flag this case");
  button.setAttribute("title", "Flag this case");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 3v18"></path>
      <path d="M5 4h11l-2 4 2 4H5"></path>
    </svg>
  `;
  const menu = buildFlagMenu(job);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFlagMenu(menu, button);
  });
  return { button, menu };
}

function escapeAttr(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value || "").replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    if (value._id || value.id || value.caseId || value.jobId) {
      return normalizeId(value._id || value.id || value.caseId || value.jobId);
    }
    if (typeof value.toString === "function") {
      const stringified = value.toString();
      if (stringified && stringified !== "[object Object]") return String(stringified);
    }
    return "";
  }
  return String(value);
}

function getJobUniqueId(job) {
  return normalizeId(
    job?.caseId || job?.case_id || job?.case || job?.id || job?._id || job?.jobId || job?.job_id || ""
  );
}

function getJobIdForApply(job) {
  return normalizeId(job?.jobId || job?.job_id || job?.job?.id || job?.job?._id || "");
}

function getCaseIdForApply(job) {
  return normalizeId(job?.caseId || job?.case_id || job?.case || job?.contextCaseId || "");
}

function resolveApplyTarget(job) {
  const jobId = getJobIdForApply(job);
  if (jobId) return { type: "job", id: jobId };
  const caseId = getCaseIdForApply(job);
  if (caseId) return { type: "case", id: caseId };
  return null;
}

function getApplyKey(job) {
  return normalizeId(getJobIdForApply(job) || getCaseIdForApply(job) || "");
}

function getAppliedAt(job) {
  if (!job) return null;
  if (isReapplyBypassUser()) return null;
  if (job.appliedAt) return job.appliedAt;
  const jobKey = getApplyKey(job);
  if (jobKey && appliedJobs.has(jobKey)) return appliedJobs.get(jobKey);
  return null;
}

function isAppliedJob(job) {
  return Boolean(getAppliedAt(job));
}

function expandJob(job) {
  const id = getJobUniqueId(job);
  if (!id) {
    openJobModal(job);
    return;
  }
  expandedJobId = id;
  renderJobs();
  setTimeout(scrollToExpandedCard, 10);
}

function collapseExpanded() {
  expandedJobId = "";
  renderJobs();
  if (jobsGrid?.scrollIntoView) {
    setTimeout(() => jobsGrid.scrollIntoView({ behavior: "smooth", block: "start" }), 10);
  }
}

function scrollToExpandedCard() {
  const card = document.querySelector(".job-card.expanded");
  if (!card) return;
  const header = document.querySelector(".site-header");
  const headerOffset = header ? header.getBoundingClientRect().height + 12 : 0;
  const rect = card.getBoundingClientRect();
  const target = Math.max(0, rect.top + window.scrollY - headerOffset);
  window.scrollTo({ top: target, behavior: "smooth" });
}

function buildApplyButton(job, jobId, appliedAt) {
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "apply-button";
  applyBtn.dataset.jobId = jobId;
  if (!allowApply) {
    applyBtn.textContent = "Apply for this case";
    applyBtn.title = "Only paralegals can apply.";
    applyBtn.classList.add("is-disabled");
    applyBtn.setAttribute("aria-disabled", "true");
    applyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      showToast("Only paralegals can apply to cases.", "info");
    });
    } else if (appliedAt) {
      applyBtn.disabled = true;
      applyBtn.textContent = `✓ ${formatAppliedLabel(appliedAt)}`;
      applyBtn.removeAttribute("data-stripe-required");
      applyBtn.removeAttribute("data-hover-label");
    } else if (!stripeAllowed()) {
      applyBtn.textContent = "Apply for this case";
      applyBtn.title = STRIPE_GATE_MESSAGE;
      applyBtn.classList.add("is-disabled");
      applyBtn.setAttribute("aria-disabled", "true");
      applyBtn.dataset.stripeRequired = "true";
      applyBtn.dataset.hoverLabel = "Stripe Setup Required";
      applyBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        notifyStripeGate();
      });
    } else {
      applyBtn.textContent = "Apply for this case";
      applyBtn.removeAttribute("data-stripe-required");
      applyBtn.removeAttribute("data-hover-label");
      applyBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openApplyModal(job);
      });
    }
  return applyBtn;
}

function renderExpandedJob(job) {
  const card = document.createElement("div");
  const caseId = getJobUniqueId(job);
  const jobId = getJobIdForApply(job) || caseId;
  const applyKey = getApplyKey(job);
  const appliedAt = getAppliedAt(job);
  const payUSD = getJobPayUSD(job);
  const budgetValue = Number(job.budget);
  const budget = Number.isFinite(budgetValue) && budgetValue > 0 ? budgetValue : null;
  const compensation =
    job.compensationDisplay ||
    (budget ? `$${formatPay(budget)} compensation` : payUSD ? `$${formatPay(payUSD)} total` : "Rate negotiable");
  const jobState = getJobState(job) || "—";
  const when = job.createdAt
    ? new Date(job.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })
    : "Recently posted";
  const rawSummary = job.briefSummary || job.shortDescription || job.practiceArea || "";
  const summary = scrubStateLines(rawSummary, jobState);
  const rawDescription = job.description || job.details || job.briefSummary || "";
  const { description, experienceLine } = prepareExpandedContent(rawDescription, jobState);
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const tasksMarkup = `
    <div class="description-label">TASKS</div>
    ${
      tasks.length
        ? `<ul class="job-task-list">
            ${tasks
              .map((task) => {
                const title = typeof task === "string" ? task : task?.title;
                return title ? `<li>${escapeHtml(title)}</li>` : "";
              })
              .filter(Boolean)
              .join("")}
          </ul>`
        : `<div class="job-task-empty">No tasks listed yet.</div>`
    }
  `;
  const applyInfoHtml = allowApply
    ? `
        <div class="apply-info">
          <div class="apply-info-title">What Happens After You Apply</div>
          <ul class="apply-info-list">
            <li>The attorney reviews applications</li>
            <li>Selected applicants are invited to the workspace</li>
            <li>Scope is confirmed and work begins</li>
            <li>Compensation is released after attorney approval and case completion</li>
          </ul>
        </div>
      `
    : "";
  const applyInfoBlock = applyInfoHtml ? `<div class="apply-info-block">${applyInfoHtml}</div>` : "";

  card.className = "job-card expanded";

  const title = escapeHtml(job.title || "Case");
  card.innerHTML = `
    <div class="expanded-card-grid">
      <div class="expanded-header">
        <div>
          <div class="pill-label">${escapeHtml(job.practiceArea || "General practice")}</div>
          <h3>${title}</h3>
          <div class="meta">
            <span>${escapeHtml(jobState)}</span>
            <span>${escapeHtml(compensation)}</span>
            <span>Posted ${escapeHtml(when)}</span>
          </div>
        </div>
        <div class="expanded-actions"></div>
      </div>
      <div class="expanded-body">
        ${summary ? `<p class="lede">${escapeHtml(summary)}</p>` : ""}
        <div class="description-label">DESCRIPTION</div>
        <div class="rich-text main-description">${escapeHtml(description)}</div>
        ${tasksMarkup}
      </div>
      ${experienceLine ? `<div class="experience-line-row"><div class="experience-line">${escapeHtml(experienceLine)}</div></div>` : ""}
      <div class="expanded-footer">
        <div class="posted-by" data-posted-by>
          <div class="posted-label">Posted by</div>
          <a class="posted-link" href="#" data-attorney-link>
            <img class="posted-avatar" alt="Attorney photo">
            <div>
              <div class="posted-name" data-posted-name></div>
              <div class="posted-firm" data-posted-firm></div>
              <div class="posted-count" data-posted-count></div>
            </div>
          </a>
        </div>
        <div class="expanded-footer-actions" data-footer-actions></div>
      </div>
      ${applyInfoBlock}
    </div>
  `;

  // Ensure no legacy attorney card markup lingers in this view.
  card.querySelectorAll(".attorney-block, .attorney-card, .job-sidebar-card").forEach((node) => node.remove());

  const expandedActions = card.querySelector(".expanded-actions");
  if (expandedActions) {
    const { button: flagButton, menu: flagMenu } = buildFlagButton(job);
    expandedActions.appendChild(flagButton);
    card.appendChild(flagMenu);
  }

  const buttonsHost = card.querySelector("[data-expanded-buttons]");
  const footerActions = card.querySelector("[data-footer-actions]");
  if (buttonsHost) {
    buttonsHost.innerHTML = "";
  }
  if (footerActions) {
    footerActions.innerHTML = "";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "clear-button ghost-button";
    backBtn.textContent = "Back to all jobs";
    backBtn.addEventListener("click", (event) => {
      event.preventDefault();
      collapseExpanded();
    });

    const applyBtn = buildApplyButton(job, applyKey || jobId, appliedAt);
    footerActions.appendChild(backBtn);
    footerActions.appendChild(applyBtn);
  }

  updatePostedBy(card, job);

  ensureAttorneyPreview(job)
    .then((preview) => {
      if (!preview) return;
      job.attorney = {
        ...(job.attorney || {}),
        ...preview,
        lawFirm: preview.lawFirm || preview.firmName || job.attorney?.lawFirm,
      };
      updatePostedBy(card, job);
    })
    .catch(() => {});

  return card;
}

function syncExpansionLayout() {
  const isExpanded = !!expandedJobId;
  document.body.classList.toggle("job-expanded", isExpanded);
}

function formatDeadline(raw) {
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "";
}

function getCompletedJobsCount(job) {
  const attorney = job?.attorney || {};
  const candidates = [
    attorney.completedJobs,
    attorney.completedCases,
    attorney.completedCasesCount,
    attorney.casesCompleted,
    attorney.metrics?.completedCases,
    attorney.stats?.completedCases,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return 0;
}

function buildAttorneyProfileUrl(attorney, job) {
  const attorneyId = attorney?._id || attorney?.id || job?.attorneyId || "";
  if (!attorneyId) return "";
  const jobId = job?.id || job?._id || getJobUniqueId(job) || "";
  const url = new URL("profile-attorney.html", window.location.href);
  url.searchParams.set("id", attorneyId);
  if (jobId) url.searchParams.set("job", jobId);
  return url.toString();
}

function updatePostedBy(card, job) {
  const root = card.querySelector("[data-posted-by]");
  if (!root) return;
  const avatar = root.querySelector(".posted-avatar");
  const nameEl = root.querySelector("[data-posted-name]");
  const firmEl = root.querySelector("[data-posted-firm]");
  const countEl = root.querySelector("[data-posted-count]");
  const linkEl = root.querySelector("[data-attorney-link]");
  const attorney = job?.attorney || {};
  const displayName = [attorney.firstName, attorney.lastName].filter(Boolean).join(" ") || "Attorney";
  const profileUrl = buildAttorneyProfileUrl(attorney, job);
  if (avatar) {
    avatar.src = attorney.profileImage || FALLBACK_AVATAR;
    avatar.alt = `Profile photo of ${displayName}`;
  }
  if (nameEl) nameEl.textContent = displayName;
  if (firmEl) firmEl.textContent = attorney.lawFirm || "Firm undisclosed";
  if (countEl) {
    const count = getCompletedJobsCount(job);
    if (count >= 2) {
      countEl.textContent = `${count} completed jobs`;
      countEl.style.display = "";
    } else {
      countEl.textContent = "";
      countEl.style.display = "none";
    }
  }
  if (linkEl) {
    if (profileUrl) {
      linkEl.href = profileUrl;
      linkEl.dataset.attorneyLinkReady = "true";
    } else {
      linkEl.href = "#";
      delete linkEl.dataset.attorneyLinkReady;
    }
  }
}
