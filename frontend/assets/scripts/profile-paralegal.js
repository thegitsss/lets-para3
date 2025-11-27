import { secureFetch, requireAuth, logout } from "./auth.js";

const MESSAGE_JUMP_KEY = "lpc_message_jump";
const elements = {
  error: document.getElementById("profileError"),
  inviteBtn: document.getElementById("inviteToCaseBtn"),
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
  attorneyCard: document.getElementById("attorneyInsightsCard"),
  attorneyHighlights: document.getElementById("attorneyHighlights"),
  inviteModal: document.getElementById("inviteModal"),
  inviteCaseSelect: document.getElementById("inviteCaseSelect"),
  sendInviteBtn: document.getElementById("sendInviteBtn"),
  closeInviteBtn: document.getElementById("closeInviteBtn"),
  notificationToggle: document.getElementById("notificationToggle"),
  notificationPanel: document.getElementById("notificationPanel"),
  userChip: document.getElementById("userChip"),
  profileDropdown: document.getElementById("profileDropdown"),
  chipAvatar: document.getElementById("chipAvatar"),
  chipName: document.getElementById("chipName"),
  chipRole: document.getElementById("chipRole"),
  profileFormSection: document.getElementById("profileFormSection"),
  profileForm: document.getElementById("paralegalProfileForm"),
  linkedInInput: document.getElementById("linkedInURL"),
  yearsExperienceInput: document.getElementById("yearsExperience"),
  ref1NameInput: document.getElementById("ref1Name"),
  ref1EmailInput: document.getElementById("ref1Email"),
  ref2NameInput: document.getElementById("ref2Name"),
  ref2EmailInput: document.getElementById("ref2Email"),
  certificateUploadInput: document.getElementById("certificateUpload"),
  resumeUploadInput: document.getElementById("resumeUpload"),
  profilePhotoInput: document.getElementById("profilePhoto"),
  profileSaveBtn: document.getElementById("saveProfileBtn"),
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

document.addEventListener("DOMContentLoaded", init);

async function init() {
  let sessionUser;
  try {
    if (typeof window.requireRole === "function") {
      sessionUser = await window.requireRole();
    } else if (typeof window.checkSession === "function") {
      const session = await window.checkSession();
      sessionUser = session?.user || session;
    } else {
      sessionUser = requireAuth();
    }
  } catch (err) {
    console.warn("Auth required", err);
    return;
  }
  if (!sessionUser) return;

  applyRoleVisibility(sessionUser);

  const storedUser = window.getStoredUser ? window.getStoredUser() : null;
  state.viewer = storedUser || sessionUser || null;
  state.viewerRole = String(state.viewer?.role || "").toLowerCase();
  state.viewerId = String(state.viewer?.id || state.viewer?._id || "");

  hydrateHeader();
  bindHeaderEvents();
  bindCtaEvents();
  bindProfileForm();

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
  elements.closeInviteBtn?.addEventListener("click", closeInviteModal);
  elements.inviteModal?.addEventListener("click", (event) => {
    if (event.target === elements.inviteModal) closeInviteModal();
  });
  elements.sendInviteBtn?.addEventListener("click", sendInviteToCase);
}

function bindProfileForm() {
  if (!elements.profileForm) return;
  elements.profileForm.addEventListener("submit", handleProfileFormSubmit);
  elements.certificateUploadInput?.addEventListener("change", handleCertificateUpload);
  elements.resumeUploadInput?.addEventListener("change", handleResumeUpload);
  elements.profilePhotoInput?.addEventListener("change", handleProfilePhotoChange);
  updateProfileFormVisibility();
}

function handleProfileFormSubmit(event) {
  event.preventDefault();
  if (!canEditProfile() || !state.profile) {
    showToast("Only the profile owner can update these details.", "error");
    return;
  }
  const payload = buildProfileUpdatePayload();
  const submitBtn = elements.profileSaveBtn || elements.profileForm.querySelector('[type="submit"]');
  const previousLabel = submitBtn?.textContent || "Save Profile";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
  }
  saveProfileDetails(payload)
    .then(() => {
      showToast("Profile updated.", "success");
    })
    .catch((err) => {
      console.error(err);
      showToast(err.message || "Unable to save profile.", "error");
    })
    .finally(() => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = previousLabel;
      }
    });
}

async function saveProfileDetails(payload) {
  const url = `/api/paralegals/${encodeURIComponent(state.paralegalId || "me")}/update`;
  const res = await secureFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Unable to update profile");
  }
  const snapshot = state.profile || { id: state.paralegalId };
  state.profile = { ...snapshot, ...payload };
  populateProfileForm(state.profile);
  renderProfile(state.profile);
  renderMetadata(state.profile);
  return data;
}

function buildProfileUpdatePayload() {
  return {
    linkedInURL: sanitizeUrl(elements.linkedInInput?.value),
    yearsExperience: sanitizeYears(elements.yearsExperienceInput?.value),
    ref1Name: sanitizeText(elements.ref1NameInput?.value),
    ref1Email: sanitizeText(elements.ref1EmailInput?.value),
    ref2Name: sanitizeText(elements.ref2NameInput?.value),
    ref2Email: sanitizeText(elements.ref2EmailInput?.value),
  };
}

function sanitizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizeUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizeYears(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = parseInt(value, 10);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(80, num));
}

function handleCertificateUpload(event) {
  const file = event.target?.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!canEditProfile()) {
    showToast("Only the profile owner can upload documents.", "error");
    return;
  }
  if (file.type !== "application/pdf") {
    showToast("Please upload a PDF certificate.", "error");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("Certificate must be 10 MB or smaller.", "error");
    return;
  }
  uploadCertificate(file);
}

async function uploadCertificate(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file, file.name || "certificate.pdf");
  try {
    const res = await secureFetch("/api/uploads/paralegal-certificate", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Unable to upload certificate");
    }
    const url = data?.url || data?.certificateURL || data?.location || data?.fileURL || null;
    if (url) {
      const snapshot = state.profile || { id: state.paralegalId };
      state.profile = { ...snapshot, certificateURL: url };
      renderMetadata(state.profile);
      renderAttorneyHighlights(state.profile);
    }
    showToast("Certificate uploaded.", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Certificate upload failed.", "error");
  }
}

function handleResumeUpload(event) {
  const file = event.target?.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!canEditProfile()) {
    showToast("Only the profile owner can upload documents.", "error");
    return;
  }
  if (file.type !== "application/pdf") {
    showToast("Please upload a PDF résumé.", "error");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("Résumé must be 10 MB or smaller.", "error");
    return;
  }
  uploadResume(file);
}

async function uploadResume(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file, file.name || "resume.pdf");
  try {
    const res = await secureFetch("/api/uploads/paralegal-resume", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Unable to upload résumé");
    }
    const url = data?.url || data?.resumeURL || data?.location || data?.fileURL || null;
    if (url) {
      const snapshot = state.profile || { id: state.paralegalId };
      state.profile = { ...snapshot, resumeURL: url };
      renderMetadata(state.profile);
      renderAttorneyHighlights(state.profile);
    }
    showToast("Résumé uploaded.", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Résumé upload failed.", "error");
  }
}

function handleProfilePhotoChange(event) {
  const file = event.target?.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!canEditProfile()) {
    showToast("Only the profile owner can upload photos.", "error");
    return;
  }
  if (!/image\/(png|jpe?g)/i.test(file.type || "")) {
    showToast("Upload a JPEG or PNG profile photo.", "error");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast("Profile photo must be 5 MB or smaller.", "error");
    return;
  }
  uploadProfilePhoto(file);
}

async function uploadProfilePhoto(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file, file.name || "profile.jpg");
  try {
    const res = await secureFetch("/api/uploads/profile-photo", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Unable to upload profile photo");
    }
    const url = data?.url || data?.profileImage || data?.location || null;
    if (url) {
      const snapshot = state.profile || { id: state.paralegalId };
      state.profile = { ...snapshot, profileImage: url };
      if (state.viewerRole === "paralegal" && state.viewerId === state.paralegalId) {
        state.viewer = { ...(state.viewer || {}), profileImage: url };
        hydrateHeader();
      }
      renderProfile(state.profile);
    }
    showToast("Profile photo updated.", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Unable to upload profile photo.", "error");
  }
}

function canEditProfile() {
  return state.viewerRole === "paralegal" && state.viewerId && state.viewerId === state.paralegalId;
}

function updateProfileFormVisibility() {
  const canEdit = canEditProfile();
  if (elements.profileFormSection) {
    elements.profileFormSection.classList.toggle("hidden", !canEdit);
  }
  const inputs = [
    elements.linkedInInput,
    elements.yearsExperienceInput,
    elements.ref1NameInput,
    elements.ref1EmailInput,
    elements.ref2NameInput,
    elements.ref2EmailInput,
    elements.certificateUploadInput,
    elements.resumeUploadInput,
    elements.profilePhotoInput,
  ].filter(Boolean);
  inputs.forEach((input) => {
    input.disabled = !canEdit;
  });
  if (elements.profileSaveBtn) {
    elements.profileSaveBtn.disabled = !canEdit;
  }
}
function hydrateHeader() {
  if (!state.viewer) return;
  if (elements.chipName) elements.chipName.textContent = formatName(state.viewer);
  if (elements.chipRole) elements.chipRole.textContent = prettyRole(state.viewer.role);
  const avatarSrc = state.viewer.profileImage || state.viewer.avatarURL || buildInitialAvatar(getInitials(formatName(state.viewer)));
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
    renderProfile(state.profile);
    populateProfileForm(state.profile);
    updateProfileFormVisibility();
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
  const roleCopy = `${experienceLabel ? `${experienceLabel} • ` : ""}elite paralegal professional`;
  setFieldText(elements.roleLine, roleCopy);

  const summary = profile.bio || profile.about || "This professional hasn’t added a summary yet.";
  setFieldText(elements.bioCopy, summary);

  renderAvatar(fullName, profile.profileImage || profile.avatarURL);
  renderStatus(profile);
  renderMetadata(profile);
  renderPills(elements.skillsList, profile.skills, "This paralegal hasn’t shared skills yet.");
  renderPills(elements.practiceList, profile.practiceAreas, "No practice areas listed yet.");
  renderExperience(profile.experience);
  renderEducation(profile.education);
  renderFunFacts(profile.about, profile.writingSamples);
  renderAttorneyHighlights(profile);
}

function populateProfileForm(profile) {
  if (!elements.profileForm || !profile) return;
  setInputValue(elements.linkedInInput, profile.linkedInURL);
  setInputValue(elements.yearsExperienceInput, profile.yearsExperience ?? "");
  setInputValue(elements.ref1NameInput, profile.ref1Name);
  setInputValue(elements.ref1EmailInput, profile.ref1Email);
  setInputValue(elements.ref2NameInput, profile.ref2Name);
  setInputValue(elements.ref2EmailInput, profile.ref2Email);
}

function setInputValue(input, value) {
  if (!input) return;
  if (value === undefined || value === null) {
    input.value = "";
  } else {
    input.value = String(value);
  }
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

function renderAttorneyHighlights(profile) {
  const card = elements.attorneyCard;
  const container = elements.attorneyHighlights;
  if (!card || !container) return;
  const canView = state.viewerRole === "attorney" || state.viewerRole === "admin";
  card.classList.toggle("hidden", !canView);
  if (!canView) return;

  const entries = [];
  if (profile.linkedInURL) {
    const safeUrl = escapeAttribute(profile.linkedInURL);
    entries.push({
      title: "LinkedIn",
      content: `<a href="${safeUrl}" target="_blank" rel="noopener">View LinkedIn profile</a>`,
    });
  }
  const experienceLabel = describeExperience(profile.yearsExperience);
  if (experienceLabel) {
    entries.push({
      title: "Experience",
      content: escapeHtml(experienceLabel),
    });
  }
  if (profile.certificateURL) {
    const certUrl = escapeAttribute(profile.certificateURL);
    entries.push({
      title: "Certificate",
      content: `<a href="${certUrl}" target="_blank" rel="noopener">View credential</a>`,
    });
  }
  if (profile.resumeURL) {
    const resumeHref = escapeAttribute(profile.resumeURL);
    entries.push({
      title: "Résumé",
      content: `<a href="${resumeHref}" target="_blank" rel="noopener">View Résumé</a>`,
    });
  }
  if (profile.resumeURL) {
    const resumeUrl = escapeAttribute(profile.resumeURL);
    entries.push({
      title: "Résumé",
      content: `<a href="${resumeUrl}" target="_blank" rel="noopener">View Résumé</a>`,
    });
  }

  container.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Credentials forthcoming.";
    container.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const block = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = entry.title;
    block.appendChild(title);
    const body = document.createElement("p");
    body.innerHTML = entry.content;
    block.appendChild(body);
    container.appendChild(block);
  });
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
  const hasOpenCases = state.viewerRole === "attorney" && state.openCases.length > 0;
  toggleElement(elements.inviteBtn, hasOpenCases);
  elements.inviteBtn.disabled = !hasOpenCases;
  if (elements.sendInviteBtn) {
    elements.sendInviteBtn.disabled = !hasOpenCases;
  }
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
    const res = await secureFetch("/api/cases/my-active", {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
      ? payload
      : [];
    state.openCases = items.filter((item) => {
      const archived = Boolean(item.archived);
      const assigned = Boolean(item.paralegal || item.paralegalId);
      const pending = Boolean(item.pendingParalegalId);
      return !archived && !assigned && !pending;
    });
  } catch (err) {
    console.warn("Unable to load open cases", err);
    state.openCases = [];
  }
  renderCaseOptions();
  updateInviteButtonState();
}

function renderCaseOptions() {
  const select = elements.inviteCaseSelect;
  if (!select) return;
  select.innerHTML = "";
  if (!state.openCases.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No active cases available";
    select.appendChild(option);
    select.disabled = true;
    if (elements.sendInviteBtn) elements.sendInviteBtn.disabled = true;
    return;
  }
  state.openCases.forEach((caseItem, index) => {
    const option = document.createElement("option");
    option.value = caseItem.id || caseItem._id;
    option.textContent = caseItem.title || caseItem.caseNumber || "Untitled case";
    if (index === 0) option.selected = true;
    select.appendChild(option);
  });
  select.disabled = false;
  if (elements.sendInviteBtn) elements.sendInviteBtn.disabled = false;
}

function openInviteModal() {
  if (!elements.inviteModal || !state.profile) return;
  if (!state.openCases.length) {
    showToast("You need an active case before inviting a paralegal.", "info");
    return;
  }
  renderCaseOptions();
  elements.inviteModal.classList.add("show");
}

function closeInviteModal() {
  elements.inviteModal?.classList.remove("show");
}

async function sendInviteToCase() {
  if (!state.profile || !elements.inviteCaseSelect) return;
  const caseId = elements.inviteCaseSelect.value;
  if (!caseId) {
    showToast("Select a case to continue.", "info");
    return;
  }
  const payload = {
    paralegalId: state.profile.id || state.paralegalId,
  };
  const button = elements.sendInviteBtn;
  const previousLabel = button?.textContent || "Send Invite";
  if (button) {
    button.disabled = true;
    button.textContent = "Sending…";
  }
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Unable to send invite");
    showToast("Invite sent.", "success");
    closeInviteModal();
    await loadAttorneyCases();
  } catch (err) {
    console.error(err);
    showToast(err.message || "Unable to send invite.", "error");
  } finally {
    if (button) {
      button.textContent = previousLabel;
      button.disabled = state.openCases.length === 0;
    }
  }
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

function escapeAttribute(value = "") {
  return String(value).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function showToast(message, type = "info") {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}
