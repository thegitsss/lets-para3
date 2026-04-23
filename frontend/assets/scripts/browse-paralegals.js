import { secureFetch, logout } from "./auth.js";

const states = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia",
  "Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts",
  "Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey",
  "New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island",
  "South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
  "Wisconsin","Wyoming"
];

const specialties = [
  "Administrative Law","Admiralty / Maritime Law","Antitrust Law","Appellate Law","Banking & Finance Law","Bankruptcy Law",
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
  sortBy: document.getElementById("sortBy"),
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
  filterMenu: document.getElementById("filterMenu"),
  filterToggle: document.getElementById("filterToggle"),
  applyFilters: document.getElementById("applyFilters"),
  clearFilters: document.getElementById("clearFilters"),
  authBlocker: document.getElementById("authBlocker"),
  returnDashboard: document.getElementById("returnDashboard"),
};

const state = {
  page: 1,
  limit: 10,
  total: 0,
  pages: 1,
  filters: {
    experience: "",
    availability: "",
    location: "",
    sort: "recent",
    specialties: selectedSpecialties,
  },
  viewer: null,
  viewerRole: "",
  isLoggedIn: false,
  canInvite: false,
};

let availableCases = [];
let activeParalegal = null;
const toast = window.toastUtils;
const AUTH_LOCK_CLASS = "auth-locked";
const AUTH_BLOCKER_READY_CLASS = "auth-blocker-ready";

function normalizeId(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object") return String(val.id || val._id || val.paralegalId || "");
  return "";
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await hydrateViewer();
  syncAuthButtons();
  toggleAuthBlocker();
  initStateDropdown();
  initSpecialtyDropdown();
  bindFilterEvents();
  bindFilterMenuToggle();
  bindFilterButtons();
  bindModalEvents();

  if (state.canInvite) {
    await loadCases();
  } else {
    renderCaseOptions();
  }

  await loadParalegals();
}

async function hydrateViewer() {
  let user = null;
  let role = "";
  if (typeof window.getSessionData === "function") {
    try {
      const session = await window.getSessionData();
      user = session?.user || null;
      role = session?.role || "";
    } catch {}
  }
  state.viewer = user;
  state.viewerRole = String(role || "").toLowerCase();
  state.isLoggedIn = Boolean(user);
  state.canInvite = state.viewerRole === "attorney";
}

function syncAuthButtons() {
  const signInLink = document.getElementById("authAction");
  const logoutBtn = document.getElementById("logoutAction");
  if (elements.returnDashboard) {
    if (state.isLoggedIn) {
      const dashboardHref =
        state.viewerRole === "paralegal"
          ? "dashboard-paralegal.html"
          : state.viewerRole === "admin"
          ? "admin-dashboard.html"
          : "dashboard-attorney.html";
      elements.returnDashboard.href = dashboardHref;
      elements.returnDashboard.textContent = "RETURN TO DASHBOARD";
    } else {
      elements.returnDashboard.href = "login.html";
      elements.returnDashboard.textContent = "Sign In";
    }
  }
  if (state.isLoggedIn) {
    if (signInLink) signInLink.style.display = "none";
    if (logoutBtn) {
      logoutBtn.style.display = "inline-flex";
      logoutBtn.addEventListener("click", (event) => {
        event.preventDefault();
        logout("login.html");
      });
    }
  } else {
    if (logoutBtn) logoutBtn.style.display = "none";
    if (signInLink) signInLink.style.display = "inline-flex";
  }
}

function toggleAuthBlocker() {
  if (!elements.authBlocker || !document.body) return;
  if (state.isLoggedIn) {
    closeAuthBlocker();
  }
  if (!state.isLoggedIn) closeAuthBlocker();
}

function openAuthBlocker() {
  if (!elements.authBlocker || !document.body) return;
  document.body.classList.add(AUTH_LOCK_CLASS);
  document.body.classList.add(AUTH_BLOCKER_READY_CLASS);
  elements.authBlocker.setAttribute("aria-hidden", "false");
}

function closeAuthBlocker() {
  if (!elements.authBlocker || !document.body) return;
  document.body.classList.remove(AUTH_LOCK_CLASS);
  document.body.classList.remove(AUTH_BLOCKER_READY_CLASS);
  elements.authBlocker.setAttribute("aria-hidden", "true");
}

function requireSignIn(event) {
  if (state.isLoggedIn) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  openAuthBlocker();
  return true;
}

function bindFilterEvents() {
  elements.experience?.addEventListener("change", () => {
    state.filters.experience = elements.experience.value;
  });
  elements.availability?.addEventListener("change", () => {
    state.filters.availability = elements.availability.value;
  });
  elements.sortBy?.addEventListener("change", () => {
    state.filters.sort = normalizeSortValue(elements.sortBy.value);
    resetPageAndFetch();
  });
  elements.stateInput?.addEventListener("change", () => {
    state.filters.location = (elements.stateInput.value || "").trim();
  });
  elements.stateInput?.addEventListener("blur", () => {
    state.filters.location = (elements.stateInput.value || "").trim();
  });

  elements.prevPage?.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      window.scrollTo({ top: 0, behavior: "smooth" });
      loadParalegals();
    }
  });
  elements.nextPage?.addEventListener("click", () => {
    if (state.page < state.pages) {
      state.page += 1;
      window.scrollTo({ top: 0, behavior: "smooth" });
      loadParalegals();
    }
  });
}

function bindFilterMenuToggle() {
  const menu = elements.filterMenu;
  const toggle = elements.filterToggle;
  if (!menu || !toggle) return;
  toggle.addEventListener("click", () => {
    menu.classList.toggle("active");
  });
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target) && !toggle.contains(event.target)) {
      menu.classList.remove("active");
    }
  });
}

function bindFilterButtons() {
  elements.applyFilters?.addEventListener("click", () => {
    syncFiltersFromInputs();
    elements.filterMenu?.classList.remove("active");
    resetPageAndFetch();
  });
  elements.clearFilters?.addEventListener("click", () => {
    if (elements.experience) elements.experience.value = "";
    if (elements.availability) elements.availability.value = "";
    if (elements.stateInput) elements.stateInput.value = "";
    state.filters.experience = "";
    state.filters.availability = "";
    state.filters.location = "";
    selectedSpecialties.clear();
    updateSpecialtyInput();
    if (elements.specialtyList) {
      elements.specialtyList.querySelectorAll("input[type='checkbox']").forEach((cb) => {
        cb.checked = false;
      });
      elements.specialtyList.classList.remove("show");
    }
    elements.stateList?.classList.remove("show");
    elements.filterMenu?.classList.remove("active");
    syncFiltersFromInputs();
    resetPageAndFetch();
  });
}

function syncFiltersFromInputs() {
  state.filters.experience = elements.experience?.value || "";
  state.filters.availability = elements.availability?.value || "";
  state.filters.location = elements.stateInput?.value?.trim() || "";
  state.filters.sort = normalizeSortValue(elements.sortBy?.value);
}


function bindModalEvents() {
  elements.cancelInquire?.addEventListener("click", closeInquireModal);
  elements.inquireModal?.addEventListener("click", (event) => {
    if (event.target === elements.inquireModal) {
      closeInquireModal();
    }
  });
  elements.confirmInquire?.addEventListener("click", sendInquiry);
  elements.jobList?.addEventListener("change", (event) => {
    if (event.target.matches("input[name='jobOption']")) {
      clearFieldError(elements.jobList);
    }
  });
  elements.inquireMessage?.addEventListener("input", () => clearFieldError(elements.inquireMessage));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeInquireModal();
  });
  elements.authBlocker?.addEventListener("click", (event) => {
    if (event.target === elements.authBlocker) {
      closeAuthBlocker();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAuthBlocker();
  });
}

function initStateDropdown() {
  if (!elements.stateInput || !elements.stateList) return;
  const stateWrapper = elements.stateInput.closest(".dropdown-wrapper");
  const specialtyWrapper = elements.specialtyInput?.closest(".dropdown-wrapper") || null;
  const render = (query = "") => {
    const matches = states.filter((s) => s.toLowerCase().startsWith(query.toLowerCase()));
    elements.stateList.innerHTML = matches.map((s) => `<li>${s}</li>`).join("");
    elements.stateList.classList.toggle("show", matches.length > 0);
  };
  elements.stateInput.addEventListener("input", () => render(elements.stateInput.value));
  elements.stateInput.addEventListener("focus", () => {
    elements.specialtyList?.classList.remove("show");
    render(elements.stateInput.value);
  });
  elements.stateList.addEventListener("click", (event) => {
    if (event.target.tagName === "LI") {
      elements.stateInput.value = event.target.textContent;
      elements.stateList.classList.remove("show");
      state.filters.location = event.target.textContent;
    }
  });
  document.addEventListener("click", (event) => {
    if (!stateWrapper?.contains(event.target)) {
      elements.stateList.classList.remove("show");
    }
    if (!specialtyWrapper?.contains(event.target)) {
      elements.specialtyList?.classList.remove("show");
    }
  });
}

function initSpecialtyDropdown() {
  if (!elements.specialtyInput || !elements.specialtyList) return;
  const closeList = () => elements.specialtyList.classList.remove("show");
  const openList = () => {
    renderList();
    elements.stateList?.classList.remove("show");
    elements.specialtyList.classList.add("show");
  };
  const toggleList = () => {
    if (elements.specialtyList.classList.contains("show")) {
      closeList();
    } else {
      openList();
    }
  };
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
  elements.specialtyInput.addEventListener("click", (event) => {
    event.preventDefault();
    toggleList();
  });
  elements.specialtyInput.addEventListener("focus", openList);
  elements.specialtyInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeList();
      elements.specialtyInput.blur();
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openList();
    }
  });
  elements.specialtyList.addEventListener("click", (event) => {
    const row = event.target.closest("li");
    if (!row) return;
    const checkbox = row.querySelector("input[type='checkbox']");
    if (!checkbox) return;
    if (event.target === checkbox || event.target.tagName === "LABEL") return;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
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
  params.set("sort", normalizeSortValue(state.filters.sort));

  const minYears = parseExperience(state.filters.experience);
  if (minYears) params.set("minYears", String(minYears));
  if (state.filters.availability) params.set("availability", state.filters.availability);
  if (state.filters.location) params.set("location", state.filters.location);
  if (selectedSpecialties.size) {
    params.set("practice", [...selectedSpecialties].join("|"));
  }

  try {
    const res = await fetch(`/public/paralegals?${params.toString()}`, {
      headers: { Accept: "application/json" },
      credentials: state.isLoggedIn ? "include" : "omit",
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || "Unable to load paralegals");
    }
    renderParalegals(Array.isArray(data.items) ? data.items : []);
    updatePagination({ total: data.total, pages: data.pages, page: data.page });
  } catch (error) {
    console.error(error);
    renderParalegals([]);
    setResultsStatus(error.message || "Unable to load paralegals right now.", true);
  }
}

async function loadCases() {
  try {
    const res = await secureFetch("/api/cases/my-active", {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
      ? payload
      : [];
    availableCases = items.filter((item) => {
      const archived = Boolean(item.archived);
      const assigned = Boolean(
        item.acceptedParalegal ||
          item.assignedTo?.id ||
          item.assignedTo?._id ||
          item.paralegal?.id ||
          item.paralegal?._id ||
          item.paralegal ||
          item.paralegalId
      );
      return !archived && !assigned;
    });
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
  const paralegalId = String(paralegal._id || paralegal.id || paralegal.paralegalId || "");
  const name = formatName(paralegal);
  const summary = (paralegal.bio || paralegal.about || "This professional hasn’t added a summary yet.").trim();
  const location = paralegal.location || "Location not specified";
  const availability = paralegal.availability || "Availability on request";
  const specialties = (paralegal.practiceAreas || []).slice(0, 2);
  const experience = formatExperience(paralegal.yearsExperience);
  const avatar = paralegal.avatarURL || buildInitialAvatar(getInitials(name));

  const card = document.createElement("article");
  card.className = "paralegal-card";
  if (paralegalId) {
    card.dataset.paralegalId = paralegalId;
  }

  const photoLink = document.createElement("a");
  photoLink.className = "profile-photo-link profile-link";
  photoLink.href = buildParalegalProfileUrl(paralegalId);
  photoLink.addEventListener("click", (event) => {
    requireSignIn(event);
  });
  const img = document.createElement("img");
  img.src = avatar;
  img.alt = `Portrait of ${name}`;
  photoLink.appendChild(img);
  card.appendChild(photoLink);
  const heading = document.createElement("h3");
  const headingLink = document.createElement("a");
  headingLink.href = buildParalegalProfileUrl(paralegalId);
  headingLink.textContent = name;
  headingLink.className = "profile-name-link profile-link";
  headingLink.addEventListener("click", (event) => {
    requireSignIn(event);
  });
  heading.appendChild(headingLink);
  const content = document.createElement("div");
  content.className = "card-content";
  content.appendChild(heading);

  const intro = document.createElement("p");
  intro.textContent = `${specialties[0] || "Generalist"} · ${location}`;
  content.appendChild(intro);

  const bio = document.createElement("p");
  bio.textContent = getFirstSentence(summary);
  content.appendChild(bio);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.appendChild(buildMetaChip("Experience", experience));
  meta.appendChild(buildMetaChip("Availability", availability, { hideLabel: true }));
  content.appendChild(meta);
  card.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (state.canInvite) {
    const inquireBtn = document.createElement("button");
    inquireBtn.type = "button";
    inquireBtn.className = "action-btn invite-btn";
    inquireBtn.textContent = "Invite to Case";
    inquireBtn.addEventListener("click", () => openInquireModal({ id: paralegalId, name }));
    actions.appendChild(inquireBtn);
  }
  if (actions.children.length) {
    card.appendChild(actions);
  }

  card.addEventListener("click", (event) => {
    const isAction = event.target.closest(".action-btn");
    const isProfileLink = event.target.closest(".profile-link");
    if (isAction || isProfileLink || !paralegalId) return;
    if (requireSignIn(event)) return;
    window.location.href = buildParalegalProfileUrl(paralegalId);
  });

  return card;
}

function getFirstSentence(summary) {
  const clean = String(summary || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const firstSentenceMatch = clean.match(/^(.+?[.!?])(\s|$)/);
  return firstSentenceMatch ? firstSentenceMatch[1] : clean;
}

function buildMetaChip(label, value, options = {}) {
  const span = document.createElement("span");
  const hideLabel = Boolean(options.hideLabel);
  span.textContent = hideLabel ? value : `${label}: ${value}`;
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
  clearFieldError(elements.jobList);
  clearFieldError(elements.inquireMessage);
  elements.selectedParalegalText.textContent = `Select an open case for ${paralegal.name}.`;
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
  clearFieldError(elements.jobList);
  clearFieldError(elements.inquireMessage);
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
  const targetId = String(
    normalizeId(activeParalegal) ||
      normalizeId(activeParalegal?.paralegal) ||
      normalizeId(activeParalegal?.user) ||
      normalizeId(activeParalegal?.person)
  );
  const options = availableCases.map((c) => {
    const caseId = c.id || c._id;
    const inviteEntries = Array.isArray(c.invites) ? c.invites : [];
    const matchingInvite = inviteEntries.find(
      (invite) => normalizeId(invite?.paralegalId) && String(normalizeId(invite.paralegalId)) === targetId
    );
    const inviteStatus = String(matchingInvite?.status || "").toLowerCase();
    const assignedId =
      normalizeId(c.assignedTo?.id) ||
      normalizeId(c.assignedTo?._id) ||
      normalizeId(c.paralegalId) ||
      normalizeId(c.paralegal?.id) ||
      normalizeId(c.paralegal?._id) ||
      normalizeId(c.paralegal);
    const assigned = Boolean(assignedId || c.acceptedParalegal);
    const invited = targetId && (inviteStatus === "pending" || inviteStatus === "accepted");
    const disabled = invited || assigned;
    const statusLabel = invited
      ? "Invitation already sent to this paralegal"
      : assigned
      ? "A paralegal is already assigned"
      : "";
    return { caseId, title: c.title || "Untitled matter", disabled, statusLabel };
  });
  const visibleOptions = options.filter((opt) => opt.statusLabel !== "A paralegal is already assigned");
  const hasSelectable = visibleOptions.some((opt) => !opt.disabled);
  if (!visibleOptions.length) {
    elements.jobList.innerHTML = "<p>No open cases available. Post a job to invite paralegals.</p>";
    elements.confirmInquire.disabled = true;
    return;
  }
  elements.jobList.innerHTML = visibleOptions
    .map(
      (opt) => `
      <label class="job-option${opt.disabled ? " disabled" : ""}">
        <input type="radio" name="jobOption" value="${opt.caseId}" ${opt.disabled ? "disabled" : ""} aria-disabled="${opt.disabled ? "true" : "false"}">
        <span>${escapeHtml(opt.title)}${opt.statusLabel ? ` — ${escapeHtml(opt.statusLabel)}` : ""}</span>
      </label>`
    )
    .join("");
  elements.confirmInquire.disabled = !hasSelectable;
}

async function sendInquiry() {
  if (!activeParalegal || !elements.jobList) return;
  const selected = elements.jobList.querySelector("input[name='jobOption']:checked");
  clearFieldError(elements.jobList);
  if (!selected) {
    showFieldError(elements.jobList, "Select an open case before sending.");
    showToast("Select an open case first.", "err");
    return;
  }
  const message = (elements.inquireMessage.value || "").trim();
  const targetId = normalizeId(activeParalegal) || normalizeId(activeParalegal?.paralegal) || normalizeId(activeParalegal?.user) || normalizeId(activeParalegal?.person);
  const caseMeta = availableCases.find((c) => String(c.id || c._id) === String(selected.value));
  if (caseMeta && targetId) {
    const inviteEntries = Array.isArray(caseMeta.invites) ? caseMeta.invites : [];
    const matchingInvite = inviteEntries.find(
      (invite) => normalizeId(invite?.paralegalId) && String(normalizeId(invite.paralegalId)) === targetId
    );
    const inviteStatus = String(matchingInvite?.status || "").toLowerCase();
    const assignedId =
      normalizeId(caseMeta.assignedTo?.id) ||
      normalizeId(caseMeta.assignedTo?._id) ||
      normalizeId(caseMeta.paralegalId) ||
      normalizeId(caseMeta.paralegal?.id) ||
      normalizeId(caseMeta.paralegal?._id) ||
      normalizeId(caseMeta.paralegal);
    if (inviteStatus === "pending" || inviteStatus === "accepted") {
      showToast("Invitation already sent to this paralegal for this case.", "err");
      return;
    }
    if (assignedId || caseMeta.acceptedParalegal) {
      showToast("A paralegal is already assigned to this case.", "err");
      return;
    }
  }
  try {
    const res = await secureFetch(
      `/api/cases/${encodeURIComponent(selected.value)}/invite/${encodeURIComponent(activeParalegal.id)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId: selected.value, message }),
      }
    );
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

function parseExperience(value = "") {
  const match = value.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function normalizeSortValue(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "experience" || normalized === "alpha") return normalized;
  return "recent";
}

function handleContactClick(paralegalId) {
  if (!paralegalId) return;
  if (!state.isLoggedIn) {
    window.location.href = "login.html";
    return;
  }
  window.location.href = buildParalegalProfileUrl(paralegalId);
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

function buildParalegalProfileUrl(paralegalId = "") {
  const safeId = String(paralegalId || "").trim();
  if (!safeId) return "profile-paralegal.html";
  return `profile-paralegal.html?paralegalId=${encodeURIComponent(safeId)}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showFieldError(target, message) {
  if (!target) return;
  clearFieldError(target);
  target.classList?.add("input-error");
  if (typeof target.setAttribute === "function") {
    target.setAttribute("aria-invalid", "true");
  }
  const error = document.createElement("div");
  error.className = "field-error";
  error.textContent = message;
  const wrapper = target.closest(".field") || target.closest("[data-field-wrapper]");
  if (wrapper) wrapper.appendChild(error);
  else target.insertAdjacentElement("afterend", error);
}

function clearFieldError(target) {
  if (!target) return;
  target.classList?.remove("input-error");
  if (typeof target.removeAttribute === "function") {
    target.removeAttribute("aria-invalid");
  }
  const wrapper = target.closest(".field") || target.closest("[data-field-wrapper]");
  if (wrapper) {
    const existing = wrapper.querySelector(".field-error");
    if (existing) existing.remove();
    return;
  }
  const next = target.nextElementSibling;
  if (next?.classList.contains("field-error")) next.remove();
}

function showToast(message, type = "info") {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}
