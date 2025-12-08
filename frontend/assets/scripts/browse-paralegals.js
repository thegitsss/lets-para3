import { requireAuth, secureFetch, logout } from "./auth.js";

const isPublicView = !localStorage.getItem("lpc_user");

const states = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia",
  "Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts",
  "Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey",
  "New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island",
  "South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
  "Wisconsin","Wyoming"
];

const specialties = [
  "Administrative Law","Admiralty / Maritime Law","Appellate Law","Banking & Finance Law","Bankruptcy Law",
  "Business / Corporate Law","Civil Rights Law","Class Action Law","Commercial Law","Constitutional Law",
  "Construction Law","Consumer Law","Contract Law","Criminal Defense","Education Law","Elder Law",
  "Employment / Labor Law","Energy Law","Entertainment Law","Environmental Law","Family Law","Government Law",
  "Health Law","Immigration Law","Insurance Law","Intellectual Property","International Law","Litigation",
  "Medical Malpractice","Mergers & Acquisitions","Personal Injury","Privacy / Data Security","Product Liability",
  "Real Estate Law","Securities Law","Social Security / Disability","Tax Law","Technology Law","Torts",
  "Trusts & Estates","Workers’ Compensation"
];

const selectedSpecialties = new Set();

const elements = {
  results: document.getElementById("paralegalResults"),
  status: document.getElementById("resultsStatus"),
  experience: document.getElementById("experience"),
  availability: document.getElementById("availability"),
  stateInput: document.getElementById("stateInput"),
  stateList: document.getElementById("stateList"),
  specialtyInput: document.getElementById("specialtyInput"),
  specialtyList: document.getElementById("specialtyList"),
  prevPage: document.getElementById("prevPage"),
  nextPage: document.getElementById("nextPage"),
  paginationLabel: document.getElementById("paginationLabel"),
  inquireModal: document.getElementById("inquireModal"),
  jobList: document.getElementById("jobList"),
  inquireMessage: document.getElementById("inquireMessage"),
  cancelInquire: document.getElementById("cancelInquire"),
  confirmInquire: document.getElementById("confirmInquire"),
  selectedParalegalText: document.getElementById("selectedParalegalText"),
};

const state = {
  page: 1,
  limit: 15,
  total: 0,
  pages: 1,
  filters: {
    experience: "",
    availability: "",
    location: "",
    specialties: selectedSpecialties,
  },
};

let availableCases = [];
let activeParalegal = null;
const toast = window.toastUtils;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.getElementById("logoutBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    logout("login.html");
  });

  if (isPublicView) {
    document.body.classList.add("public-view");
    renderPublicSample();
    return;
  }

  try {
    requireAuth("attorney");
  } catch {
    return;
  }

  initStateDropdown();
  initSpecialtyDropdown();
  bindFilterEvents();
  bindModalEvents();

  await loadCases();
  await loadParalegals();
}

function bindFilterEvents() {
  elements.experience?.addEventListener("change", () => {
    state.filters.experience = elements.experience.value;
    resetPageAndFetch();
  });
  elements.availability?.addEventListener("change", () => {
    state.filters.availability = elements.availability.value;
    resetPageAndFetch();
  });
  elements.stateInput?.addEventListener("change", () => {
    state.filters.location = (elements.stateInput.value || "").trim();
    resetPageAndFetch();
  });
  elements.stateInput?.addEventListener("blur", () => {
    state.filters.location = (elements.stateInput.value || "").trim();
    resetPageAndFetch();
  });

  elements.prevPage?.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      loadParalegals();
    }
  });
  elements.nextPage?.addEventListener("click", () => {
    if (state.page < state.pages) {
      state.page += 1;
      loadParalegals();
    }
  });
}

function bindModalEvents() {
  elements.cancelInquire?.addEventListener("click", closeInquireModal);
  elements.inquireModal?.addEventListener("click", (event) => {
    if (event.target === elements.inquireModal) {
      closeInquireModal();
    }
  });
  elements.confirmInquire?.addEventListener("click", sendInquiry);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeInquireModal();
  });
}

function initStateDropdown() {
  if (!elements.stateInput || !elements.stateList) return;
  const render = (query = "") => {
    const matches = states.filter((s) => s.toLowerCase().startsWith(query.toLowerCase()));
    elements.stateList.innerHTML = matches.map((s) => `<li>${s}</li>`).join("");
    elements.stateList.classList.toggle("show", matches.length > 0);
  };
  elements.stateInput.addEventListener("input", () => render(elements.stateInput.value));
  elements.stateInput.addEventListener("focus", () => render(elements.stateInput.value));
  elements.stateList.addEventListener("click", (event) => {
    if (event.target.tagName === "LI") {
      elements.stateInput.value = event.target.textContent;
      elements.stateList.classList.remove("show");
      state.filters.location = event.target.textContent;
      resetPageAndFetch();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".dropdown-wrapper")) {
      elements.stateList.classList.remove("show");
      elements.specialtyList?.classList.remove("show");
    }
  });
}

function initSpecialtyDropdown() {
  if (!elements.specialtyInput || !elements.specialtyList) return;
  const renderList = () => {
    elements.specialtyList.innerHTML = specialties
      .map((spec) => {
        const slug = spec.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return `
        <li>
          <input type="checkbox" id="spec-${slug}" value="${spec}" ${selectedSpecialties.has(spec) ? "checked" : ""}>
          <label for="spec-${slug}">${spec}</label>
        </li>`;
      })
      .join("");
  };
  elements.specialtyInput.addEventListener("focus", () => {
    renderList();
    elements.specialtyList.classList.add("show");
  });
  elements.specialtyList.addEventListener("change", (event) => {
    const value = event.target.value;
    if (!value) return;
    if (event.target.checked) selectedSpecialties.add(value);
    else selectedSpecialties.delete(value);
    updateSpecialtyInput();
    resetPageAndFetch();
  });
  updateSpecialtyInput();
}

function updateSpecialtyInput() {
  if (!elements.specialtyInput) return;
  elements.specialtyInput.value = [...selectedSpecialties].join(", ");
}

function resetPageAndFetch() {
  state.page = 1;
  loadParalegals();
}

async function loadParalegals() {
  if (!elements.results || !elements.status) return;
  setResultsStatus("Loading paralegals…");
  const params = new URLSearchParams();
  params.set("page", state.page);
  params.set("limit", state.limit);

  const minYears = parseExperience(state.filters.experience);
  if (minYears) params.set("minYears", String(minYears));
  if (state.filters.availability) params.set("availability", state.filters.availability);
  if (state.filters.location) params.set("location", state.filters.location);
  if (selectedSpecialties.size) {
    params.set("practice", [...selectedSpecialties].join("|"));
  }

  try {
    const res = await secureFetch(`/api/users/paralegals?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || "Unable to load paralegals");
    }
    renderParalegals(Array.isArray(data.items) ? data.items : []);
    updatePagination(data);
  } catch (error) {
    console.error(error);
    renderParalegals([]);
    setResultsStatus(error.message || "Unable to load paralegals right now.", true);
  }
}

async function loadCases() {
  try {
    const res = await secureFetch("/api/cases/my?limit=50&archived=false", {
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    availableCases = Array.isArray(data)
      ? data.filter((c) => !["completed", "closed", "archived"].includes(String(c.status || "").toLowerCase()))
      : [];
  } catch (error) {
    console.warn("Unable to load cases", error);
    availableCases = [];
  }
  renderCaseOptions();
}

function renderParalegals(items) {
  elements.results.innerHTML = "";
  if (elements.status) {
    elements.results.appendChild(elements.status);
  }
  if (!items.length) {
    setResultsStatus("No paralegals match your filters yet.");
    return;
  }
  setResultsStatus("");
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    fragment.appendChild(buildParalegalCard(item));
  });
  elements.results.appendChild(fragment);
}

function buildParalegalCard(paralegal) {
  const name = formatName(paralegal);
  const summary = (paralegal.bio || paralegal.about || "This professional hasn’t added a summary yet.").trim();
  const location = paralegal.location || "Location not specified";
  const availability = paralegal.availability || "Availability on request";
  const specialties = (paralegal.practiceAreas || []).slice(0, 2);
  const experience = formatExperience(paralegal.yearsExperience);
  const avatar = paralegal.avatarURL || buildInitialAvatar(getInitials(name));

  const card = document.createElement("article");
  card.className = "paralegal-card";

  const publicProfileUrl = `profile-paralegal.html?id=${paralegal.id || paralegal._id}`;

  const photoLink = document.createElement("a");
  photoLink.className = "profile-photo-link profile-link";
  photoLink.href = publicProfileUrl;
  if (isPublicView) {
    photoLink.removeAttribute("href");
    photoLink.setAttribute("aria-disabled", "true");
  }
  const img = document.createElement("img");
  img.src = avatar;
  img.alt = `Portrait of ${name}`;
  photoLink.appendChild(img);
  card.appendChild(photoLink);

  const content = document.createElement("div");
  content.className = "card-content";
  const heading = document.createElement("h3");
  const headingLink = document.createElement("a");
  headingLink.href = publicProfileUrl;
  headingLink.textContent = name;
  headingLink.className = "profile-name-link profile-link";
  if (isPublicView) {
    headingLink.removeAttribute("href");
    headingLink.setAttribute("aria-disabled", "true");
  }
  heading.appendChild(headingLink);
  content.appendChild(heading);

  const intro = document.createElement("p");
  intro.textContent = `${specialties[0] || "Generalist"} · ${location}`;
  content.appendChild(intro);

  const bio = document.createElement("p");
  bio.textContent = truncate(summary, 240);
  content.appendChild(bio);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.appendChild(buildMetaChip("Experience", experience));
  meta.appendChild(buildMetaChip("Availability", availability));
  if (specialties.length) {
    meta.appendChild(buildMetaChip("Specialty", specialties.join(", ")));
  }
  content.appendChild(meta);
  card.appendChild(content);

  if (!isPublicView) {
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const inquireBtn = document.createElement("button");
    inquireBtn.type = "button";
    inquireBtn.className = "action-btn invite-btn";
    inquireBtn.textContent = "Invite to Job";
    inquireBtn.addEventListener("click", () => openInquireModal({ id: paralegal.id || paralegal._id, name }));
    actions.appendChild(inquireBtn);
    card.appendChild(actions);
  }

  return card;
}

function buildMetaChip(label, value) {
  const span = document.createElement("span");
  span.textContent = `${label}: ${value}`;
  return span;
}

function setResultsStatus(message, isError = false) {
  if (!elements.status) return;
  elements.status.textContent = message || "";
  elements.status.classList.toggle("error", Boolean(isError));
  elements.status.style.display = message ? "block" : "none";
}

function updatePagination(data = {}) {
  state.total = Number(data.total || 0);
  state.pages = Number(data.pages || 1) || 1;
  updatePaginationLabel();
  if (elements.prevPage) elements.prevPage.disabled = state.page <= 1;
  if (elements.nextPage) elements.nextPage.disabled = state.page >= state.pages;
}

function updatePaginationLabel() {
  if (!elements.paginationLabel) return;
  const from = state.total ? (state.page - 1) * state.limit + 1 : 0;
  const to = Math.min(state.page * state.limit, state.total);
  const range = state.total ? `${from}-${to}` : "0";
  elements.paginationLabel.textContent = `Page ${state.page} of ${Math.max(state.pages, 1)} • Showing ${range} of ${state.total}`;
}

function openInquireModal(paralegal) {
  activeParalegal = paralegal;
  if (!elements.inquireModal) return;
  elements.selectedParalegalText.textContent = `Select the open case for ${paralegal.name}.`;
  elements.inquireMessage.value = "";
  const firstOption = elements.jobList.querySelector("input[name='jobOption']");
  if (firstOption) firstOption.checked = false;
  elements.confirmInquire.disabled = !availableCases.length;
  elements.inquireModal.classList.add("show");
}

function closeInquireModal() {
  activeParalegal = null;
  elements.inquireModal?.classList.remove("show");
  elements.inquireMessage.value = "";
  const checked = elements.jobList?.querySelector("input[name='jobOption']:checked");
  if (checked) checked.checked = false;
}

function renderCaseOptions() {
  if (!elements.jobList) return;
  if (!availableCases.length) {
    elements.jobList.innerHTML = "<p>No open cases available. Post a job to invite paralegals.</p>";
    elements.confirmInquire.disabled = true;
    return;
  }
  elements.jobList.innerHTML = availableCases
    .map(
      (c) => `
      <label class="job-option">
        <input type="radio" name="jobOption" value="${c.id || c._id}">
        <span>${escapeHtml(c.title || "Untitled matter")}</span>
      </label>`
    )
    .join("");
  elements.confirmInquire.disabled = false;
}

async function sendInquiry() {
  if (!activeParalegal || !elements.jobList) return;
  const selected = elements.jobList.querySelector("input[name='jobOption']:checked");
  if (!selected) {
    showToast("Select an open case first.", "err");
    return;
  }
  const message = (elements.inquireMessage.value || "").trim();
  try {
    const res = await secureFetch(`/api/users/${activeParalegal.id}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: selected.value, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Unable to send invite");
    }
    showToast("Invite sent successfully.", "ok");
    closeInquireModal();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to send invite", "err");
  }
}

function renderPublicSample() {
  const sample = [
    {
      id: "public-elena",
      firstName: "Elena",
      lastName: "Rhodes",
      practiceAreas: ["Commercial Litigation", "E-Discovery"],
      location: "New York, NY",
      bio: "Litigation specialist managing large-scale discovery, deposition prep, and expert coordination for financial disputes.",
      availability: "Accepting new matters · 30 hrs/week",
      yearsExperience: 12,
    },
    {
      id: "public-marcus",
      firstName: "Marcus",
      lastName: "Salgado",
      practiceAreas: ["Immigration", "Removal Defense"],
      location: "Miami, FL",
      bio: "Bilingual immigration paralegal supporting removal defense, humanitarian relief, and complex family-based filings.",
      availability: "Currently assisting two firms",
      yearsExperience: 9,
    },
    {
      id: "public-priya",
      firstName: "Priya",
      lastName: "Chandra",
      practiceAreas: ["Corporate Transactions", "M&A"],
      location: "San Francisco, CA",
      bio: "Corporate paralegal focused on venture financings, M&A diligence, and secure data room administration.",
      availability: "Project-based engagements preferred",
      yearsExperience: 10,
    },
  ];

  if (!elements.results) return;
  setResultsStatus("");
  elements.results.innerHTML = "";
  const fragment = document.createDocumentFragment();
  sample.forEach((item) => fragment.appendChild(buildParalegalCard(item)));
  elements.results.appendChild(fragment);
}

function parseExperience(value = "") {
  const match = value.match(/\\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function formatExperience(years) {
  const num = Number(years);
  if (Number.isNaN(num)) return "Experience varies";
  if (num <= 0) return "Under a year";
  if (num >= 10) return "10+ years";
  return `${Math.round(num)}+ years`;
}

function formatName(person = {}) {
  const fn = person.firstName || person.first_name || "";
  const ln = person.lastName || person.last_name || "";
  return `${fn} ${ln}`.trim() || "Experienced Paralegal";
}

function getInitials(name = "") {
  const parts = name.trim().split(/\\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() || "");
  return (initials.join("") || "A").slice(0, 2);
}

function buildInitialAvatar(initials) {
  const label = (initials || "A").slice(0, 2).toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><circle cx='40' cy='40' r='36' fill='#d4c6a4' stroke='#ffffff' stroke-width='4'/><text x='50%' y='55%' text-anchor='middle' font-family='Sarabun, Arial' font-size='28' fill='#1a1a1a' font-weight='600'>${label}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function truncate(text, max = 200) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message, type = "info") {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}
