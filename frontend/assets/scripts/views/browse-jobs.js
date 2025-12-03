const jobsGrid = document.getElementById("jobs-grid");
const pagination = document.getElementById("pagination");

let allJobs = [];
let filteredJobs = [];

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
  const payValues = allJobs.map((job) => getJobPayUSD(job)).filter((value) => Number.isFinite(value));
  const maxPay = payValues.length ? Math.max(...payValues) : 0;
  minPaySlider.max = Math.max(1000, Math.ceil(maxPay));
  minPaySlider.value = 0;
  minPayValue.textContent = "$0";

  // Experience slider
  const expValues = allJobs.map((job) => getJobExperience(job)).filter((value) => Number.isFinite(value));
  const maxExp = expValues.length ? Math.max(...expValues) : 0;
  minExpSlider.max = Math.max(20, Math.ceil(maxExp));
  minExpSlider.value = 0;
  minExpValue.textContent = "0 years";
}

// Slider displays
minPaySlider?.addEventListener("input", () => {
  minPayValue.textContent = `$${Number(minPaySlider.value).toLocaleString()}`;
});

minExpSlider?.addEventListener("input", () => {
  minExpValue.textContent = `${minExpSlider.value} years`;
});

// Apply filters
function applyFilters() {
  const area = practiceAreaSelect?.value || "";
  const state = stateSelect?.value || "";
  const minPay = Number(minPaySlider?.value || 0);
  const maxExp = Number(minExpSlider?.value || 0);

  filteredJobs = allJobs.filter((job) => {
    const payUSD = getJobPayUSD(job);
    const exp = getJobExperience(job);
    const jobState = getJobState(job);

    if (area && job.practiceArea !== area) return false;
    if (state && jobState !== state) return false;
    if (payUSD < minPay) return false;
    if (exp > maxExp) return false;

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
  if (minPaySlider) minPaySlider.value = 0;
  if (minExpSlider) minExpSlider.value = 0;
  if (minPayValue) minPayValue.textContent = "$0";
  if (minExpValue) minExpValue.textContent = "0 years";
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

    card.innerHTML = `
      <h3>${job.title || "Untitled Matter"}</h3>
      <div class="area">${job.practiceArea || "General Practice"}</div>
      <div class="meta">
        <span>${jobState}</span>
        <span>$${formatPay(payUSD)}</span>
        <span>${job.createdAt ? new Date(job.createdAt).toLocaleDateString() : "Recently posted"}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      const id = job.id || job._id;
      if (id) window.location.href = `case-detail.html?caseId=${id}`;
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
  try {
    const res = await fetch("/cases/open", {
      headers: { Authorization: `Bearer ${localStorage.getItem("lpc_token")}` },
    });

    const data = await res.json();
    allJobs = Array.isArray(data) ? data : [];
    filteredJobs = [...allJobs];

    populateFilters();
    applySort();
    renderJobs();
  } catch (err) {
    console.error("Failed to load jobs", err);
    allJobs = [];
    filteredJobs = [];
    renderJobs();
  }
}

fetchJobs();

sortSelect?.addEventListener("change", () => {
  applySort();
  renderJobs();
});
