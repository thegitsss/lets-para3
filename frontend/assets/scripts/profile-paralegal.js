import { secureFetch, requireAuth, logout } from "./auth.js";

const MESSAGE_JUMP_KEY = "lpc_message_jump";
const elements = {
  error: document.getElementById("profileError"),
  inviteBtn: document.getElementById("inviteBtn"),
  messageBtn: document.getElementById("messageBtn"),
  editBtn: document.getElementById("editProfileBtn"),
  avatarWrapper: document.querySelector("[data-avatar-wrapper]"),
  avatarImg: document.querySelector("[data-profile-avatar]"),
  avatarFallback: document.querySelector("[data-avatar-fallback]"),
  statusChip: document.getElementById("statusChip"),
  locationMeta: document.getElementById("locationMeta"),
  credentialMeta: document.getElementById("credentialMeta"),
  joinedMeta: document.getElementById("joinedMeta"),
  nameField: document.getElementById("profileName"),
  roleLine: document.getElementById("roleLine"),
  bioCopy: document.getElementById("bioCopy"),
  skillsList: document.getElementById("skillsList"),
  practiceList: document.getElementById("practiceList"),
  experienceList: document.getElementById("experienceList"),
  educationList: document.getElementById("educationList"),
  funFactsCard: document.getElementById("funFactsCard"),
  funFactsCopy: document.getElementById("funFactsCopy"),
  inviteModal: document.getElementById("inviteModal"),
  jobOptions: document.getElementById("jobOptions"),
  inviteSubtitle: document.getElementById("inviteSubtitle"),
  inviteMessage: document.getElementById("inviteMessage"),
  cancelInvite: document.getElementById("cancelInvite"),
  confirmInvite: document.getElementById("confirmInvite"),
  notificationToggle: document.getElementById("notificationToggle"),
  notificationPanel: document.getElementById("notificationPanel"),
  userChip: document.getElementById("userChip"),
  profileDropdown: document.getElementById("profileDropdown"),
  chipAvatar: document.getElementById("chipAvatar"),
  chipName: document.getElementById("chipName"),
  chipRole: document.getElementById("chipRole"),
};

const state = {
  viewer: null,
  viewerRole: "",
  viewerId: "",
  paralegalId: "",
  profile: null,
  caseContextId: null,
  openCases: [],
  inviteTarget: null,
};

const toast = window.toastUtils;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  let session;
  try {
    session = requireAuth();
  } catch (err) {
    console.warn("Auth required", err);
    return;
  }

  const storedUser = window.getStoredUser ? window.getStoredUser() : null;
  state.viewer = storedUser || session.user || null;
  state.viewerRole = String(state.viewer?.role || session.role || "").toLowerCase();
  state.viewerId = String(state.viewer?.id || state.viewer?._id || "");

  hydrateHeader();
  bindHeaderEvents();
  bindCtaEvents();

  const params = new URLSearchParams(window.location.search);
  state.caseContextId = params.get("caseId") || null;
  const explicitId = params.get("id");

  if (explicitId && explicitId.trim()) {
    state.paralegalId = explicitId.trim();
  } else if (state.viewerRole === "paralegal") {
    state.paralegalId = state.viewerId;
  }

  if (!state.paralegalId) {
    showError("Paralegal profile not found. Please use a valid profile link.");
    toggleSkeleton(false);
    disableCtas();
    return;
  }

  toggleSkeleton(true);
  await loadProfile();
  toggleSkeleton(false);

  if (state.viewerRole === "attorney") {
    await loadAttorneyCases();
    updateInviteButtonState();
  }
}

function bindCtaEvents() {
  elements.inviteBtn?.addEventListener("click", () => {
    openInviteModal();
  });
  elements.messageBtn?.addEventListener("click", () => {
    if (!state.profile) return;
    if (state.caseContextId) {
      try {
        sessionStorage.setItem(MESSAGE_JUMP_KEY, JSON.stringify({ caseId: state.caseContextId }));
      } catch {}
    }
    window.location.href = "messages.html";
  });
  elements.editBtn?.addEventListener("click", () => {
    window.location.href = "profile-settings.html";
  });
  elements.cancelInvite?.addEventListener("click", closeInviteModal);
  elements.inviteModal?.addEventListener("click", (event) => {
    if (event.target === elements.inviteModal) closeInviteModal();
  });
  elements.confirmInvite?.addEventListener("click", sendInviteToCase);
}

function hydrateHeader() {
  if (!state.viewer) return;
  if (elements.chipName) elements.chipName.textContent = formatName(state.viewer);
  if (elements.chipRole) elements.chipRole.textContent = prettyRole(state.viewer.role);
  const avatarSrc = state.viewer.avatarURL || state.viewer.profileImage || buildInitialAvatar(getInitials(formatName(state.viewer)));
  if (elements.chipAvatar && avatarSrc) {
    elements.chipAvatar.src = avatarSrc;
    elements.chipAvatar.alt = `${formatName(state.viewer)} avatar`;
  }
}

function bindHeaderEvents() {
  if (elements.notificationToggle && elements.notificationPanel) {
    elements.notificationToggle.addEventListener("click", () => {
      elements.notificationPanel.classList.toggle("show");
    });
    document.addEventListener("click", (event) => {
      if (
        event.target !== elements.notificationToggle &&
        !elements.notificationPanel.contains(event.target) &&
        !elements.notificationToggle.contains(event.target)
      ) {
        elements.notificationPanel.classList.remove("show");
      }
    });
  }

  if (elements.userChip && elements.profileDropdown) {
    elements.userChip.addEventListener("click", () => {
      elements.profileDropdown.classList.toggle("show");
    });
    document.addEventListener("click", (event) => {
      if (!elements.userChip.contains(event.target) && !elements.profileDropdown.contains(event.target)) {
        elements.profileDropdown.classList.remove("show");
      }
    });
    elements.profileDropdown.querySelector("[data-settings]")?.addEventListener("click", () => {
      window.location.href = state.viewerRole === "paralegal" ? "profile-settings.html" : "account-settings.html";
    });
    elements.profileDropdown.querySelector("[data-logout]")?.addEventListener("click", () => logout("login.html"));
  }
}

async function loadProfile() {
  try {
    const res = await secureFetch(`/api/users/${encodeURIComponent(state.paralegalId)}`, {
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Unable to load profile");
    state.profile = { ...data, id: data.id || data._id || state.paralegalId };
    renderProfile(data);
    updateButtonVisibility();
    elements.error?.classList.add("hidden");
    elements.error.textContent = "";
  } catch (err) {
    console.error(err);
    showError(err.message || "Unable to load this paralegal right now.");
    disableCtas();
  }
}

function renderProfile(profile) {
  const fullName = formatName(profile);
  setFieldText(elements.nameField, fullName);

  const experienceLabel = describeExperience(profile.yearsExperience);
  const roleCopy = `${experienceLabel ? `${experienceLabel} • ` : ""}Freelance Paralegal`;
  setFieldText(elements.roleLine, roleCopy);

  const summary = profile.bio || profile.about || "This professional hasn’t added a summary yet.";
  setFieldText(elements.bioCopy, summary);

  renderAvatar(fullName, profile.avatarURL);
  renderStatus(profile);
  renderMetadata(profile);
  renderPills(elements.skillsList, profile.skills, "This paralegal hasn’t shared skills yet.");
  renderPills(elements.practiceList, profile.practiceAreas, "No practice areas listed yet.");
  renderExperience(profile.experience);
  renderEducation(profile.education);
  renderFunFacts(profile.about, profile.writingSamples);
}

function renderAvatar(name, avatarUrl) {
  const fallback = buildInitialAvatar(getInitials(name));
  if (elements.avatarImg) {
    const source = avatarUrl || fallback;
    elements.avatarImg.src = source;
    elements.avatarImg.alt = `${name} portrait`;
    elements.avatarImg.loading = "lazy";
    elements.avatarImg.style.display = "block";
  }
  if (elements.avatarFallback) {
    elements.avatarFallback.textContent = getInitials(name);
    elements.avatarFallback.style.display = avatarUrl ? "none" : "flex";
  }
  elements.avatarWrapper?.classList.remove("skeleton-block");
}

function renderStatus(profile) {
  if (!elements.statusChip) return;
  const message = profile.availability || "Availability on request";
  elements.statusChip.textContent = message;
}

function renderMetadata(profile) {
  const stateOnly = extractState(profile.location);
  if (stateOnly) {
    const href = `https://www.google.com/maps/search/${encodeURIComponent(stateOnly + " state")}`;
    renderMetaLine(elements.locationMeta, "M", stateOnly, href);
  } else {
    clearMetaLine(elements.locationMeta);
  }

  if (profile.certificateURL) {
    renderMetaLine(elements.credentialMeta, "C", "Credentials on file", profile.certificateURL);
  } else if (profile.barNumber) {
    renderMetaLine(elements.credentialMeta, "C", `Bar #${profile.barNumber}`);
  } else {
    renderMetaLine(elements.credentialMeta, "C", "Credentials available upon request");
  }

  const joined = profile.createdAt ? new Date(profile.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "Date unavailable";
  renderMetaLine(elements.joinedMeta, "J", `Joined ${joined}`);
}

function renderMetaLine(el, iconLetter, text, href) {
  if (!el) return;
  el.classList.remove("skeleton-block");
  el.classList.remove("hidden");
  if (href) {
    el.innerHTML = `<span aria-hidden="true" style="font-weight:600;">${escapeHtml(iconLetter)}</span><a href="${escapeHtml(
      href
    )}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
  } else {
    el.innerHTML = `<span aria-hidden="true" style="font-weight:600;">${escapeHtml(iconLetter)}</span>${escapeHtml(text)}`;
  }
}

function clearMetaLine(el) {
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
  el.classList.remove("skeleton-block");
}

function extractState(rawLocation = "") {
  if (!rawLocation) return "";
  const parts = String(rawLocation)
    .split(/[,|-]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  return parts[parts.length - 1];
}

function renderPills(container, values, emptyCopy) {
  if (!container) return;
  container.innerHTML = "";
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) {
    const empty = document.createElement("p");
    empty.textContent = emptyCopy;
    empty.style.color = "var(--muted)";
    empty.style.fontSize = "0.95rem";
    container.appendChild(empty);
    return;
  }
  list.slice(0, 20).forEach((value) => {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = value;
    container.appendChild(pill);
  });
}

function renderExperience(entries) {
  if (!elements.experienceList) return;
  elements.experienceList.innerHTML = "";
  const list = Array.isArray(entries) ? entries.filter((item) => item && (item.title || item.description)) : [];
  if (!list.length) {
    elements.experienceList.innerHTML = `<p class="muted">No experience timeline yet.</p>`;
    return;
  }
  list.forEach((item) => {
    const block = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = item.title || "Role";
    block.appendChild(title);

    if (item.years) {
      const yearsEl = document.createElement("span");
      yearsEl.textContent = item.years;
      block.appendChild(yearsEl);
    }

    if (item.description) {
      const desc = document.createElement("p");
      desc.textContent = item.description;
      block.appendChild(desc);
    }
    elements.experienceList.appendChild(block);
  });
}

function renderEducation(entries) {
  if (!elements.educationList) return;
  elements.educationList.innerHTML = "";
  const list = Array.isArray(entries) ? entries.filter((item) => item && (item.degree || item.school)) : [];
  if (!list.length) {
    elements.educationList.innerHTML = `<p class="muted">Education history coming soon.</p>`;
    return;
  }
  list.forEach((item) => {
    const block = document.createElement("article");
    const degree = document.createElement("h3");
    degree.textContent = item.degree || "Degree";
    block.appendChild(degree);

    if (item.school) {
      const school = document.createElement("span");
      school.textContent = item.school;
      block.appendChild(school);
    }
    elements.educationList.appendChild(block);
  });
}

function renderFunFacts(about, writingSamples = []) {
  if (!elements.funFactsCard || !elements.funFactsCopy) return;
  const facts = [];
  if (about && about.trim().length) {
    facts.push(...about.split(/\n+/).map((line) => line.trim()).filter(Boolean));
  }
  if (!facts.length && Array.isArray(writingSamples)) {
    writingSamples.forEach((sample) => {
      if (sample?.title) facts.push(sample.title);
    });
  }
  if (!facts.length) {
    elements.funFactsCard.classList.add("hidden");
    return;
  }
  elements.funFactsCopy.innerHTML = `<ul>${facts.slice(0, 5).map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>`;
  elements.funFactsCard.classList.remove("hidden");
}

function updateButtonVisibility() {
  const isOwner = state.viewerRole === "paralegal" && state.viewerId && state.viewerId === state.paralegalId;
  const isAttorney = state.viewerRole === "attorney";

  toggleElement(elements.editBtn, isOwner);
  toggleElement(elements.messageBtn, isAttorney);
  updateInviteButtonState();
  if (!isAttorney) closeInviteModal();
}

function disableCtas() {
  if (elements.inviteBtn) elements.inviteBtn.disabled = true;
  if (elements.messageBtn) elements.messageBtn.disabled = true;
  if (elements.editBtn) elements.editBtn.disabled = true;
}

function toggleElement(el, shouldShow) {
  if (!el) return;
  el.classList.toggle("hidden", !shouldShow);
}

function updateInviteButtonState() {
  if (!elements.inviteBtn) return;
  const shouldShow = state.viewerRole === "attorney" && state.openCases.length > 0;
  toggleElement(elements.inviteBtn, shouldShow);
  elements.inviteBtn.disabled = !shouldShow;
}

function toggleSkeleton(enable) {
  const targets = [
    elements.avatarWrapper,
    elements.nameField,
    elements.roleLine,
    elements.bioCopy,
    elements.locationMeta,
    elements.credentialMeta,
    elements.joinedMeta,
  ].filter(Boolean);
  targets.forEach((node) => node.classList.toggle("skeleton-block", enable));
}

function showError(message) {
  if (!elements.error) return;
  elements.error.textContent = message;
  elements.error.classList.remove("hidden");
}

async function loadAttorneyCases() {
  try {
    const res = await secureFetch("/api/cases/my?limit=50&archived=false", {
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => []);
    state.openCases = Array.isArray(data)
      ? data.filter((c) => !["completed", "closed", "archived"].includes(String(c.status || "").toLowerCase()))
      : [];
  } catch (err) {
    console.warn("Unable to load open cases", err);
    state.openCases = [];
  }
  renderCaseOptions();
  updateInviteButtonState();
}

function renderCaseOptions() {
  if (!elements.jobOptions) return;
  if (!state.openCases.length) {
    elements.jobOptions.innerHTML = "<p>No active cases are available. Post or open a job first.</p>";
    elements.confirmInvite.disabled = true;
    return;
  }
  elements.jobOptions.innerHTML = state.openCases
    .map(
      (c) => `
      <label class="job-option">
        <input type="radio" name="inviteCase" value="${escapeHtml(c.id || c._id)}">
        <span>${escapeHtml(c.title || "Untitled matter")}</span>
      </label>`
    )
    .join("");
  elements.confirmInvite.disabled = false;
}

function openInviteModal() {
  if (!elements.inviteModal || !state.profile) return;
  elements.inviteSubtitle.textContent = `Send an invite to ${formatName(state.profile)}.`;
  elements.inviteMessage.value = "";
  const checked = elements.jobOptions?.querySelector("input[name='inviteCase']:checked");
  if (checked) checked.checked = false;
  renderCaseOptions();
  elements.inviteModal.classList.add("show");
}

function closeInviteModal() {
  elements.inviteModal?.classList.remove("show");
}

async function sendInviteToCase() {
  if (!state.profile || !elements.jobOptions) return;
  const selected = elements.jobOptions.querySelector("input[name='inviteCase']:checked");
  if (!selected) {
    showToast("Select a case to continue.", "info");
    return;
  }
  const payload = {
    caseId: selected.value,
    message: (elements.inviteMessage.value || "").trim(),
  };
  elements.confirmInvite.disabled = true;
  try {
    const res = await secureFetch(`/api/users/${encodeURIComponent(state.profile.id || state.paralegalId)}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Unable to send invite");
    showToast("Invite sent successfully.", "success");
    closeInviteModal();
  } catch (err) {
    console.error(err);
    showToast(err.message || "Unable to send invite.", "error");
  } finally {
    elements.confirmInvite.disabled = false;
  }
}

function updateInviteButtonState() {
  if (!elements.inviteBtn) return;
  elements.inviteBtn.disabled = state.openCases.length === 0;
}

function setFieldText(el, value) {
  if (!el) return;
  el.classList.remove("skeleton-block");
  el.textContent = value || "";
}

function formatName(person = {}) {
  const first = person.firstName || person.first_name || "";
  const last = person.lastName || person.last_name || "";
  return `${first} ${last}`.trim() || "Paralegal";
}

function prettyRole(role = "") {
  const normalized = String(role).toLowerCase();
  if (normalized === "attorney") return "Attorney";
  if (normalized === "paralegal") return "Paralegal";
  if (normalized === "admin") return "Admin";
  return "Member";
}

function describeExperience(years) {
  const num = Number(years);
  if (!Number.isFinite(num)) return "";
  if (num <= 0) return "Under 1 year experience";
  if (num >= 10) return "10+ years experience";
  if (num === 1) return "1 year experience";
  return `${Math.round(num)} years experience`;
}

function getInitials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || "L").toUpperCase() + (parts[1]?.[0] || "P").toUpperCase();
}

function buildInitialAvatar(initials) {
  const safe = (initials || "LP").slice(0, 2).toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>
    <defs>
      <linearGradient id='grad' x1='0%' y1='0%' x2='100%' y2='100%'>
        <stop offset='0%' stop-color='#f4f0e6'/>
        <stop offset='100%' stop-color='#e1dacb'/>
      </linearGradient>
    </defs>
    <rect width='200' height='200' rx='30' ry='30' fill='url(#grad)'/>
    <text x='50%' y='55%' font-size='72' text-anchor='middle' fill='#4a4030' font-family='Sarabun, Arial' font-weight='600'>${safe}</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeHtml(value = "") {
  return String(value)
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
