import { secureFetch } from "../auth.js";
import { getStripeConnectStatus, isStripeConnected, STRIPE_GATE_MESSAGE } from "../utils/stripe-connect.js";
import { showAlert } from "../utils/dialogs.js";
import {
  getRecommendationIdentityIds,
  publishRecommendationHistoryChange,
} from "../recommendation-state.mjs";

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
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebarNav = document.getElementById("sidebarNav");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const FALLBACK_AVATAR = "assets/avatar-placeholder.svg";
const attorneyPreviewCache = new Map();
const urlParams = new URLSearchParams(window.location.search);
const explicitCaseId = (urlParams.get("caseId") || urlParams.get("caseID") || urlParams.get("case_id") || "").trim();
const idParam = (urlParams.get("id") || "").trim();

let allJobs = [];
let filteredJobs = [];
const APPLY_MAX_CHARS = 2000;
const APPLIED_STORAGE_KEY = "lpc_applied_jobs";
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
let applyReturnFocus = null;
let applyConfirmReturnFocus = null;
const toast = window.toastUtils;
let expandedJobId = "";
let stripeConnected = false;
let viewerRole = "";
let allowApply = false;
let viewerState = "";
let viewerStateExperience = [];
let autoStateFilterApplied = false;
const PAGE_SIZE = 15;
const PAY_FILTER_STOPS = [400, 500, 600, 700, 800, 900];
const MIN_CASE_COMPENSATION = PAY_FILTER_STOPS[0];
const MAX_FILTER_COMPENSATION = PAY_FILTER_STOPS[PAY_FILTER_STOPS.length - 1];
let currentPage = 1;
let userPageOverride = false;
const initialJobParam = (idParam || explicitCaseId || "").trim();
const PROFILE_PHOTO_REQUIRED_MESSAGE = "Complete your profile before applying.";
let viewerHasProfilePhoto = false;
const FLAG_REASONS = [
  { value: "inappropriate", label: "Inappropriate content" },
  { value: "spam", label: "Spam or misleading" },
  { value: "compensation", label: "Compensation issue" },
  { value: "duplicate", label: "Duplicate posting" },
  { value: "other", label: "Other" },
];
let openFlagMenu = null;
let flagMenuHandlersBound = false;
let listScrollState = { shell: 0, window: 0 };
let expandedReturnJobId = "";

function setSidebarOpen(open, { restoreFocus = false } = {}) {
  const nextOpen = Boolean(open) && window.innerWidth <= 900;
  document.body.classList.toggle("nav-open", nextOpen);
  sidebarToggle?.setAttribute("aria-expanded", String(nextOpen));
  sidebarToggle?.setAttribute("aria-label", nextOpen ? "Close navigation" : "Open navigation");
  sidebarBackdrop?.setAttribute("aria-hidden", String(!nextOpen));
  if (nextOpen) sidebarNav?.querySelector("a, button")?.focus({ preventScroll: true });
  else if (restoreFocus) sidebarToggle?.focus({ preventScroll: true });
}

sidebarToggle?.addEventListener("click", () => {
  setSidebarOpen(!document.body.classList.contains("nav-open"));
});
sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false, { restoreFocus: true }));
sidebarNav?.addEventListener("click", (event) => {
  if (event.target.closest("a")) setSidebarOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("nav-open")) {
    setSidebarOpen(false, { restoreFocus: true });
  }
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 900 && document.body.classList.contains("nav-open")) setSidebarOpen(false);
});

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
const deadlineSelect = document.getElementById("filterDeadline");
const postedSelect = document.getElementById("filterPosted");
const activeFilterCount = document.getElementById("activeFilterCount");

const minPaySlider = document.getElementById("filterMinPay");
const minPayValue = document.getElementById("minPayValue");

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

function readStoredProfilePhoto() {
  try {
    const raw = localStorage.getItem("lpc_user");
    if (!raw) return "";
    const user = JSON.parse(raw);
    return String(user?.profileImage || user?.avatarURL || "").trim();
  } catch {
    return "";
  }
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
    viewerHasProfilePhoto = Boolean(
      session?.user?.profileImage || session?.user?.avatarURL || readStoredProfilePhoto()
    );
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
    void showAlert(message, { title: "Action needed" });
  }
}

function stripeAllowed() {
  return stripeConnected;
}

function profilePhotoAllowed() {
  return viewerHasProfilePhoto;
}

async function refreshStripeStatus() {
  const data = await getStripeConnectStatus();
  stripeConnected = isStripeConnected(data);
  return data;
}

// Toggle filter menu
if (filterToggle && filterMenu) {
  const setFilterMenuOpen = (open) => {
    filterMenu.classList.toggle("active", open);
    filterToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };
  filterToggle.addEventListener("click", () => {
    setFilterMenuOpen(!filterMenu.classList.contains("active"));
  });

  document.addEventListener("click", (e) => {
    if (!filterMenu.contains(e.target) && !filterToggle.contains(e.target)) {
      setFilterMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !filterMenu.classList.contains("active")) return;
    setFilterMenuOpen(false);
    filterToggle.focus();
  });
}

function quantizePayValue(raw) {
  const value = Math.max(
    MIN_CASE_COMPENSATION,
    Math.min(MAX_FILTER_COMPENSATION, Number(raw) || MIN_CASE_COMPENSATION)
  );

  return PAY_FILTER_STOPS.reduce((closest, stop) => {
    const closestDistance = Math.abs(closest - value);
    const stopDistance = Math.abs(stop - value);
    if (stopDistance < closestDistance) return stop;
    if (stopDistance === closestDistance && stop > closest) return stop;
    return closest;
  }, PAY_FILTER_STOPS[0]);
}

function updatePayLabel(value) {
  if (!minPayValue) return;
  const display = value >= MAX_FILTER_COMPENSATION ? "$900+" : `$${value.toLocaleString()}`;
  minPayValue.textContent = display;
}

// Dynamic filter population
function populateFilters() {
  if (!practiceAreaSelect || !stateSelect || !minPaySlider) return;

  // Practice areas
  const areas = [...new Set(allJobs.map((j) => String(j.practiceArea || "").trim()).filter(Boolean))].sort();
  practiceAreaSelect.replaceChildren(new Option("Any", ""));
  areas.forEach((area) => practiceAreaSelect.add(new Option(area, area)));

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
  states.sort((left, right) => left.localeCompare(right));
  stateSelect.replaceChildren(new Option("Any", ""));
  states.forEach((stateName) => stateSelect.add(new Option(stateName, stateName)));

  // Pay slider
  minPaySlider.min = MIN_CASE_COMPENSATION;
  minPaySlider.max = MAX_FILTER_COMPENSATION;
  minPaySlider.step = 25;
  minPaySlider.value = MIN_CASE_COMPENSATION;
  updatePayLabel(MIN_CASE_COMPENSATION);

}

// Slider displays
minPaySlider?.addEventListener("input", () => {
  const value = quantizePayValue(minPaySlider.value);
  minPaySlider.value = value;
  updatePayLabel(value);
});

// Apply filters
function applyFilters(options = {}) {
  const { render = true } = options;
  const area = practiceAreaSelect?.value || "";
  const state = stateSelect?.value || "";
  const minPay = quantizePayValue(minPaySlider?.value || MIN_CASE_COMPENSATION);
  const deadlineMode = String(deadlineSelect?.value || "");
  const postedMode = String(postedSelect?.value || "");
  const today = window.LPCBusinessDate?.today() || "";
  const sevenDaysFromToday = window.LPCBusinessDate?.addDays(today, 7) || "";
  const thirtyDaysFromToday = window.LPCBusinessDate?.addDays(today, 30) || "";
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  filteredJobs = allJobs.filter((job) => {
    if (shouldHideAppliedJob(job)) return false;
    const payUSD = getJobPayUSD(job);
    const jobState = getJobState(job);
    const deadline = window.LPCBusinessDate?.matterValue(job) || "";
    const posted = new Date(job?.createdAt || 0).getTime();

    if (area && job.practiceArea !== area) return false;
    if (state && jobState !== state) return false;
    if (payUSD < minPay) return false;
    if (deadlineMode === "none" && deadline) return false;
    if (deadlineMode === "7_days" && (!deadline || !today || deadline < today || deadline > sevenDaysFromToday)) return false;
    if (deadlineMode === "30_days" && (!deadline || !today || deadline < today || deadline > thirtyDaysFromToday)) return false;
    if (postedMode === "7_days" && (!posted || posted < now - 7 * day)) return false;
    if (postedMode === "30_days" && (!posted || posted < now - 30 * day)) return false;

    return true;
  });

  currentPage = 1;
  userPageOverride = false;
  applySort();
  syncBrowseFilterUrl();
  updateActiveFilterCount();
  if (render) {
    renderJobs();
    filterMenu?.classList.remove("active");
    filterToggle?.setAttribute("aria-expanded", "false");
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
    minPaySlider.value = MIN_CASE_COMPENSATION;
    updatePayLabel(MIN_CASE_COMPENSATION);
  }
  if (deadlineSelect) deadlineSelect.value = "";
  if (postedSelect) postedSelect.value = "";
  if (sortSelect) sortSelect.value = "newest";

  filteredJobs = allJobs.filter((job) => !shouldHideAppliedJob(job));
  currentPage = 1;
  userPageOverride = false;
  applySort();
  syncBrowseFilterUrl();
  updateActiveFilterCount();
  renderJobs();
  filterMenu?.classList.remove("active");
  filterToggle?.setAttribute("aria-expanded", "false");
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

function getJobCompensation(job) {
  const payUSD = getJobPayUSD(job);
  const budgetValue = Number(job?.budget);
  const budget = Number.isFinite(budgetValue) && budgetValue > 0 ? budgetValue : null;
  const relistedWithRemaining =
    isRelistedJob(job) && typeof job?.remainingAmount === "number" && job.remainingAmount > 0;

  if (relistedWithRemaining && payUSD) return `$${formatPay(payUSD)} total`;
  if (job?.compensationDisplay) return job.compensationDisplay;
  if (budget) return `$${formatPay(budget)} compensation`;
  if (payUSD) return `$${formatPay(payUSD)} total`;
  return "Rate negotiable";
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
  const caseId = getCaseIdForApply(job);
  return title.includes("job not found") || (!jobId && !caseId);
}

function isRelistedJob(job) {
  return Boolean(job?.relistRequestedAt);
}

function getJobTaskCounts(job) {
  const tasks = Array.isArray(job?.tasks) ? job.tasks : [];
  const total = tasks.length;
  const completed = tasks.reduce((count, task) => {
    if (typeof task === "string") return count;
    return count + (task?.completed ? 1 : 0);
  }, 0);
  return { total, completed };
}

function isPartiallyCompletedRelist(job) {
  const { total, completed } = getJobTaskCounts(job);
  return isRelistedJob(job) && total > 0 && completed > 0 && completed < total;
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
  const description = filtered.join("\n").trim() || "No additional description was provided for this Matter.";
  return { description, experienceLine: experienceLine.trim() };
}

function stripDuplicateStateLine(text, jobState) {
  const lines = normalizeContentLines(text);
  return lines
    .filter((line) => !isStateLine(line, jobState))
    .join("\n");
}

function applySort() {
  const mode = sortSelect?.value || "newest";
  switch (mode) {
    case "newest":
      filteredJobs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      break;
    case "deadline":
      filteredJobs.sort((a, b) => {
        const left = window.LPCBusinessDate?.matterValue(a) || "9999-12-31";
        const right = window.LPCBusinessDate?.matterValue(b) || "9999-12-31";
        return left.localeCompare(right) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });
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

function updateActiveFilterCount() {
  const count = [
    practiceAreaSelect?.value,
    stateSelect?.value,
    Number(minPaySlider?.value || MIN_CASE_COMPENSATION) > MIN_CASE_COMPENSATION ? "pay" : "",
    deadlineSelect?.value,
    postedSelect?.value,
  ].filter(Boolean).length;
  if (activeFilterCount) activeFilterCount.textContent = count ? `(${count})` : "";
}

function syncBrowseFilterUrl() {
  const url = new URL(window.location.href);
  const values = {
    browsePractice: practiceAreaSelect?.value || "",
    browseState: stateSelect?.value || "",
    browseMinPay: Number(minPaySlider?.value || MIN_CASE_COMPENSATION) > MIN_CASE_COMPENSATION ? minPaySlider.value : "",
    browseDeadline: deadlineSelect?.value || "",
    browsePosted: postedSelect?.value || "",
    browseSort: (sortSelect?.value || "newest") === "newest" ? "" : sortSelect.value,
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  });
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function restoreBrowseFilterUrl() {
  const params = new URLSearchParams(window.location.search);
  const practice = String(params.get("browsePractice") || "");
  const stateValue = String(params.get("browseState") || "");
  const deadline = String(params.get("browseDeadline") || "");
  const posted = String(params.get("browsePosted") || "");
  const sort = String(params.get("browseSort") || "newest");
  let restored = false;
  if (practiceAreaSelect && [...practiceAreaSelect.options].some((option) => option.value === practice)) {
    practiceAreaSelect.value = practice;
    restored ||= Boolean(practice);
  }
  if (stateSelect && [...stateSelect.options].some((option) => option.value === stateValue)) {
    stateSelect.value = stateValue;
    restored ||= Boolean(stateValue);
  }
  const minPay = quantizePayValue(params.get("browseMinPay") || MIN_CASE_COMPENSATION);
  if (minPaySlider) {
    minPaySlider.value = minPay;
    updatePayLabel(minPay);
    restored ||= minPay > MIN_CASE_COMPENSATION;
  }
  if (deadlineSelect && ["", "7_days", "30_days", "none"].includes(deadline)) deadlineSelect.value = deadline;
  if (postedSelect && ["", "7_days", "30_days"].includes(posted)) postedSelect.value = posted;
  if (sortSelect && ["newest", "deadline", "payHigh", "payLow"].includes(sort)) sortSelect.value = sort;
  restored ||= Boolean(deadline || posted || sort !== "newest");
  updateActiveFilterCount();
  return restored;
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

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / PAGE_SIZE));
  if (expandedJobId && !userPageOverride) {
    const targetIndex = filteredJobs.findIndex((job) => getJobUniqueId(job) === expandedJobId);
    if (targetIndex >= 0) {
      currentPage = Math.min(totalPages, Math.max(1, Math.floor(targetIndex / PAGE_SIZE) + 1));
    }
  }
  if (currentPage > totalPages) currentPage = totalPages;
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredJobs.slice(startIndex, startIndex + PAGE_SIZE);

  pageItems.forEach((job, idx) => {
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

    const meta = card.querySelector(".meta");
    if (meta && isPartiallyCompletedRelist(job)) {
      const note = document.createElement("div");
      note.className = "partial-completion-note";
      note.textContent = "This Matter has been partially completed";
      meta.insertAdjacentElement("afterend", note);
    }

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
    caseBtn.textContent = "View Matter";
    caseBtn.dataset.jobId = caseId;
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

    if (isPartiallyCompletedRelist(job)) {
      const { total, completed } = getJobTaskCounts(job);
      const footer = document.createElement("div");
      footer.className = "job-card-footer";
      footer.textContent = `This Matter has ${completed}/${total} tasks completed`;
      card.appendChild(footer);
    }

    card.addEventListener("click", () => {
      openJobModal(job);
    });

    jobsGrid.appendChild(card);

    requestAnimationFrame(() => {
      setTimeout(() => card.classList.add("visible"), idx * 40);
    });
  });

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  if (!pagination) return;
  pagination.innerHTML = "";
  if (totalPages <= 1) return;

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.textContent = "Back";
  prevBtn.className = "pagination-btn";
  prevBtn.disabled = currentPage <= 1;
  prevBtn.addEventListener("click", () => {
    if (currentPage <= 1) return;
    userPageOverride = true;
    currentPage -= 1;
    renderJobs();
  });

  const info = document.createElement("span");
  info.className = "pagination-info";
  info.textContent = `${currentPage} / ${totalPages}`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.textContent = "Next";
  nextBtn.className = "pagination-btn";
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.addEventListener("click", () => {
    if (currentPage >= totalPages) return;
    userPageOverride = true;
    currentPage += 1;
    renderJobs();
  });

  pagination.appendChild(prevBtn);
  pagination.appendChild(info);
  pagination.appendChild(nextBtn);
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
    currentPage = 1;
    userPageOverride = false;

    populateFilters();
    const restored = restoreBrowseFilterUrl();
    const autoFiltered = !restored && applyDefaultStateFilter();
    if (restored) applyFilters({ render: false });
    else if (!autoFiltered) applySort();
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
    if (jobsGrid) {
      jobsGrid.innerHTML = "";
      const error = document.createElement("div");
      error.className = "empty-results";
      const message = document.createElement("p");
      message.className = "area";
      message.textContent = "Available Matters could not be loaded. Your filters are still preserved.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "pagination-btn";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        retry.disabled = true;
        retry.textContent = "Retrying…";
        void fetchJobs();
      });
      error.append(message, retry);
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
  currentPage = 1;
  userPageOverride = false;
  applySort();
  syncBrowseFilterUrl();
  renderJobs();
});

function openApplyModal(job) {
  if (!job) return;
  if (!allowApply) {
    showToast("Only paralegals can apply to Matters.", "info");
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
  applyReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const target = resolveApplyTarget(job);
  if (!target) {
    showToast("Unable to apply to this Matter right now.", "error");
    return;
  }
  applyModal.dataset.applyType = target.type;
  applyModal.dataset.jobId = target.id;
  applyTitle.textContent = `Apply to ${String(job.title || "this Matter")}`;
  applyTextarea.value = "";
  applyStatus.textContent = "";
  applyCounter.textContent = `0 / ${APPLY_MAX_CHARS}`;
  applySubmitBtn.disabled = false;
  applySubmitBtn.textContent = "Submit application";
  applyModal.classList.add("show");
  applyTextarea.focus();
}

function closeApplyModal({ restoreFocus = true } = {}) {
  if (applyModal) {
    applyModal.classList.remove("show");
    applyModal.querySelector(".apply-confirm")?.remove();
  }
  currentApplyJob = null;
  if (restoreFocus && applyReturnFocus?.isConnected) applyReturnFocus.focus({ preventScroll: true });
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
  if (applyConfirmReturnFocus?.isConnected) {
    applyConfirmReturnFocus.focus({ preventScroll: true });
  } else {
    const nextMatter = jobsGrid?.querySelector('.clear-button[data-job-id]');
    const fallback = nextMatter || jobsGrid;
    if (fallback) {
      if (fallback === jobsGrid && !fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
      fallback.focus({ preventScroll: true });
    }
  }
  applyConfirmReturnFocus = null;
}

function trapDialogFocus(container, event) {
  if (event.key !== "Tab" || !container) return;
  const focusable = Array.from(
    container.querySelectorAll('button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
  ).filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function ensureApplyModal() {
  if (applyModal) return;
  injectApplyStyles();
  applyModal = document.createElement("div");
  applyModal.className = "job-apply-overlay";
  applyModal.innerHTML = `
    <div class="job-apply-dialog" role="dialog" aria-modal="true" aria-labelledby="jobApplyTitle" aria-describedby="jobApplyHelp">
      <header>
        <h3 id="jobApplyTitle" data-apply-title>Apply to this Matter</h3>
        <button type="button" class="close-btn" aria-label="Close apply form">&times;</button>
      </header>
      <p class="muted" id="jobApplyHelp">Share why you are a great fit (max ${APPLY_MAX_CHARS} characters).</p>
      <label class="sr-only" for="jobApplyCoverLetter">Cover letter</label>
      <textarea id="jobApplyCoverLetter" rows="6" maxlength="${APPLY_MAX_CHARS}" aria-describedby="jobApplyHelp" data-apply-text></textarea>
      <p class="apply-footnote">Your résumé and LinkedIn profile are included automatically.</p>
      <div class="apply-meta">
        <span data-apply-counter>0 / ${APPLY_MAX_CHARS}</span>
        <span role="status" aria-live="polite" data-apply-status></span>
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
    if (!applyModal?.classList.contains("show")) return;
    if (event.key === "Escape") {
      closeApplyModal();
      return;
    }
    trapDialogFocus(applyModal, event);
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
    if (!applyConfirmModal?.classList.contains("show")) return;
    if (event.key === "Escape") {
      closeApplyConfirmModal();
      return;
    }
    trapDialogFocus(applyConfirmModal, event);
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
    const res = await secureFetch(applyPath, {
      method: "POST",
      body: { coverLetter: note },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error || "Unable to submit application.";
      if (res.status === 403 && /profile photo/i.test(message)) {
        applyStatus.textContent = message;
        applySubmitBtn.disabled = false;
        applySubmitBtn.textContent = "Submit application";
        return;
      }
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
    const submittedJob = currentApplyJob;
    const submittedIds = getRecommendationIdentityIds(submittedJob || {});
    markJobAsApplied(jobId);
    publishRecommendationHistoryChange({
      viewerId,
      caseIds: [submittedJob?.caseId, submittedJob?.contextCaseId].filter(Boolean),
      jobIds: [submittedJob?.jobId, target?.type === "job" ? jobId : ""].filter(Boolean),
      matterIds: submittedIds,
    });
    const submittedTitle = currentApplyJob?.title || "";
    applyConfirmReturnFocus = applyReturnFocus;
    closeApplyModal({ restoreFocus: false });
    openApplyConfirmModal(submittedTitle);
    fetchJobs();
  } catch (error) {
    console.error(error);
    applyStatus.textContent = error.message || "Unable to submit application.";
    applySubmitBtn.disabled = false;
    applySubmitBtn.textContent = "Submit application";
  }
}

function markJobAsApplied(jobId) {
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
    const appliedAt = getAppliedAt(job);
    if (!allowApply) {
      jobApplyBtn.disabled = false;
      jobApplyBtn.textContent = "Apply for this Matter";
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
    } else if (!profilePhotoAllowed()) {
      jobApplyBtn.disabled = false;
      jobApplyBtn.textContent = "Apply for this Matter";
      jobApplyBtn.title = PROFILE_PHOTO_REQUIRED_MESSAGE;
      jobApplyBtn.classList.add("is-disabled");
      jobApplyBtn.setAttribute("aria-disabled", "true");
      jobApplyBtn.removeAttribute("data-stripe-required");
      jobApplyBtn.removeAttribute("data-hover-label");
    } else if (!stripeAllowed()) {
      jobApplyBtn.disabled = false;
      jobApplyBtn.textContent = "Apply for this Matter";
      jobApplyBtn.title = STRIPE_GATE_MESSAGE;
      jobApplyBtn.classList.add("is-disabled");
      jobApplyBtn.setAttribute("aria-disabled", "true");
      jobApplyBtn.dataset.stripeRequired = "true";
      jobApplyBtn.dataset.hoverLabel = "Stripe Setup Required";
    } else {
      jobApplyBtn.disabled = false;
      jobApplyBtn.textContent = "Apply for this Matter";
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

  const title = job.title || "Untitled Matter";
  const summary = job.shortDescription || job.practiceArea || job.briefSummary || "";
  const description = job.description || job.details || "No additional description provided.";
  const compensation = getJobCompensation(job);

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
  if (!attorneyId && modalJob) {
    try {
      await ensureAttorneyPreview(modalJob);
    } catch (error) {
      console.warn("[browse-matters] attorney preview hydration failed", error);
    }
    attorneyId = modalJob?.attorney?._id || modalJob?.attorneyId || "";
  }
  if (!attorneyId) {
    if (toast?.show) {
      toast.show("Unable to open this attorney profile right now.");
    } else {
      void showAlert("Unable to open this attorney profile right now.", { title: "Profile unavailable" });
    }
    return;
  }
  const url = new URL("profile-attorney.html", window.location.href);
  url.searchParams.set("id", attorneyId);
  url.searchParams.set("from", "browse");
  window.location.href = url.toString();
});

jobApplyBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!allowApply) {
    showToast("Only paralegals can apply to Matters.", "info");
    return;
  }
  if (!profilePhotoAllowed()) {
    showToast(PROFILE_PHOTO_REQUIRED_MESSAGE, "error");
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
    .job-apply-dialog .apply-meta{display:flex;align-items:center;justify-content:space-between;font-size:.85rem;color:#5f6670}
    .job-apply-dialog .apply-meta .error{color:#b91c1c}
    .job-apply-dialog .modal-actions{display:flex;justify-content:flex-end;gap:10px}
    .job-apply-dialog .muted{color:#5f6670;font-size:.9rem;margin:0}
    .job-apply-dialog .apply-footnote{margin:4px 0 0;color:#5f6670;font-size:.8rem}
    .apply-confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;pointer-events:none;transition:opacity .2s ease}
    .apply-confirm-overlay.show{opacity:1;pointer-events:auto}
    .apply-confirm-dialog{background:#fff;border-radius:18px;padding:22px;max-width:420px;width:92%;box-shadow:0 30px 60px rgba(0,0,0,.15);display:grid;gap:12px;text-align:center}
    .apply-confirm-dialog header{display:flex;align-items:center;justify-content:center;gap:12px}
    .apply-confirm-dialog h3{margin:0;font-family:'Cormorant Garamond',serif;font-weight:300;font-size:1.5rem}
    .apply-confirm-dialog .close-btn{border:none;background:none;font-size:1.5rem;line-height:1;cursor:pointer}
    .apply-confirm-message{margin:0;color:#4b5563;font-size:.95rem}
    .apply-confirm-actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}
    .apply-confirm-link{background:#b6a47a;color:#fff;border-radius:999px;padding:0.55rem 1.2rem;text-decoration:none;font-weight: 200;font-size:.95rem}
    .apply-confirm-close{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:0.55rem 1.2rem;font-weight: 200;font-size:.95rem;cursor:pointer}
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
    void showAlert(message, { title: type === "error" ? "Action unavailable" : "Notice" });
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
  menu.setAttribute("aria-label", "Flag Matter");
  const rawGroup = `flag-reason-${normalizeId(getJobUniqueId(job) || "case") || "case"}`;
  const groupName = rawGroup.replace(/[^a-zA-Z0-9_-]/g, "") || "flag-reason-case";

  const optionsMarkup = FLAG_REASONS.map(
    (reason) => `
      <label class="flag-option">
        <input type="radio" name="${escapeAttr(groupName)}" value="${escapeAttr(reason.value)}" />
        <span>${reason.label}</span>
      </label>
    `
  ).join("");

  menu.innerHTML = `
    <div class="flag-menu-title">Flag this Matter</div>
    <div class="flag-menu-subtitle">Why are you reporting this Matter?</div>
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
        showToast("Thanks for letting us know. We'll review this Matter.", "info");
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
  button.setAttribute("aria-label", "Flag this Matter");
  button.setAttribute("title", "Flag this Matter");
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
  const shell = document.querySelector(".browse-page-shell");
  listScrollState = {
    shell: shell?.scrollTop || 0,
    window: window.scrollY || 0,
  };
  expandedReturnJobId = id;
  expandedJobId = id;
  renderJobs();
  setTimeout(scrollToExpandedCard, 10);
}

function collapseExpanded() {
  expandedJobId = "";
  renderJobs();
  requestAnimationFrame(() => {
    const shell = document.querySelector(".browse-page-shell");
    if (shell) shell.scrollTop = listScrollState.shell;
    window.scrollTo({ top: listScrollState.window, behavior: "auto" });
    if (expandedReturnJobId) {
      const selector = `.job-card .clear-button[data-job-id="${escapeAttr(expandedReturnJobId)}"]`;
      document.querySelector(selector)?.focus({ preventScroll: true });
    }
    expandedReturnJobId = "";
  });
}

function scrollToExpandedCard() {
  const card = document.querySelector(".job-card.expanded");
  if (!card) return;
  const shell = document.querySelector(".browse-page-shell");
  const rect = card.getBoundingClientRect();
  if (shell && shell.scrollHeight > shell.clientHeight) {
    const shellRect = shell.getBoundingClientRect();
    const target = Math.max(0, shell.scrollTop + rect.top - shellRect.top - 24);
    shell.scrollTo({ top: target, behavior: "smooth" });
    return;
  }
  const target = Math.max(0, rect.top + window.scrollY - 24);
  window.scrollTo({ top: target, behavior: "smooth" });
}

function buildApplyButton(job, jobId, appliedAt) {
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "apply-button";
  applyBtn.dataset.jobId = jobId;
  if (!allowApply) {
    applyBtn.textContent = "Apply for this Matter";
    applyBtn.title = "Only paralegals can apply.";
    applyBtn.classList.add("is-disabled");
    applyBtn.setAttribute("aria-disabled", "true");
    applyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      showToast("Only paralegals can apply to Matters.", "info");
    });
    } else if (appliedAt) {
      applyBtn.disabled = true;
      applyBtn.textContent = `✓ ${formatAppliedLabel(appliedAt)}`;
      applyBtn.removeAttribute("data-stripe-required");
      applyBtn.removeAttribute("data-hover-label");
    } else if (!profilePhotoAllowed()) {
      applyBtn.textContent = "Apply for this Matter";
      applyBtn.title = PROFILE_PHOTO_REQUIRED_MESSAGE;
      applyBtn.classList.add("is-disabled");
      applyBtn.setAttribute("aria-disabled", "true");
      applyBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        showToast(PROFILE_PHOTO_REQUIRED_MESSAGE, "error");
      });
    } else if (!stripeAllowed()) {
      applyBtn.textContent = "Apply for this Matter";
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
      applyBtn.textContent = "Apply for this Matter";
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
  const compensation = getJobCompensation(job);
  const jobState = getJobState(job) || "—";
  const when = job.createdAt
    ? new Date(job.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })
    : "Recently posted";
  const showPartial = isPartiallyCompletedRelist(job);
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
                if (!title) return "";
                const isComplete = typeof task === "object" && task?.completed;
                const className = isComplete ? ' class="task-completed"' : "";
                return `<li${className}>${escapeHtml(title)}</li>`;
              })
              .filter(Boolean)
              .join("")}
          </ul>`
        : `<div class="job-task-empty">No tasks listed yet.</div>`
    }
  `;
  const applyInfoHtml = allowApply
    ? `
        <details class="apply-info-disclosure">
          <summary aria-label="What happens after you apply">?</summary>
          <div class="apply-info">
            <div class="apply-info-title">What Happens After You Apply</div>
            <ul class="apply-info-list">
              <li>The attorney reviews applications</li>
              <li>Selected applicants are invited to the workspace</li>
              <li>Scope is confirmed and work begins</li>
              <li>Compensation is released after attorney approval and Matter completion</li>
            </ul>
          </div>
        </details>
      `
    : "";

  card.className = "job-card expanded";

  const title = escapeHtml(job.title || "Matter");
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
          ${showPartial ? `<div class="partial-completion-note">This Matter has been partially completed</div>` : ""}

        </div>
        <div class="expanded-actions">
          ${applyInfoHtml}
        </div>
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
          <a class="posted-link" data-attorney-link>
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
    backBtn.textContent = "Back to all Matters";
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
    .catch((error) => {
      console.warn("[browse] attorney preview hydration rejected", error);
    });

  return card;
}

function syncExpansionLayout() {
  const isExpanded = !!expandedJobId;
  document.body.classList.toggle("job-expanded", isExpanded);
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
  const url = new URL("profile-attorney.html", window.location.href);
  url.searchParams.set("id", attorneyId);
  url.searchParams.set("from", "browse");
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
      countEl.textContent = `${count} completed Matters`;
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
      linkEl.removeAttribute("href");
      delete linkEl.dataset.attorneyLinkReady;
    }
  }
}
