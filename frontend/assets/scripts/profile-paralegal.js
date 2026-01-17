import { secureFetch, requireAuth, logout } from "./auth.js";

async function persistDocumentField(field, value) {
  const payload = { [field]: value };
  const res = await secureFetch("/api/users/me", {
    method: "PATCH",
    body: payload,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.msg || `Unable to save ${field}.`);
  }
  try {
    localStorage.setItem("lpc_user", JSON.stringify(data));
    window.updateSessionUser?.(data);
  } catch {
    /* ignore */
  }
  return data;
}

const PLACEHOLDER_AVATAR = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220' viewBox='0 0 220 220'>
    <rect width='220' height='220' rx='110' fill='#f1f5f9'/>
    <circle cx='110' cy='90' r='46' fill='#cbd5e1'/>
    <path d='M40 188c10-40 45-68 70-68s60 28 70 68' fill='none' stroke='#cbd5e1' stroke-width='18' stroke-linecap='round'/>
  </svg>`
)}`;

function getProfileImageUrl(user = {}) {
  return user.profileImage || user.avatarURL || PLACEHOLDER_AVATAR;
}
function applyGlobalAvatars(user = state.profileUser || {}) {
  const src = getProfileImageUrl(user);
  if (!src) return;
  const els = document.querySelectorAll("#user-avatar, #avatarPreview");
  els.forEach((el) => {
    if (el) el.src = src;
  });
  const frame = document.getElementById("avatarFrame");
  const initials = document.getElementById("avatarInitials");
  if (frame) frame.classList.add("has-photo");
  if (initials) initials.style.display = "none";
}

function applyAvatar(user = state.profileUser || {}) {
  const src = getProfileImageUrl(user);
  if (!src) return;
  const avatar = document.getElementById("user-avatar");
  const preview = document.getElementById("profilePhotoPreview");

  if (avatar) avatar.src = src;
  if (preview) preview.src = src;
}
function friendlyAvailabilityDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const elements = {
  error: document.getElementById("profileError"),
  inviteBtn: document.getElementById("inviteToCaseBtn"),
  messageBtn: document.getElementById("messageBtn"),
  editBtn: document.getElementById("editProfileBtn"),
  backBtn: document.getElementById("backBtn"),
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
  experienceCard: document.getElementById("experienceCard"),
  educationCard: document.getElementById("educationCard"),
  skillsCard: document.getElementById("skillsCard"),
  skillsSection: document.getElementById("skillsSection"),
  practiceSection: document.getElementById("practiceSection"),
  bestForCard: document.getElementById("bestForCard"),
  bestForList: document.getElementById("bestForList"),
  experienceSection: document.getElementById("experienceSection"),
  educationSection: document.getElementById("educationSection"),
  languagesRow: document.getElementById("languagesRow"),
  stateExperienceRow: document.getElementById("stateExperienceRow"),
  funFactsCard: document.getElementById("funFactsCard"),
  funFactsCopy: document.getElementById("funFactsCopy"),
  attorneyCard: document.getElementById("attorneyHighlightsCard"),
  attorneyHighlights: document.getElementById("attorneyHighlights"),
  languagesList: document.getElementById("languagesList"),
  stateExperienceList: document.getElementById("stateExperienceList"),
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
  certificateUploadInput: document.getElementById("certificateUpload"),
  resumeUploadInput: document.getElementById("resumeUpload"),
  profilePhotoInput: document.getElementById("photoInput"),
  profileSaveBtn: document.getElementById("saveProfileBtn"),
  certificateLink: document.getElementById("certificateLink"),
  resumeLink: document.getElementById("resumeLink"),
  writingSampleLink: document.getElementById("writingSampleLink"),
  documentsCard: document.getElementById("documentsSection"),
  completionPrompt: document.getElementById("profileCompletionPrompt"),
  completionDetails: document.getElementById("profileCompletionDetails"),
  completionBtn: document.getElementById("completeProfileBtn"),
};

const PENDING_PROFILE_MESSAGE =
  "Your account is pending admin approval. Profiles unlock once your application is reviewed.";

function hasViewerAccess(user = {}) {
  const role = String(user.role || "").toLowerCase();
  if (role === "admin") return true;
  const status = String(user.status || "").toLowerCase();
  return status === "approved";
}

if (elements.inviteCaseSelect) {
  elements.inviteCaseSelect.addEventListener("change", () => clearFieldError(elements.inviteCaseSelect));
}

const state = {
  viewerUser: null, // logged-in user (session/local cache)
  viewerRole: "",
  viewerId: "",
  paralegalId: "",
  viewingSelf: false,
  profileUser: null, // the paralegal being displayed
  caseContextId: null,
  openCases: [],
  inviteTarget: null,
};

const PREFILL_CACHE_KEY = "lpc_edit_profile_prefill";

async function cacheProfileForEditing() {
  if (!state.profileUser) return;
  const profileId = String(state.profileUser.id || state.profileUser._id || "");
  const isSelf =
    state.viewerRole === "paralegal" && state.viewerId && profileId && state.viewerId === profileId;

  const target = isSelf ? await fetchSelfProfileSnapshot() : await fetchPublicProfileSnapshot();
  const payload = target || state.profileUser;
  persistPrefill(payload);
  persistCachedUser(payload);
}

function persistCachedUser(user) {
  if (!user) return;
  const base = (window.getStoredUser && window.getStoredUser()) || {};
  const merged = { ...base, ...user };
  if (!merged.role) merged.role = base.role || user.role || "paralegal";
  const userId = user.id || user._id;
  if (!merged.id && userId) merged.id = userId;
  if (!merged._id && user._id) merged._id = user._id;
  try {
    localStorage.setItem("lpc_user", JSON.stringify(merged));
    window.updateSessionUser?.(merged);
  } catch (err) {
    console.warn("Unable to cache profile locally", err);
  }
}

function persistPrefill(user) {
  if (!user) return;
  try {
    localStorage.setItem(PREFILL_CACHE_KEY, JSON.stringify(user));
  } catch (err) {
    console.warn("Unable to cache edit prefill", err);
  }
}

async function fetchSelfProfileSnapshot() {
  try {
    const res = await secureFetch("/api/users/me", { headers: { Accept: "application/json" }, noRedirect: true });
    const data = await res.json().catch(() => null);
    return res.ok ? data : null;
  } catch (err) {
    console.warn("Unable to fetch self profile snapshot", err);
    return null;
  }
}

async function fetchPublicProfileSnapshot() {
  try {
    const isSelf = state.paralegalId && state.viewerId && state.paralegalId === state.viewerId && state.viewerRole === "paralegal";
    if (isSelf) {
      const meRes = await secureFetch("/api/users/me", { headers: { Accept: "application/json" }, noRedirect: true });
      const meData = await meRes.json().catch(() => null);
      return meRes.ok ? meData : null;
    }
    const res = await fetch(`/api/public/paralegals/${encodeURIComponent(state.paralegalId || "")}`, {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const data = await res.json().catch(() => null);
    return res.ok ? data : null;
  } catch (err) {
    console.warn("Unable to fetch profile snapshot", err);
    return null;
  }
}

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

window.addEventListener("lpc:user-updated", (event) => {
  const updated = event?.detail;
  if (!updated || !state.profileUser) return;
  const updatedId = String(updated._id || updated.id || "");
  const currentId = String(state.profileUser.id || state.paralegalId || "");
  if (!updatedId || updatedId !== currentId) return;
  state.profileUser = { ...state.profileUser, ...updated };
  renderProfile(state.profileUser);
});

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

  if (!hasViewerAccess(sessionUser)) {
    showToast(PENDING_PROFILE_MESSAGE, "info");
    toggleSkeleton(false);
    disableCtas();
    return;
  }

  applyRoleVisibility(sessionUser);

  const storedUser = window.getStoredUser ? window.getStoredUser() : null;
  state.viewerUser = storedUser || sessionUser || null;
  if (sessionUser?.status && state.viewerUser && !state.viewerUser.status) {
    state.viewerUser = { ...state.viewerUser, status: sessionUser.status };
  }
  state.viewerRole = String(state.viewerUser?.role || "").toLowerCase();
  state.viewerId = String(state.viewerUser?.id || state.viewerUser?._id || "");

  hydrateHeader();
  bindHeaderEvents();
  bindCtaEvents();
  bindProfileForm();
  bindBackButton();
  elements.messageBtn?.classList.add("hidden");
  elements.messageBtn?.setAttribute("aria-hidden", "true");

  const params = new URLSearchParams(window.location.search);
  state.caseContextId = params.get("caseId") || null;
  const explicitId = params.get("paralegalId") || params.get("id");
  state.viewingSelf = params.get("me") === "1";

  if (explicitId && explicitId.trim()) {
    state.paralegalId = explicitId.trim();
  } else {
    const slugMatch = window.location.pathname.match(/paralegal\/([^/?#]+)/i);
    if (slugMatch && slugMatch[1]) {
      state.paralegalId = slugMatch[1];
    }
  }

  if (state.viewingSelf && state.viewerRole === "paralegal") {
    state.paralegalId = state.viewerId;
  }

  if (!state.paralegalId && state.viewerRole === "paralegal") {
    state.paralegalId = state.viewerId;
  }
  if (state.paralegalId && state.viewerId && state.paralegalId === state.viewerId) {
    state.viewingSelf = true;
  }
  if (
    state.viewerRole === "paralegal" &&
    state.paralegalId &&
    state.viewerId &&
    state.paralegalId !== state.viewerId
  ) {
    window.location.replace("dashboard-paralegal.html");
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
  const handleEditProfileClick = async (event) => {
    event?.preventDefault?.();
    try {
      await cacheProfileForEditing();
    } finally {
      window.location.href = "profile-settings.html";
    }
  };
  elements.editBtn?.addEventListener("click", handleEditProfileClick);
  elements.completionBtn?.addEventListener("click", handleEditProfileClick);
  elements.closeInviteBtn?.addEventListener("click", closeInviteModal);
  elements.inviteModal?.addEventListener("click", (event) => {
    if (event.target === elements.inviteModal) closeInviteModal();
  });
  elements.sendInviteBtn?.addEventListener("click", sendInviteToCase);

  bindDocumentLinks();
}

function bindBackButton() {
  if (!elements.backBtn) return;
  elements.backBtn.addEventListener("click", (event) => {
    event.preventDefault();
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "browse-paralegals.html";
    }
  });
}

function bindDocumentLinks() {
  [elements.certificateLink, elements.resumeLink, elements.writingSampleLink].forEach((link) => {
    if (!link) return;
    link.addEventListener("click", async (event) => {
      const key = link.dataset.key;
      if (!key) return;
      event.preventDefault();
      try {
        const signed = await fetchDocumentUrl(key);
        if (signed) window.open(signed, "_blank", "noopener");
        else showToast("Document is unavailable.", "error");
      } catch (err) {
        console.error(err);
        showToast("Unable to open document.", "error");
      }
    });
  });
}

async function fetchDocumentUrl(key) {
  const params = new URLSearchParams({ key });
  const res = await secureFetch(`/api/uploads/signed-get?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data?.msg || "Download failed");
  return data.url;
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
  if (!canEditProfile() || !state.profileUser) {
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
  const snapshot = state.profileUser || { id: state.paralegalId };
  state.profileUser = { ...snapshot, ...payload };
  populateProfileForm(state.profileUser);
  renderProfile(state.profileUser);
  renderMetadata(state.profileUser);
  return data;
}

function buildProfileUpdatePayload() {
  return {
    linkedInURL: sanitizeUrl(elements.linkedInInput?.value),
    yearsExperience: sanitizeYears(elements.yearsExperienceInput?.value),
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
      const updated = await persistDocumentField("certificateURL", url);
      const certificateKey = updated?.certificateKey || updated?.certificateURL || url;
      const snapshot = state.profileUser || { id: state.paralegalId };
      state.profileUser = { ...snapshot, certificateURL: certificateKey, certificateKey };
      renderMetadata(state.profileUser);
      renderAttorneyHighlights(state.profileUser);
      renderDocumentLinks(state.profileUser);
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
    const res = await fetch("/api/uploads/paralegal-resume", {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.url) {
      throw new Error(data?.error || data?.msg || "Unable to upload résumé");
    }
    const key = data.key || data.url;
    const patchRes = await fetch("/api/users/me", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resumeURL: key }),
    });
    if (!patchRes.ok) {
      throw new Error("Could not save résumé to profile.");
    }
    const resumeValue = key;
    const snapshot = state.profileUser || { id: state.paralegalId };
    state.profileUser = { ...snapshot, resumeURL: resumeValue };
    renderMetadata(state.profileUser);
    renderAttorneyHighlights(state.profileUser);
    renderDocumentLinks(state.profileUser);
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
      const snapshot = state.profileUser || { id: state.paralegalId };
      state.profileUser = { ...snapshot, profileImage: url };
      if (state.viewerRole === "paralegal" && state.viewerId === state.paralegalId) {
        state.viewerUser = { ...(state.viewerUser || {}), profileImage: url };
        hydrateHeader();
      }
      renderProfile(state.profileUser);
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
  if (!state.viewerUser) return;
  if (elements.chipName) elements.chipName.textContent = formatName(state.viewerUser);
  if (elements.chipRole) elements.chipRole.textContent = prettyRole(state.viewerUser.role);
  const avatarSrc =
    getProfileImageUrl(state.viewerUser) || buildInitialAvatar(getInitials(formatName(state.viewerUser)));
  if (elements.chipAvatar && avatarSrc) {
    elements.chipAvatar.src = avatarSrc;
    elements.chipAvatar.alt = `${formatName(state.viewerUser)} avatar`;
  }
}

function bindHeaderEvents() {
  if (elements.notificationToggle && elements.notificationPanel) {
    elements.notificationToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      const isShowing = elements.notificationPanel.classList.toggle("show");
      elements.notificationPanel.classList.toggle("hidden", !isShowing);
      if (isShowing) {
        if (typeof window.refreshNotificationCenters === "function") {
          window.refreshNotificationCenters();
        }
        secureFetch("/api/notifications/read-all", { method: "POST" }).catch(() => {});
      }
    });
  }

  if (elements.userChip && elements.profileDropdown) {
    elements.userChip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
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
  let publicProfileFailed = false;
  try {
    let data;
    if (state.viewingSelf) {
      const res = await secureFetch("/api/users/me", {
        headers: { Accept: "application/json" },
        noRedirect: true,
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Unable to load profile");
      state.profileUser = { ...data, id: data.id || data._id || state.viewerId || "" };
      if (!state.paralegalId && state.profileUser.id) {
        state.paralegalId = state.profileUser.id;
      }
    } else {
      if (!state.paralegalId) throw new Error("Unable to load this paralegal right now.");
      const viewingSelf = state.paralegalId === state.viewerId && state.viewerRole === "paralegal";
      if (viewingSelf) {
        const res = await secureFetch("/api/users/me", {
          headers: { Accept: "application/json" },
          noRedirect: true,
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Unable to load profile");
        state.profileUser = { ...data, id: data.id || data._id || state.paralegalId };
      } else {
        // Logged-in members should view private profiles via authenticated endpoint first.
        const usePrivate = Boolean(state.viewerRole);
        let resolved = false;
        let res;
        if (usePrivate) {
          res = await secureFetch(`/api/paralegals/${encodeURIComponent(state.paralegalId)}`, {
            headers: { Accept: "application/json" },
            noRedirect: true,
          });
          data = await res.json().catch(() => ({}));
          if (res.ok) {
            state.profileUser = { ...data, id: data.id || data._id || state.paralegalId };
            resolved = true;
          } else if (res.status !== 404) {
            const err = new Error(data?.error || "Unable to load this paralegal right now.");
            err.status = res.status;
            throw err;
          }
          // fall through on 404 to public fetch
        }

        if (!resolved) {
          try {
            res = await fetch(`/api/public/paralegals/${encodeURIComponent(state.paralegalId)}`, {
              headers: { Accept: "application/json" },
              credentials: "include",
            });
          } catch (fetchErr) {
            publicProfileFailed = true;
            throw fetchErr;
          }
          data = await res.json().catch(() => ({}));
          if (!res.ok) {
            publicProfileFailed = true;
            const message =
              res.status === 404
                ? "Paralegal profile not found. Please use a valid profile link."
                : data?.error || "Unable to load this paralegal right now.";
            const err = new Error(message);
            err.status = res.status;
            throw err;
          }
          state.profileUser = { ...data, id: data.id || data._id || state.paralegalId };
        }
      }
    }
    applyGlobalAvatars(state.profileUser);
    applyAvatar(state.profileUser);
    renderProfile(state.profileUser);
    populateProfileForm(state.profileUser);
    updateProfileFormVisibility();
    updateButtonVisibility();
    elements.error?.classList.add("hidden");
    elements.error.textContent = "";
  } catch (err) {
    console.error(err);
    const notFound = publicProfileFailed || err?.status === 404;
    if (notFound) {
      showError("Paralegal profile not found. Please use a valid profile link.");
    } else {
      elements.error?.classList.add("hidden");
      elements.error.textContent = "";
      showToast(err.message || "Unable to load this paralegal right now.", "error");
    }
    disableCtas();
  }
}

function renderProfile(profile) {
  const fullName = formatName(profile);
  setFieldText(elements.nameField, fullName);

  const experienceLabel = describeExperience(profile.yearsExperience);
  const roleCopy = profile.role || profile.title || "Paralegal";
  const roleLine = [experienceLabel, roleCopy].filter(Boolean).join(" • ") || "Paralegal";
  setFieldText(elements.roleLine, roleLine);

  const summary = profile.bio || profile.about || "";
  const hasSummary = Boolean(summary && summary.trim().length);
  if (elements.bioCopy) {
    setFieldText(elements.bioCopy, summary);
    elements.bioCopy.classList.toggle("hidden", !hasSummary);
  }

  renderAvatar(fullName, getProfileImageUrl(profile));
  renderStatus(profile);
  renderMetadata(profile);
  const hasLanguages = renderLanguages(profile.languages || []);
  renderStateExperience(profile.stateExperience || profile.jurisdictions || []);
  const skillValues =
    (Array.isArray(profile.skills) && profile.skills.length ? profile.skills : null) ||
    (Array.isArray(profile.highlightedSkills) && profile.highlightedSkills.length ? profile.highlightedSkills : null);
  const practiceValues =
    (Array.isArray(profile.practiceAreas) && profile.practiceAreas.length ? profile.practiceAreas : null) ||
    (Array.isArray(profile.specialties) && profile.specialties.length ? profile.specialties : null);
  const { hasSkills, hasPractice } = renderSkillsAndPractice(skillValues, practiceValues);
  renderBestFor(profile.bestFor);
  const hasExperience = renderExperience(profile.experience);
  const hasEducation = renderEducation(profile.education);
  renderFunFacts(profile.about, profile.writingSamples);
  const hasDocuments = renderDocumentLinks(profile);
  if (elements.experienceCard) {
    elements.experienceCard.classList.toggle("hidden", !hasExperience);
  }
  renderCompletionPrompt({
    hasSummary,
    hasSkills,
    hasPractice,
    hasExperience,
    hasEducation,
    hasLanguages,
    hasDocuments,
  });
}

function populateProfileForm(profile) {
  if (!elements.profileForm || !profile) return;
  setInputValue(elements.linkedInInput, profile.linkedInURL);
  setInputValue(elements.yearsExperienceInput, profile.yearsExperience ?? "");
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
  const source = avatarUrl || PLACEHOLDER_AVATAR;
  if (elements.avatarImg) {
    elements.avatarImg.src = source;
    elements.avatarImg.alt = `${name} portrait`;
    elements.avatarImg.loading = "lazy";
    elements.avatarImg.style.display = "block";
  }
  if (elements.avatarFallback) {
    elements.avatarFallback.textContent = getInitials(name);
    elements.avatarFallback.style.display = avatarUrl ? "none" : "flex";
  }
  const heroAvatar = document.getElementById("user-avatar");
  if (heroAvatar && source) {
    heroAvatar.src = source;
  }
  const previewAvatar = document.getElementById("profilePhotoPreview");
  if (previewAvatar && source) {
    previewAvatar.src = source;
  }
  elements.avatarWrapper?.classList.remove("skeleton-block");
}

function renderStatus(profile) {
  if (!elements.statusChip) return;
  const message = profile.availability || "Availability on request";
  const nextAvailable = friendlyAvailabilityDate(profile.availabilityDetails?.nextAvailable);
  elements.statusChip.textContent = nextAvailable ? `${message} · Next opening ${nextAvailable}` : message;
}

function renderMetadata(profile) {
  const stateOnly = extractState(profile.location);
  if (stateOnly) {
    const href = `https://www.google.com/maps/search/${encodeURIComponent(stateOnly + " state")}`;
    renderMetaLine(elements.locationMeta, "map", stateOnly, href);
  } else {
    clearMetaLine(elements.locationMeta);
  }

  if (profile.barNumber) {
    renderMetaLine(elements.credentialMeta, "C", `Bar #${profile.barNumber}`);
  } else {
    const linkedIn = profile.linkedInURL || profile.linkedin || "";
    if (linkedIn) {
      renderMetaLine(elements.credentialMeta, "link", "LinkedIn", linkedIn);
    } else {
      renderMetaLine(elements.credentialMeta, "", "Credentials available upon request");
    }
  }

  const joinedSource = profile.approvedAt || profile.createdAt || null;
  const joined =
    joinedSource && !Number.isNaN(new Date(joinedSource).getTime())
      ? new Date(joinedSource).toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : null;
  renderMetaLine(elements.joinedMeta, "J", joined ? `Joined ${joined}` : "Joined date unavailable");
}

function renderDocumentLinks(profile) {
  let hasDoc = false;
  const deriveKey = (value = "") => {
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        return url.pathname.replace(/^\/+/, "");
      } catch {
        return value;
      }
    }
    return value.replace(/^\/+/, "");
  };
  if (elements.certificateLink) {
    elements.certificateLink.setAttribute("href", "#");
    const certKey = profile.certificateKey || profile.certificateURL;
    if (certKey) {
      const key = deriveKey(certKey);
      if (key) {
        elements.certificateLink.dataset.key = key;
        if (/^https?:\/\//i.test(certKey)) {
          elements.certificateLink.href = `${certKey}${certKey.includes("?") ? "&" : "?"}v=${Date.now()}`;
        }
        elements.certificateLink.classList.remove("hidden");
        hasDoc = true;
      } else {
        elements.certificateLink.dataset.key = "";
        elements.certificateLink.classList.add("hidden");
      }
    } else {
      elements.certificateLink.dataset.key = "";
      elements.certificateLink.classList.add("hidden");
    }
  }
  if (elements.resumeLink) {
    elements.resumeLink.setAttribute("href", "#");
    const resumeKey = profile.resumeURL;
    if (resumeKey) {
      const key = deriveKey(resumeKey);
      if (key) {
        elements.resumeLink.dataset.key = key;
        if (/^https?:\/\//i.test(resumeKey)) {
          elements.resumeLink.href = `${resumeKey}${resumeKey.includes("?") ? "&" : "?"}v=${Date.now()}`;
        }
        elements.resumeLink.classList.remove("hidden");
        hasDoc = true;
      } else {
        elements.resumeLink.dataset.key = "";
        elements.resumeLink.classList.add("hidden");
      }
    } else {
      elements.resumeLink.dataset.key = "";
      elements.resumeLink.classList.add("hidden");
    }
  }
  if (elements.writingSampleLink) {
    elements.writingSampleLink.setAttribute("href", "#");
    const writingKey = profile.writingSampleURL;
    if (writingKey) {
      const key = deriveKey(writingKey);
      if (key) {
        elements.writingSampleLink.dataset.key = key;
        if (/^https?:\/\//i.test(writingKey)) {
          elements.writingSampleLink.href = `${writingKey}${writingKey.includes("?") ? "&" : "?"}v=${Date.now()}`;
        }
        elements.writingSampleLink.classList.remove("hidden");
        hasDoc = true;
      } else {
        elements.writingSampleLink.dataset.key = "";
        elements.writingSampleLink.classList.add("hidden");
      }
    } else {
      elements.writingSampleLink.dataset.key = "";
      elements.writingSampleLink.classList.add("hidden");
    }
  }
  if (elements.documentsCard) {
    elements.documentsCard.classList.toggle("hidden", !profile.writingSampleURL);
  }
  return hasDoc;
}

function normalizeLanguagesList(languages = []) {
  if (!Array.isArray(languages)) return [];
  return languages
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        const cleaned = entry.trim();
        return cleaned ? { name: cleaned, proficiency: "" } : null;
      }
      const name = String(entry.name || entry.language || "").trim();
      const proficiency = String(entry.proficiency || entry.level || "").trim();
      if (!name) return null;
      return { name, proficiency };
    })
    .filter(Boolean);
}

function renderLanguages(languages = []) {
  const container = elements.languagesList;
  if (!container) return false;
  container.innerHTML = "";
  const normalized = normalizeLanguagesList(languages);
  const hasLanguages = normalized.length > 0;
  if (elements.languagesRow) {
    elements.languagesRow.classList.toggle("hidden", !hasLanguages);
  }
  if (!hasLanguages) return false;
  normalized.forEach((lang) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = lang.proficiency ? `${lang.name} — ${lang.proficiency}` : lang.name;
    container.appendChild(chip);
  });
  return true;
}

function renderStateExperience(entries = []) {
  const container = elements.stateExperienceList;
  if (!container) return false;
  container.innerHTML = "";
  const list = Array.isArray(entries)
    ? entries.map((item) => String(item || "").trim()).filter(Boolean)
    : typeof entries === "string"
    ? entries.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const hasStates = list.length > 0;
  if (elements.stateExperienceRow) {
    elements.stateExperienceRow.classList.toggle("hidden", !hasStates);
  }
  if (!hasStates) return false;
  list.slice(0, 12).forEach((stateLabel) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = stateLabel;
    container.appendChild(chip);
  });
  return true;
}

function renderMetaLine(el, iconKey, text, href) {
  if (!el) return;
  el.classList.remove("skeleton-block");
  el.classList.remove("hidden");
  const metaColumn = el.closest(".meta-column");
  const iconMap = {
    map: `<svg viewBox="0 0 24 24" aria-hidden="true" role="img" focusable="false"><path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="11" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
    link: `<svg viewBox="0 0 24 24" aria-hidden="true" role="img" focusable="false"><path d="M8 11a5 5 0 0 1 5-5h3a5 5 0 0 1 0 10h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16 13a5 5 0 0 1-5 5H8a5 5 0 0 1 0-10h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 12h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  };
  const iconMarkup = iconKey && iconMap[iconKey]
    ? `<span class="meta-icon">${iconMap[iconKey]}</span>`
    : "";
  if (metaColumn) {
    metaColumn.classList.toggle("has-meta-icon", Boolean(iconMarkup));
  }
  if (href) {
    el.innerHTML = `<a class="hero-meta-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">${iconMarkup}<span class="meta-text">${escapeHtml(
      text
    )}</span></a>`;
  } else {
    if (iconMarkup) {
      el.innerHTML = `<span class="meta-line">${iconMarkup}<span class="meta-text">${escapeHtml(text || "")}</span></span>`;
    } else {
      el.textContent = text || "";
    }
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

function renderSkills(container, values, emptyCopy) {
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
  list.slice(0, 10).forEach((value, index) => {
    const skill = document.createElement("div");
    skill.className = "skill";

    const label = document.createElement("span");
    label.className = "skill-label";
    label.textContent = value;

    const line = document.createElement("div");
    line.className = "skill-line";

    const progress = document.createElement("div");
    progress.className = "skill-progress";
    const percent = 40 + ((index % 5) * 12);
    progress.style.width = `${Math.min(percent, 100)}%`;

    line.appendChild(progress);
    skill.appendChild(label);
    skill.appendChild(line);
    container.appendChild(skill);
  });
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

function renderSkillsAndPractice(skills = [], practices = []) {
  const renderList = (target, values) => {
    if (!target) return 0;
    target.innerHTML = "";
    const seen = new Set();
    const cleaned = (Array.isArray(values) ? values : [])
      .map((val) => (val ? String(val).trim() : ""))
      .filter(Boolean)
      .filter((val) => {
        const key = val.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!cleaned.length) return 0;
    cleaned.slice(0, 24).forEach((label) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = label;
      target.appendChild(chip);
    });
    return cleaned.length;
  };

  const skillsCount = renderList(elements.skillsList, skills);
  const practiceCount = renderList(elements.practiceList, practices);
  const hasSkills = skillsCount > 0;
  const hasPractice = practiceCount > 0;
  if (elements.skillsSection) {
    elements.skillsSection.classList.toggle("hidden", !hasSkills);
  }
  if (elements.practiceSection) {
    elements.practiceSection.classList.toggle("hidden", !hasPractice);
  }
  if (elements.skillsCard) {
    elements.skillsCard.classList.toggle("hidden", !hasSkills);
  }
  return { hasSkills, hasPractice };
}

function renderBestFor(entries) {
  if (!elements.bestForList) return false;
  elements.bestForList.innerHTML = "";
  const list = Array.isArray(entries)
    ? entries.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!list.length) {
    if (elements.bestForCard) elements.bestForCard.classList.add("hidden");
    return false;
  }
  list.slice(0, 6).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    elements.bestForList.appendChild(li);
  });
  if (elements.bestForCard) elements.bestForCard.classList.remove("hidden");
  return true;
}

function renderExperience(entries) {
  if (!elements.experienceList) return false;
  elements.experienceList.innerHTML = "";
  const list = Array.isArray(entries)
    ? entries.filter((item) => item && (item.title || item.years || item.description))
    : [];
  if (!list.length) {
    if (elements.experienceSection) {
      elements.experienceSection.classList.add("hidden");
    }
    return false;
  }
  if (elements.experienceSection) {
    elements.experienceSection.classList.remove("hidden");
  }
  list.slice(0, 5).forEach((item) => {
    const block = document.createElement("div");
    block.className = "timeline-item";
    const label = document.createElement("div");
    label.className = "experience-line";
    const title = String(item.title || "").trim();
    const detail = pickExperienceDetail(item);
    const years = String(item.years || item.timeline || formatExperienceRange(item) || "").trim();
    const base = [title || "Paralegal", detail].filter(Boolean).join(" · ");
    label.textContent = years ? `${base} (${years})` : base;
    block.appendChild(label);
    elements.experienceList.appendChild(block);
  });
  return true;
}

function pickExperienceDetail(item = {}) {
  const raw = String(item.description || item.focus || item.summary || "").trim();
  if (!raw) return "";
  const firstLine = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean)[0] || "";
  if (!firstLine) return "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function formatExperienceRange(item = {}) {
  const start = item.startDate || item.start || item.from || "";
  const end = item.endDate || item.end || item.to || "";
  const formatDate = (value) => {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };
  const startLabel = formatDate(start);
  const endLabel = formatDate(end);
  if (startLabel && endLabel) return `${startLabel} – ${endLabel}`;
  if (startLabel) return `${startLabel} – Present`;
  return endLabel ? `Through ${endLabel}` : "";
}

function formatEducationRange(item = {}) {
  const startParts = [item.startMonth, item.startYear].filter(Boolean).join(" ");
  const endParts = [item.endMonth, item.endYear].filter(Boolean).join(" ");
  if (startParts && endParts) return `${startParts} – ${endParts}`;
  if (startParts) return startParts;
  return endParts || "";
}

function renderEducation(entries) {
  if (!elements.educationList) return false;
  elements.educationList.innerHTML = "";
  const list = Array.isArray(entries)
    ? entries.filter((item) => item && (item.degree || item.school || item.fieldOfStudy || item.grade || item.activities))
    : [];
  if (!list.length) {
    if (elements.educationSection) {
      elements.educationSection.classList.add("hidden");
    }
    if (elements.educationCard) {
      elements.educationCard.classList.add("hidden");
    }
    return false;
  }
  if (elements.educationSection) {
    elements.educationSection.classList.remove("hidden");
  }
  if (elements.educationCard) {
    elements.educationCard.classList.remove("hidden");
  }
  list.slice(0, 5).forEach((item) => {
    const entry = document.createElement("div");
    entry.className = "edu-entry";

    const title = document.createElement("div");
    title.className = "edu-title";
    const titleParts = [item.degree, item.fieldOfStudy].filter(Boolean);
    title.textContent = titleParts.length ? titleParts.join(", ") : item.school || "Education";
    entry.appendChild(title);

    const range = formatEducationRange(item);
    const subParts = [item.school, range].filter(Boolean);
    if (subParts.length) {
      const sub = document.createElement("div");
      sub.className = "edu-sub";
      sub.textContent = subParts.join(" • ");
      entry.appendChild(sub);
    }

    if (item.grade) {
      const grade = document.createElement("div");
      grade.className = "edu-meta";
      grade.textContent = `Grade: ${item.grade}`;
      entry.appendChild(grade);
    }

    if (item.activities) {
      const activities = document.createElement("div");
      activities.className = "edu-meta";
      activities.textContent = `Activities: ${item.activities}`;
      entry.appendChild(activities);
    }

    elements.educationList.appendChild(entry);
  });
  return true;
}

function renderCompletionPrompt(stateSummary = {}) {
  if (!elements.completionPrompt) return;
  const isOwner = state.viewerRole === "paralegal" && state.viewerId && state.viewerId === state.paralegalId;
  if (!isOwner) {
    elements.completionPrompt.classList.add("hidden");
    return;
  }
  const missing = [];
  if (!stateSummary.hasSummary) missing.push("summary");
  if (!stateSummary.hasSkills) missing.push("skills");
  if (!stateSummary.hasPractice) missing.push("focus areas");
  if (!stateSummary.hasExperience && !stateSummary.hasEducation) missing.push("experience");
  if (!stateSummary.hasLanguages) missing.push("languages");
  if (!stateSummary.hasDocuments) missing.push("documents");

  const shouldShow = missing.length > 0;
  elements.completionPrompt.classList.toggle("hidden", !shouldShow);
  if (shouldShow && elements.completionDetails) {
    const preview = missing.slice(0, 3).join(", ");
    const suffix = missing.length > 3 ? " and more" : "";
    elements.completionDetails.textContent = `Add ${preview}${suffix} to improve your profile visibility.`;
  }
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

  container.innerHTML = "";
  if (!entries.length) {
    card.classList.add("hidden");
    return;
  }

  entries.forEach((entry) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${escapeHtml(entry.title)}: ${entry.content}`;
    container.appendChild(chip);
  });
}

function updateButtonVisibility() {
  const isOwner = state.viewerRole === "paralegal" && state.viewerId && state.viewerId === state.paralegalId;
  const isAttorney = state.viewerRole === "attorney";

  toggleElement(elements.editBtn, false);
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
      return !archived && !assigned;
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
  if (!elements.inviteModal || !state.profileUser) return;
  if (!state.openCases.length) {
    showToast("You need an active case before inviting a paralegal.", "info");
    return;
  }
  clearFieldError(elements.inviteCaseSelect);
  renderCaseOptions();
  elements.inviteModal.classList.add("show");
}

function closeInviteModal() {
  elements.inviteModal?.classList.remove("show");
  clearFieldError(elements.inviteCaseSelect);
}

async function sendInviteToCase() {
  if (!state.profileUser || !elements.inviteCaseSelect) return;
  const caseId = elements.inviteCaseSelect.value;
  clearFieldError(elements.inviteCaseSelect);
  if (!caseId) {
    showFieldError(elements.inviteCaseSelect, "Select a case to continue.");
    showToast("Select a case to continue.", "info");
    return;
  }
  const payload = {
    paralegalId: state.profileUser.id || state.paralegalId,
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

function showFieldError(field, message) {
  if (!field) return;
  clearFieldError(field);
  field.classList?.add("input-error");
  if (typeof field.setAttribute === "function") field.setAttribute("aria-invalid", "true");
  const error = document.createElement("div");
  error.className = "field-error";
  error.textContent = message;
  const wrapper = field.closest(".field") || field.closest("[data-field-wrapper]");
  if (wrapper) wrapper.appendChild(error);
  else field.insertAdjacentElement("afterend", error);
}

function clearFieldError(field) {
  if (!field) return;
  field.classList?.remove("input-error");
  if (typeof field.removeAttribute === "function") field.removeAttribute("aria-invalid");
  const wrapper = field.closest(".field") || field.closest("[data-field-wrapper]");
  if (wrapper) {
    const existing = wrapper.querySelector(".field-error");
    if (existing) existing.remove();
    return;
  }
  const next = field.nextElementSibling;
  if (next?.classList.contains("field-error")) next.remove();
}

function showToast(message, type = "info") {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}
