import { secureFetch } from "../auth.js";

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

let allJobs = [];
let filteredJobs = [];
const APPLY_MAX_CHARS = 2000;
const APPLIED_STORAGE_KEY = "lpc_applied_jobs";
const appliedJobs = new Set(loadAppliedJobs());
let applyModal = null;
let applyTextarea = null;
let applyStatus = null;
let applySubmitBtn = null;
let applyTitle = null;
let applyCounter = null;
let currentApplyJob = null;
let csrfToken = "";
const toast = window.toastUtils;
let expandedJobId = "";

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
async function ensureSession() {
  if (sessionReady) return true;
  try {
    if (typeof window.checkSession === "function") {
      await window.checkSession("paralegal");
    }
    sessionReady = true;
    return true;
  } catch (err) {
    console.warn("Paralegal session required", err);
    return false;
  }
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
  const label = value >= 10 ? "10+ years" : `${value} year${value === 1 ? "" : "s"}`;
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
function applyFilters() {
  const area = practiceAreaSelect?.value || "";
  const state = stateSelect?.value || "";
  const minPay = quantizePayValue(minPaySlider?.value || 0);
  const maxExpValue = clampExperienceValue(minExpSlider?.value || 0);
  const expLimit = maxExpValue >= 10 ? Infinity : maxExpValue;

  filteredJobs = allJobs.filter((job) => {
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
  renderJobs();
  filterMenu?.classList.remove("active");
}

applyFiltersBtn?.addEventListener("click", applyFilters);

// Clear filters
function clearFilters() {
  if (practiceAreaSelect) practiceAreaSelect.value = "";
  if (stateSelect) stateSelect.value = "";
  if (minPaySlider) {
    minPaySlider.value = 0;
    updatePayLabel(0);
  }
  if (minExpSlider) {
    minExpSlider.value = 10;
    updateExperienceLabel(10);
  }
  if (sortSelect) sortSelect.value = "";

  filteredJobs = [...allJobs];
  applySort();
  renderJobs();
  filterMenu?.classList.remove("active");
}

clearFiltersBtn?.addEventListener("click", clearFilters);

// Helpers
function getJobPayUSD(job) {
  if (!job) return 0;
  if (typeof job.totalAmount === "number") return Math.max(0, job.totalAmount / 100);
  if (typeof job.payAmount === "number") return Math.max(0, job.payAmount);
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
    empty.textContent = "No jobs match your filters yet. Try adjusting filters or check back soon.";
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
    const jobId = String(job.id || job._id || "");
    const caseId = getJobUniqueId(job) || jobId;

    card.innerHTML = `
      <h3>${title}</h3>
      <div class="area">${practice}</div>
      <div class="meta">
        <span>${escapeHtml(jobState || "—")}</span>
        <span>$${formatPay(payUSD)}</span>
        <span>${escapeHtml(when)}</span>
      </div>
    `;

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

    actions.appendChild(buildApplyButton(job, jobId || caseId));

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
    filteredJobs = [...allJobs];

    populateFilters();
    applySort();
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

ensureSession().then((ready) => {
  if (ready) fetchJobs();
});

sortSelect?.addEventListener("change", () => {
  applySort();
  renderJobs();
});

function openApplyModal(job) {
  if (!job) return;
  ensureApplyModal();
  currentApplyJob = job;
  const jobId = String(job.id || job._id || "");
  if (!jobId) return;
  applyModal.dataset.jobId = jobId;
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
  }
  currentApplyJob = null;
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
      <p class="apply-footnote">Your résumé, LinkedIn profile, and saved cover letter are included automatically.</p>
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

async function submitApplication() {
  if (!currentApplyJob || !applyTextarea || !applyStatus || !applySubmitBtn) return;
  const jobId = String(currentApplyJob.id || currentApplyJob._id || "");
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
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/apply`, {
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
      throw new Error(data?.error || "Unable to submit application.");
    }
    applyStatus.textContent = "Application submitted!";
    markJobAsApplied(jobId);
    showToast("Application submitted successfully.", "ok");
    setTimeout(() => {
      closeApplyModal();
      fetchJobs();
    }, 800);
  } catch (error) {
    console.error(error);
    applyStatus.textContent = error.message || "Unable to submit application.";
    applySubmitBtn.disabled = false;
    applySubmitBtn.textContent = "Submit application";
  }
}

function markJobAsApplied(jobId) {
  appliedJobs.add(jobId);
  persistAppliedJobs();
  const selector = `[data-job-id="${escapeAttr(jobId)}"]`;
  document.querySelectorAll(selector).forEach((btn) => {
    btn.disabled = true;
    btn.textContent = "Application sent";
  });
}

function loadAppliedJobs() {
  try {
    const raw = sessionStorage.getItem(APPLIED_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function persistAppliedJobs() {
  try {
    sessionStorage.setItem(APPLIED_STORAGE_KEY, JSON.stringify([...appliedJobs]));
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
  try {
    await ensureAttorneyPreview(job);
  } catch (err) {
    console.warn("Attorney preview load failed", err);
  }

  const title = job.title || "Untitled job";
  const summary = job.shortDescription || job.practiceArea || job.briefSummary || "";
  const description = job.description || job.details || "No additional description provided.";
  const payUSD = getJobPayUSD(job);
  const budget = typeof job.budget === "number" ? job.budget : null;
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

function escapeAttr(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value || "").replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getJobUniqueId(job) {
  return String(
    job?.caseId || job?.case_id || job?.case || job?.id || job?._id || job?.jobId || job?.job_id || ""
  );
}

function expandJob(job) {
  const id = getJobUniqueId(job);
  if (!id) {
    openJobModal(job);
    return;
  }
  expandedJobId = id;
  renderJobs();
  if (jobsGrid?.scrollIntoView) {
    setTimeout(() => jobsGrid.scrollIntoView({ behavior: "smooth", block: "start" }), 10);
  }
}

function collapseExpanded() {
  expandedJobId = "";
  renderJobs();
  if (jobsGrid?.scrollIntoView) {
    setTimeout(() => jobsGrid.scrollIntoView({ behavior: "smooth", block: "start" }), 10);
  }
}

function buildApplyButton(job, jobId) {
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "apply-button";
  applyBtn.dataset.jobId = jobId;
  if (appliedJobs.has(jobId)) {
    applyBtn.disabled = true;
    applyBtn.textContent = "Application sent";
  } else {
    applyBtn.textContent = "Apply for this case";
    applyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openApplyModal(job);
    });
  }
  return applyBtn;
}

function renderExpandedJob(job) {
  const card = document.createElement("div");
  card.className = "job-card expanded";
  const caseId = getJobUniqueId(job);
  const jobId = String(job.id || job._id || "") || caseId;
  const payUSD = getJobPayUSD(job);
  const budget = typeof job.budget === "number" ? job.budget : null;
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
      <aside class="expanded-sidebar">
        <div class="apply-info">
          <div class="apply-info-title">What Happens After You Apply</div>
          <ul class="apply-info-list">
            <li>The attorney reviews applications</li>
            <li>Selected paralegals receive full case details</li>
            <li>Work is completed through Let’s ParaConnect</li>
            <li>Payment is released upon approval</li>
          </ul>
        </div>
        <div class="expanded-actions" data-expanded-buttons></div>
      </aside>
      <div class="expanded-body">
        ${summary ? `<p class="lede">${escapeHtml(summary)}</p>` : ""}
        <div class="description-label">DESCRIPTION</div>
        <div class="rich-text main-description">${escapeHtml(description)}</div>
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
              <div class="posted-trust" data-posted-trust></div>
            </div>
          </a>
        </div>
        <div class="expanded-footer-actions" data-footer-actions></div>
      </div>
    </div>
  `;

  // Ensure no legacy attorney card markup lingers in this view.
  card.querySelectorAll(".attorney-block, .attorney-card, .job-sidebar-card").forEach((node) => node.remove());

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

    const applyBtn = buildApplyButton(job, jobId);
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
  const trustEl = root.querySelector("[data-posted-trust]");
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
  if (trustEl) {
    const count = getCompletedJobsCount(job);
    if (count >= 2) {
      trustEl.textContent = `${count} completed jobs`;
      trustEl.style.display = "";
    } else {
      trustEl.textContent = "";
      trustEl.style.display = "none";
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
