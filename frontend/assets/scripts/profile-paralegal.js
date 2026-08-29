import { secureFetch, requireAuth } from "./auth.js";
import { activateDialogFocus, deactivateDialogFocus } from "./utils/dialog-focus.js";
import { showAlert } from "./utils/dialogs.js";
import { normalizeHttpNavigationUrl, normalizeSameOriginPath } from "./utils/navigation-url.js";

const PLACEHOLDER_AVATAR = "/assets/avatar-placeholder.svg";
const MISSING_DOCUMENT_MESSAGE = "This document is no longer available for download.";
const PLATFORM_FEE_PCT = 22;
const DEFAULT_HIRE_ERROR = "Unable to hire paralegal.";

function resolveProfilePhotoStatus(user = {}) {
  const raw = String(user.profilePhotoStatus || "").trim();
  if (raw) return raw;
  if (user.pendingProfileImage) return "pending_review";
  const hasApproved = Boolean(user.profileImage || user.avatarURL);
  return hasApproved ? "approved" : "unsubmitted";
}

function getProfileImageUrl(user = {}, { allowPending = false } = {}) {
  const approved = user.profileImage || user.avatarURL || "";
  if (allowPending) {
    const pending = user.pendingProfileImage || "";
    if (pending) {
      return pending;
    }
  }
  return approved || PLACEHOLDER_AVATAR;
}

function getReturnToUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("returnTo");
  return normalizeSameOriginPath(raw);
}

function getApplicantContextFromReturnTo() {
  const returnTo = getReturnToUrl();
  if (!returnTo) return null;
  try {
    const url = new URL(returnTo, window.location.origin);
    const caseId = url.searchParams.get("caseId") || "";
    const applicantId = url.searchParams.get("applicantId") || "";
    const returnFromProfile = url.searchParams.get("returnFromProfile") === "1";
    const openApplicant = url.searchParams.get("openApplicant") === "1";
    if (!caseId || !applicantId) return null;
    if (!returnFromProfile && !openApplicant) return null;
    return { caseId, applicantId, returnTo };
  } catch {
    return null;
  }
}
function friendlyAvailabilityDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
  photoReviewStatus: document.getElementById("photoReviewStatus"),
  statusChip: document.getElementById("statusChip"),
  locationMeta: document.getElementById("locationMeta"),
  credentialMeta: document.getElementById("credentialMeta"),
  joinedMeta: document.getElementById("joinedMeta"),
  joinedMetaCorner: document.getElementById("joinedMetaCorner"),
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
  bestForFocusRow: document.getElementById("bestForFocusRow"),
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
  chipAvatar: document.getElementById("clusterAvatar"),
  chipName: document.getElementById("clusterName"),
  chipRole: document.getElementById("clusterRole"),
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
  caseContextTitle: "",
  caseContextLoading: false,
  caseLookup: new Map(),
  openCases: [],
  inviteTarget: null,
  applicantContext: null,
  blockedByProfileOwner: false,
};
let attorneyDropdownPortaled = false;

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
  const sessionViewerId = String(sessionUser?.id || sessionUser?._id || "");
  const storedViewerId = String(storedUser?.id || storedUser?._id || "");
  const sameViewer =
    storedUser &&
    sessionUser &&
    storedViewerId &&
    sessionViewerId &&
    storedViewerId === sessionViewerId &&
    String(storedUser.role || "").toLowerCase() === String(sessionUser.role || "").toLowerCase();
  state.viewerUser = sameViewer ? { ...storedUser, ...sessionUser } : sessionUser || storedUser || null;
  state.viewerRole = String(state.viewerUser?.role || "").toLowerCase();
  state.viewerId = String(state.viewerUser?.id || state.viewerUser?._id || "");
  document.body.classList.toggle("viewer-attorney", state.viewerRole === "attorney");

  hydrateMobileNavigation();
  hydrateHeader();
  bindHeaderEvents();
  bindCtaEvents();
  bindBackButton();
  elements.messageBtn?.classList.add("hidden");
  elements.messageBtn?.setAttribute("aria-hidden", "true");

  const params = new URLSearchParams(window.location.search);
  state.caseContextId = params.get("caseId") || null;
  state.applicantContext = getApplicantContextFromReturnTo();
  if (!state.caseContextId && state.applicantContext?.caseId) {
    state.caseContextId = state.applicantContext.caseId;
  }
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
    if (state.applicantContext?.caseId) {
      handleHireForCase();
      return;
    }
    openInviteModal();
  });
  const handleEditProfileClick = (event) => {
    event?.preventDefault?.();
    const profileId = String(state.profileUser?.id || state.profileUser?._id || state.paralegalId || "");
    const isOwner =
      state.viewerRole === "paralegal" && state.viewerId && profileId && state.viewerId === profileId;
    if (!isOwner) return;
    window.location.href = "profile-settings.html";
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
  const returnTo = getReturnToUrl();
  if (returnTo) {
    elements.backBtn.setAttribute("href", returnTo);
  }
  elements.backBtn.addEventListener("click", (event) => {
    event.preventDefault();
    if (returnTo) {
      window.location.href = returnTo;
      return;
    }
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
      if (link.dataset.external === "true") return;
      const key = link.dataset.key;
      if (!key) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      try {
        const signed = await fetchDocumentUrl(key);
        const safeSignedUrl = normalizeHttpNavigationUrl(signed);
        if (safeSignedUrl) window.open(safeSignedUrl, "_blank", "noopener");
        else showToast(MISSING_DOCUMENT_MESSAGE, "info");
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
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data?.msg || "Download failed");
  return data.url;
}

function sanitizeUrl(value, { requiredHost = "" } = {}) {
  if (!value) return "";
  try {
    const url = new URL(String(value), window.location.origin);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";
    if (url.username || url.password) return "";
    const required = String(requiredHost || "").toLowerCase();
    const hostname = url.hostname.toLowerCase();
    if (required && hostname !== required && !hostname.endsWith(`.${required}`)) return "";
    return url.href;
  } catch {}
  return "";
}

function canEditProfile() {
  return state.viewerRole === "paralegal" && state.viewerId && state.viewerId === state.paralegalId;
}

function hydrateMobileNavigation() {
  const links = new Map(
    Array.from(document.querySelectorAll("[data-profile-mobile-nav]")).map((link) => [
      link.dataset.profileMobileNav,
      link,
    ])
  );
  const configure = (key, { label, href, hidden = false }) => {
    const link = links.get(key);
    if (!link) return;
    link.hidden = hidden;
    link.textContent = label;
    link.setAttribute("href", href);
  };
  if (state.viewerRole === "attorney") {
    configure("home", { label: "Home", href: "/dashboard-attorney.html#home" });
    configure("browse", { label: "Browse Paralegals", href: "/browse-paralegals.html" });
    configure("matters", { label: "Matters", href: "/dashboard-attorney.html#cases" });
    configure("settings", { label: "Account Settings", href: "/profile-settings.html" });
    configure("help", { label: "Help", href: "/help.html" });
    return;
  }
  configure("home", { label: "Home", href: "/dashboard-paralegal.html#home" });
  configure("browse", { label: "Browse Matters", href: "/browse-jobs.html" });
  configure("matters", { label: "My Matters & Applications", href: "/dashboard-paralegal.html#cases" });
  configure("settings", { label: "Profile Settings", href: "/profile-settings.html" });
  configure("help", { label: "Help", href: "/paralegalhelp.html" });
}

function hydrateHeader() {
  if (!state.viewerUser) return;
  if (elements.chipName) elements.chipName.textContent = formatName(state.viewerUser);
  if (elements.chipRole) elements.chipRole.textContent = prettyRole(state.viewerUser.role);
  if (elements.userChip) {
    elements.userChip.setAttribute(
      "href",
      state.viewerRole === "attorney" ? "/dashboard-attorney.html#home" : "/dashboard-paralegal.html"
    );
  }
  const settingsButton = elements.profileDropdown?.querySelector("[data-settings]");
  if (settingsButton) {
    settingsButton.textContent = state.viewerRole === "attorney" ? "Dashboard" : "Account Settings";
    settingsButton.setAttribute("href", state.viewerRole === "attorney" ? "/dashboard-attorney.html#home" : "/profile-settings.html");
  }
  const logoutButton = elements.profileDropdown?.querySelector("[data-logout]");
  if (logoutButton) {
    logoutButton.setAttribute("href", "/login.html");
  }
  const avatarSrc =
    getProfileImageUrl(state.viewerUser, { allowPending: canEditProfile() }) ||
    PLACEHOLDER_AVATAR;
  if (elements.chipAvatar && avatarSrc) {
    elements.chipAvatar.src = avatarSrc;
    elements.chipAvatar.alt = `${formatName(state.viewerUser)} avatar`;
  }
  positionAttorneyProfileDropdown();
}

function positionAttorneyProfileDropdown() {
  if (state.viewerRole !== "attorney" || !elements.userChip || !elements.profileDropdown) return;
  if (window.innerWidth <= 960) {
    elements.profileDropdown.style.removeProperty("top");
    elements.profileDropdown.style.removeProperty("right");
    elements.profileDropdown.style.removeProperty("left");
    return;
  }
  if (!attorneyDropdownPortaled) {
    document.body.appendChild(elements.profileDropdown);
    attorneyDropdownPortaled = true;
  }
  const chipRect = elements.userChip.getBoundingClientRect();
  const viewportRightGap = Math.max(16, window.innerWidth - chipRect.right);
  elements.profileDropdown.style.top = `${Math.round(chipRect.bottom + 10)}px`;
  elements.profileDropdown.style.right = `${Math.round(viewportRightGap)}px`;
  elements.profileDropdown.style.left = "auto";
}

function bindHeaderEvents() {
  if (!elements.userChip || !elements.profileDropdown) return;

  elements.userChip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    positionAttorneyProfileDropdown();
    elements.profileDropdown.classList.toggle("show");
  });

  document.addEventListener(
    "click",
    (event) => {
      const settingsBtn = event.target.closest("[data-settings]");
      if (settingsBtn && elements.profileDropdown.contains(settingsBtn)) {
        event.preventDefault();
        event.stopPropagation();
        const targetHref =
          settingsBtn.getAttribute("href") ||
          (state.viewerRole === "attorney" ? "/dashboard-attorney.html#home" : "/profile-settings.html");
        window.location.href = targetHref;
        return;
      }

    },
    true
  );

  document.addEventListener("click", (event) => {
    if (!elements.userChip.contains(event.target) && !elements.profileDropdown.contains(event.target)) {
      elements.profileDropdown.classList.remove("show");
    }
  });
  window.addEventListener("resize", positionAttorneyProfileDropdown);
  window.addEventListener("scroll", positionAttorneyProfileDropdown, { passive: true });
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
            state.blockedByProfileOwner = res.status === 403 && data?.blockedByProfileOwner === true;
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
            state.blockedByProfileOwner = res.status === 403 && data?.blockedByProfileOwner === true;
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
    if (canEditProfile()) {
      state.viewerUser = { ...(state.viewerUser || {}), ...state.profileUser };
      hydrateHeader();
    }
    renderProfile(state.profileUser);
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
  const roleLine = [roleCopy, experienceLabel].filter(Boolean).join(" • ") || "Paralegal";
  setFieldText(elements.roleLine, roleLine);

  const summary = profile.bio || profile.about || "";
  const hasSummary = Boolean(summary && summary.trim().length);
  if (elements.bioCopy) {
    setFieldText(elements.bioCopy, summary);
    elements.bioCopy.classList.toggle("hidden", !hasSummary);
  }

  renderAvatar(fullName, getProfileImageUrl(profile, { allowPending: canEditProfile() }));
  renderPhotoReviewStatus(profile);
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
  syncBestForFocusRowLayout();
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

function syncBestForFocusRowLayout() {
  if (!elements.bestForFocusRow) return;
  const cards = Array.from(elements.bestForFocusRow.querySelectorAll(".profile-section"));
  const visibleCount = cards.filter((card) => !card.classList.contains("hidden")).length;
  elements.bestForFocusRow.classList.toggle("hidden", visibleCount === 0);
  elements.bestForFocusRow.classList.toggle("is-single", visibleCount === 1);
}

function renderAvatar(name, avatarUrl) {
  const source = avatarUrl || "";
  if (elements.avatarImg) {
    elements.avatarImg.alt = `${name} portrait`;
    elements.avatarImg.loading = "lazy";
    if (source) {
      elements.avatarImg.src = source;
      elements.avatarImg.style.display = "block";
    } else {
      elements.avatarImg.removeAttribute("src");
      elements.avatarImg.style.display = "none";
    }
    elements.avatarImg.onerror = () => {
      elements.avatarImg.removeAttribute("src");
      elements.avatarImg.style.display = "none";
      if (elements.avatarFallback) elements.avatarFallback.style.display = "flex";
    };
  }
  if (elements.avatarFallback) {
    elements.avatarFallback.textContent = getInitials(name);
    elements.avatarFallback.style.display = avatarUrl ? "none" : "flex";
  }
  const heroAvatar = document.getElementById("user-avatar");
  if (heroAvatar && heroAvatar !== elements.avatarImg && source) {
    heroAvatar.src = source;
  }
  const previewAvatar = document.getElementById("profilePhotoPreview");
  if (previewAvatar && source) {
    previewAvatar.src = source;
  }
  elements.avatarWrapper?.classList.remove("skeleton-block");
}

function renderPhotoReviewStatus(profile = {}) {
  const note = elements.photoReviewStatus;
  if (!note) return;
  if (!canEditProfile()) {
    note.classList.add("hidden");
    return;
  }
  const status = resolveProfilePhotoStatus(profile);
  let message = "";
  note.classList.remove("is-rejected");
  if (status === "pending_review") {
    message = "Photo pending review. It will appear to attorneys once approved.";
  } else if (status === "rejected") {
    message = "Photo rejected. Please upload a professional headshot.";
    note.classList.add("is-rejected");
  }
  note.textContent = message;
  note.classList.toggle("hidden", !message);
}

function renderStatus(profile) {
  if (!elements.statusChip) return;
  const nextRaw = profile.availabilityDetails?.nextAvailable;
  const nextDate = nextRaw ? new Date(nextRaw) : null;
  const nextExpired = nextDate && !Number.isNaN(nextDate.getTime()) && nextDate.getTime() <= Date.now();
  const message = nextExpired ? "Available Now" : profile.availability || "Availability on request";
  const nextAvailable = nextExpired ? "" : friendlyAvailabilityDate(nextRaw);
  elements.statusChip.textContent = nextAvailable ? `Next opening ${nextAvailable}` : message;
}

function renderMetadata(profile) {
  const stateOnly = extractState(profile.location);
  if (stateOnly) {
    const href = `https://www.google.com/maps/search/${encodeURIComponent(stateOnly + " state")}`;
    const safeHref = sanitizeUrl(href);
    renderMetaLine(elements.locationMeta, "map", stateOnly, safeHref);
  } else {
    clearMetaLine(elements.locationMeta);
  }

  if (profile.barNumber) {
    renderMetaLine(elements.credentialMeta, "C", `Bar #${profile.barNumber}`);
  } else {
    const linkedIn = profile.linkedInURL || profile.linkedin || "";
    const safeLinkedIn = sanitizeUrl(linkedIn, { requiredHost: "linkedin.com" });
    if (safeLinkedIn) {
      renderMetaLine(elements.credentialMeta, "link", "LinkedIn", safeLinkedIn);
    } else {
      renderMetaLine(elements.credentialMeta, "", "Credentials available upon request");
    }
  }

  const joinedSource = profile.approvedAt || profile.createdAt || null;
  const joined =
    joinedSource && !Number.isNaN(new Date(joinedSource).getTime())
      ? new Date(joinedSource).toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : null;
  const joinedLabel = joined ? `Joined ${joined}` : "Joined date unavailable";
  renderMetaLine(elements.joinedMeta, "J", joinedLabel);
  renderMetaLine(elements.joinedMetaCorner, "J", joinedLabel);
}

function configureDocumentLink(link, rawValue = "") {
  if (!link) return false;
  const value = String(rawValue || "").trim();
  link.classList.add("hidden");
  link.removeAttribute("href");
  delete link.dataset.key;
  delete link.dataset.external;
  if (!value) return false;

  if (/^https?:\/\//i.test(value)) {
    const safeExternal = sanitizeUrl(value);
    if (!safeExternal || !/^https?:\/\//i.test(safeExternal)) return false;
    link.href = safeExternal;
    link.dataset.external = "true";
  } else {
    const key = value.replace(/^\/+/, "");
    if (!key) return false;
    link.dataset.key = key;
    link.href = `/api/uploads/view?key=${encodeURIComponent(key)}`;
  }

  link.classList.remove("hidden");
  return true;
}

function renderDocumentLinks(profile) {
  const certificateVisible = configureDocumentLink(
    elements.certificateLink,
    profile.certificateKey || profile.certificateURL
  );
  const resumeVisible = configureDocumentLink(elements.resumeLink, profile.resumeURL);
  const writingSampleVisible = configureDocumentLink(elements.writingSampleLink, profile.writingSampleURL);
  elements.documentsCard?.classList.toggle("hidden", !writingSampleVisible);
  return certificateVisible || resumeVisible || writingSampleVisible;
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
    const degree = String(item.degree || "").trim();
    const fieldOfStudy = String(item.fieldOfStudy || "").trim();
    const school = String(item.school || "").trim();
    const titleParts = [degree, fieldOfStudy].filter(Boolean);
    const titleText = titleParts.length ? titleParts.join(", ") : school || "Education";
    title.textContent = titleText;
    entry.appendChild(title);

    const range = formatEducationRange(item);
    const includeSchoolInSub = Boolean(school) && school.toLowerCase() !== titleText.toLowerCase();
    const subParts = [includeSchoolInSub ? school : "", range].filter(Boolean);
    if (subParts.length) {
      const sub = document.createElement("div");
      sub.className = "edu-sub";
      sub.textContent = subParts.join(" • ");
      entry.appendChild(sub);
    }

    if (item.grade) {
      const grade = document.createElement("div");
      grade.className = "edu-meta";
      grade.textContent = `${String(item.grade)} GPA`;
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


function updateButtonVisibility() {
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
  if (state.blockedByProfileOwner) {
    toggleElement(elements.inviteBtn, false);
    elements.inviteBtn.disabled = true;
    if (elements.sendInviteBtn) elements.sendInviteBtn.disabled = true;
    closeInviteModal();
    return;
  }
  const isAttorney = state.viewerRole === "attorney";
  const applicantCaseId = state.applicantContext?.caseId || "";
  if (isAttorney && applicantCaseId) {
    const label = buildHireLabel(applicantCaseId);
    elements.inviteBtn.textContent = label;
    elements.inviteBtn.dataset.mode = "hire";
    toggleElement(elements.inviteBtn, true);
    elements.inviteBtn.disabled = false;
    if (!state.caseContextTitle && !state.caseContextLoading) {
      void loadCaseContextTitle(applicantCaseId);
    }
    return;
  }
  const hasOpenCases = isAttorney && state.openCases.length > 0;
  elements.inviteBtn.textContent = "Invite to Matter";
  elements.inviteBtn.dataset.mode = "invite";
  toggleElement(elements.inviteBtn, hasOpenCases);
  elements.inviteBtn.disabled = !hasOpenCases;
  if (elements.sendInviteBtn) elements.sendInviteBtn.disabled = !hasOpenCases;
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
    elements.joinedMetaCorner,
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
  } catch (err) {
    console.warn("Unable to load open cases", err);
    state.openCases = [];
  }
  renderCaseOptions();
  updateInviteButtonState();
}

function buildHireLabel(caseId) {
  const title = resolveCaseTitle(caseId);
  return title ? `Hire for ${title}` : "Hire for this Matter";
}

function normalizeId(value) {
  if (!value) return "";
  return String(value);
}

function resolveCaseTitle(caseId) {
  const normalized = normalizeId(caseId);
  if (!normalized) return "";
  if (state.caseContextTitle) return state.caseContextTitle;
  const match = state.openCases.find((item) => normalizeId(item.id || item._id) === normalized);
  if (!match) return "";
  state.caseContextTitle = match.title || match.caseNumber || "";
  return state.caseContextTitle;
}

async function loadCaseContextTitle(caseId) {
  const normalized = normalizeId(caseId);
  if (!normalized) return;
  if (state.caseContextLoading) return;
  state.caseContextLoading = true;
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(normalized)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return;
    state.caseLookup.set(normalized, payload);
    state.caseContextTitle = payload?.title || payload?.caseNumber || "";
  } catch (err) {
    console.warn("Unable to load case context", err);
  } finally {
    state.caseContextLoading = false;
    updateInviteButtonState();
  }
}

function renderCaseOptions() {
  const select = elements.inviteCaseSelect;
  if (!select) return;
  select.innerHTML = "";
  if (!state.openCases.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No active Matters available";
    select.appendChild(option);
    select.disabled = true;
    if (elements.sendInviteBtn) elements.sendInviteBtn.disabled = true;
    return;
  }
  state.openCases.forEach((caseItem, index) => {
    const option = document.createElement("option");
    option.value = caseItem.id || caseItem._id;
    option.textContent = caseItem.title || caseItem.caseNumber || "Untitled Matter";
    if (index === 0) option.selected = true;
    select.appendChild(option);
  });
  select.disabled = false;
  if (elements.sendInviteBtn) elements.sendInviteBtn.disabled = false;
}

function openInviteModal() {
  if (!elements.inviteModal || !state.profileUser) return;
  if (!state.openCases.length) {
    showToast("You need an active Matter before inviting a paralegal.", "info");
    return;
  }
  clearFieldError(elements.inviteCaseSelect);
  renderCaseOptions();
  elements.inviteModal.classList.add("show");
  elements.inviteModal.setAttribute("aria-hidden", "false");
  elements.inviteModal.removeAttribute("inert");
  activateDialogFocus(elements.inviteModal, {
    initialFocus: elements.inviteCaseSelect,
    returnFocus: elements.inviteBtn,
    onEscape: closeInviteModal,
  });
}

async function handleHireForCase() {
  const caseId = state.applicantContext?.caseId || state.caseContextId || "";
  const paralegalId = state.profileUser?.id || state.profileUser?._id || state.paralegalId || "";
  if (!caseId || !paralegalId) {
    showToast("Unable to hire for this Matter.", "error");
    return;
  }
  const button = elements.inviteBtn;
  if (button) {
    button.classList.add("is-pressed");
    window.setTimeout(() => button.classList.remove("is-pressed"), 180);
  }
  const paymentReady = await hasDefaultPaymentMethod();
  if (!paymentReady) {
    showToast("Add a payment method to hire before hiring.", "error");
    return;
  }
  let caseDetails;
  try {
    caseDetails = await getCaseForHire(caseId);
  } catch (err) {
    showToast(err?.message || "Unable to load Matter details.", "error");
    return;
  }
  const amountCents = Number(caseDetails?.lockedTotalAmount ?? caseDetails?.totalAmount ?? 0);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    showToast("Payment amount is unavailable for this Matter.", "error");
    return;
  }
  const paralegalName = formatName(state.profileUser || {});
  openHireConfirmModal({
    paralegalName,
    amountCents,
    feePct: PLATFORM_FEE_PCT,
    existingPreEngagement:
      caseDetails?.preEngagement &&
      String(caseDetails.preEngagement.requestedParalegalId || "") === String(paralegalId || "") &&
      String(caseDetails.preEngagement.status || "").toLowerCase() === "requested"
        ? caseDetails.preEngagement
        : null,
    continueHref: `case-detail.html?caseId=${encodeURIComponent(caseId)}`,
    onSendPreEngagement: async ({ preEngagement } = {}) => {
      await savePreEngagementDraft(caseId, paralegalId, preEngagement);
    },
    onConfirm: async ({ preEngagement } = {}) => {
      const originalText = button?.textContent || "Hire";
      if (button) {
        button.textContent = "Processing...";
        button.setAttribute("disabled", "disabled");
      }
      try {
        void preEngagement;
        await hireParalegal(caseId, paralegalId);
      } finally {
        if (button) {
          button.removeAttribute("disabled");
          button.textContent = originalText;
        }
      }
    },
  });
}

async function hasDefaultPaymentMethod() {
  try {
    const res = await secureFetch("/api/payments/payment-method/default", {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return false;
    return Boolean(payload?.hasDefault || payload?.paymentMethod);
  } catch {
    return false;
  }
}

async function getCaseForHire(caseId) {
  const normalized = normalizeId(caseId);
  if (state.caseLookup.has(normalized)) return state.caseLookup.get(normalized);
  const res = await secureFetch(`/api/cases/${encodeURIComponent(normalized)}`, { headers: { Accept: "application/json" } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Unable to load Matter details.");
  }
  state.caseLookup.set(normalized, payload);
  return payload;
}

function formatHireErrorMessage(message) {
  if (!message || typeof message !== "string") return DEFAULT_HIRE_ERROR;
  const normalized = message.toLowerCase();
  if (normalized.includes("stripe") && normalized.includes("connect")) {
    return "This paralegal must connect Stripe before you can hire them.";
  }
  if (
    normalized.includes("stripe") &&
    (normalized.includes("onboard") || normalized.includes("onboarding") || normalized.includes("payout"))
  ) {
    return "This paralegal must complete Stripe onboarding before you can hire them.";
  }
  return message;
}

async function hireParalegal(caseId, paralegalId) {
  const res = await secureFetch(
    `/api/cases/${encodeURIComponent(caseId)}/hire/${encodeURIComponent(paralegalId)}`,
    { method: "POST", body: {} }
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || DEFAULT_HIRE_ERROR);
  return payload;
}

async function savePreEngagementDraft(caseId, paralegalId, preEngagement) {
  const formData = new FormData();
  formData.set(
    "confidentialityAgreementRequired",
    preEngagement?.confidentialityAgreementSelected ? "true" : "false"
  );
  formData.set(
    "conflictsCheckRequired",
    preEngagement?.conflictsCheckSelected ? "true" : "false"
  );
  formData.set("conflictsDetails", String(preEngagement?.conflictsDetails || ""));
  if (preEngagement?.confidentialityFile) {
    formData.append(
      "confidentialityFile",
      preEngagement.confidentialityFile,
      preEngagement.confidentialityFileName || preEngagement.confidentialityFile.name || "confidentiality-agreement"
    );
  }
  const res = await secureFetch(
    `/api/cases/${encodeURIComponent(caseId)}/pre-engagement/${encodeURIComponent(paralegalId)}/request`,
    { method: "POST", body: formData }
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Unable to save pre-engagement requirements.");
  }
  return payload;
}

function ensureHireModalStyles() {
  if (document.getElementById("hire-confirm-styles")) return;
  const style = document.createElement("style");
  style.id = "hire-confirm-styles";
  style.textContent = `
    .hire-confirm-overlay{position:fixed;inset:0;background:rgba(15,23,42,.4);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;visibility:hidden;transition:opacity .16s ease,visibility .16s ease}
    .hire-confirm-overlay.is-visible{opacity:1;visibility:visible}
    .hire-confirm-overlay.is-closing{pointer-events:none}
    .hire-confirm-modal{background:#fff;border:1px solid rgba(0,0,0,0.08);border-radius:18px;padding:28px;max-width:580px;width:min(94%,580px);box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:16px;font-family:'Cormorant Garamond',serif;font-weight:300;color:#1a1a1a;font-size:1.05rem;opacity:0;transform:translateY(10px) scale(.985);transition:opacity .16s ease,transform .16s ease}
    .hire-confirm-overlay.is-visible .hire-confirm-modal{opacity:1;transform:translateY(0) scale(1)}
    .hire-confirm-stage{transition:opacity .18s ease,transform .18s ease}
    .hire-confirm-stage.is-leaving,.hire-confirm-stage.is-entering{opacity:0;transform:translateY(8px)}
    .hire-confirm-modal button,
    .hire-confirm-modal a{font-family:'Cormorant Garamond',serif}
    .hire-confirm-modal .btn{font-family:'Sarabun',sans-serif;font-size:0.85rem;font-weight:300;padding:8px 16px;border:1px solid rgba(26,34,48,0.5);background:transparent;color:#1a1a1a;border-radius:999px;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .2s ease,color .2s ease,border-color .2s ease}
    .hire-confirm-modal .btn.secondary{background:#fff}
    .hire-confirm-modal .btn.primary{background:#1a2230;color:#fff;border-color:#1a2230}
    .hire-confirm-modal .btn:hover{background:rgba(26,34,48,0.06)}
    .hire-confirm-modal .btn.primary:hover{background:#0f172a;border-color:#0f172a}
    .hire-confirm-modal .btn:focus-visible{outline:2px solid #b6a47a;outline-offset:2px}
    .hire-confirm-modal .btn:disabled,
    .hire-confirm-modal .btn[aria-disabled="true"]{opacity:0.6;cursor:not-allowed}
    .hire-confirm-modal p{font-weight:300;color:#5f6670}
    .hire-confirm-title{font-weight:300;font-size:1.6rem;letter-spacing:0.01em;text-align:center}
    .hire-pre-helper{margin:0 0 16px;color:#5f6670;line-height:1.5}
    .hire-pre-options{display:grid;gap:10px;margin-bottom:14px}
    .hire-pre-option{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid rgba(0,0,0,0.08);border-radius:14px;background:#fff;cursor:pointer;transition:border-color .2s ease,background .2s ease,box-shadow .2s ease}
    .hire-pre-option:hover{border-color:rgba(182,164,122,.65);box-shadow:0 10px 24px rgba(15,23,42,.06)}
    .hire-pre-option.is-selected{border-color:rgba(182,164,122,.85);background:#faf7ef}
    .hire-pre-option input{margin-top:3px}
    .hire-pre-option-copy{display:grid;gap:2px}
    .hire-pre-option-copy strong{font-size:1rem;font-weight:400;color:#1a1a1a}
    .hire-pre-reveal{display:grid;gap:10px;margin-top:12px;padding:12px;border:1px solid rgba(0,0,0,0.08);border-radius:14px;background:#fbfbfa}
    .hire-pre-reveal label{font-size:0.9rem;font-weight:400;color:#1a1a1a}
    .hire-pre-upload{display:grid;gap:8px}
    .hire-pre-upload input[type="file"]{display:none}
    .hire-pre-upload-trigger{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border:1px solid rgba(26,34,48,0.18);border-radius:999px;background:#fff;color:#1a1a1a;font-weight:300;cursor:pointer;width:max-content}
    .hire-pre-upload-name{font-size:0.9rem;color:#5f6670}
    .hire-pre-reveal textarea{border:1px solid rgba(26,34,48,0.18);border-radius:12px;padding:10px;font:inherit;min-height:104px;resize:vertical;background:#fff;color:#1a1a1a}
    .hire-pre-reveal textarea.is-invalid{border-color:rgba(185,28,28,.45);background:rgba(254,242,242,.55)}
    .hire-pre-upload-trigger.is-invalid{border-color:rgba(185,28,28,.45);color:#991b1b;background:rgba(254,242,242,.55)}
    .hire-pre-field-help{font-size:0.85rem;color:#991b1b;margin-top:-2px}
    .hire-confirm-summary{border:1px solid rgba(0,0,0,0.08);border-radius:14px;padding:14px 18px;display:grid;gap:12px;background:#fff}
    .hire-confirm-row{display:flex;justify-content:space-between;gap:16px;align-items:baseline}
    .hire-confirm-row span{text-transform:uppercase;font-size:0.75rem;letter-spacing:0.08em;color:#5f6670;font-weight:300}
    .hire-confirm-row strong{font-size:1.3rem;font-weight:300;color:#1a1a1a}
    .hire-confirm-total strong{font-weight:400}
    .hire-confirm-help{display:flex;justify-content:flex-end;margin-top:-6px}
    .hire-confirm-info{width:40px;height:40px;border-radius:50%;border:1px solid rgba(0,0,0,0.08);background:#fff;color:#5f6670;font-size:0.8rem;font-weight: 200;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;position:relative;padding:0;transition:border-color .2s ease,color .2s ease,transform .15s ease}
    .hire-confirm-info:hover,
    .hire-confirm-info:focus-visible{border-color:#b6a47a;color:#1a1a1a;transform:translateY(-1px)}
    .hire-confirm-tooltip{position:absolute;right:0;bottom:calc(100% + 10px);width:min(320px,80vw);padding:12px 14px;border-radius:12px;background:#fff;border:1px solid rgba(0,0,0,0.08);box-shadow:0 18px 40px rgba(0,0,0,.18);font-size:0.9rem;line-height:1.5;color:#1a1a1a;opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;z-index:2}
    .hire-confirm-info:hover .hire-confirm-tooltip,
    .hire-confirm-info:focus-visible .hire-confirm-tooltip{opacity:1;pointer-events:auto;transform:translateY(0)}
    .hire-confirm-error{border:1px solid rgba(185,28,28,.4);background:rgba(254,242,242,.9);color:#991b1b;border-radius:10px;padding:8px 10px;font-size:0.9rem}
    .hire-confirm-success{border:1px solid rgba(22,163,74,.35);background:rgba(240,253,244,.9);color:#166534;border-radius:10px;padding:8px 10px;font-size:0.9rem}
    .hire-confirm-terms-link{color:var(--accent,#b6a47a);font-weight:600;text-decoration:none;transition:color .2s ease}
    .hire-confirm-terms-link:hover{color:#1a1a1a}
    .hire-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:4px;flex-wrap:wrap}
    .hire-confirm-actions[hidden]{display:none}
    @media (max-width:640px){.hire-confirm-info{width:44px;height:44px}}
    @media (prefers-reduced-motion: reduce){
      .hire-confirm-overlay,.hire-confirm-modal{transition:none}
    }
  `;
  document.head.appendChild(style);
}

function openHireConfirmModal({ paralegalName, amountCents, feePct, continueHref, onConfirm, onSendPreEngagement, existingPreEngagement = null }) {
  ensureHireModalStyles();
  const safeName = escapeHtml(paralegalName || "Paralegal");
  const feeNote =
    "Platform fees support LPC’s application and eligibility review, technology and Matter workspace, platform support, applicable Stripe processing costs, and other platform operations. Platform fees are not fees for legal services.";
  const feeRate = Number(feePct || 0);
  const feeCents = Math.max(0, Math.round(Number(amountCents || 0) * (feeRate / 100)));
  const totalCents = Math.max(0, Math.round(Number(amountCents || 0) + feeCents));
  const safeContinueHref = String(continueHref || "").trim();
  const continueActionMarkup = safeContinueHref
    ? `<div class="hire-confirm-actions" data-hire-continue hidden>
        <a class="btn primary" href="${escapeAttribute(safeContinueHref)}">Continue to Matter</a>
      </div>`
    : "";
  const normalizedExistingPreEngagement =
    existingPreEngagement &&
    typeof existingPreEngagement === "object" &&
    String(existingPreEngagement.status || "").toLowerCase() === "requested"
      ? {
          status: "requested",
          confidentialityAgreementRequired: !!existingPreEngagement.confidentialityAgreementRequired,
          conflictsCheckRequired: !!existingPreEngagement.conflictsCheckRequired,
          conflictsDetails: String(existingPreEngagement.conflictsDetails || ""),
          confidentialityDocument: existingPreEngagement.confidentialityDocument || null,
        }
      : null;
  const preEngagementState = {
    confidentialityAgreement: !!normalizedExistingPreEngagement?.confidentialityAgreementRequired,
    conflictsCheck: !!normalizedExistingPreEngagement?.conflictsCheckRequired,
    none: !normalizedExistingPreEngagement,
    confidentialityFile: null,
    fileName: String(normalizedExistingPreEngagement?.confidentialityDocument?.name || ""),
    conflictsDetails: String(normalizedExistingPreEngagement?.conflictsDetails || ""),
    confidentialityTouched: false,
    conflictsTouched: false,
    submitError: "",
    submitting: false,
  };
  const overlay = document.createElement("div");
  overlay.className = "hire-confirm-overlay";
  overlay.innerHTML = `
    <div class="hire-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="hireConfirmTitle">
      <div class="hire-confirm-stage" data-hire-stage></div>
    </div>
  `;
  const stageEl = overlay.querySelector("[data-hire-stage]");

  const close = () => {
    if (overlay.classList.contains("is-closing")) return;
    overlay.classList.add("is-closing");
    overlay.classList.remove("is-visible");
    overlay.setAttribute("inert", "");
    deactivateDialogFocus(overlay);
    const removeOverlay = () => {
      overlay.removeEventListener("transitionend", handleTransitionEnd);
      overlay.remove();
    };
    const handleTransitionEnd = (event) => {
      if (event.target === overlay) removeOverlay();
    };
    overlay.addEventListener("transitionend", handleTransitionEnd);
    window.setTimeout(removeOverlay, 200);
  };
  const canClose = () => {
    const successEl = stageEl?.querySelector("[data-hire-success]");
    if (successEl && !successEl.hidden) return true;
    const confirmBtn = stageEl?.querySelector("[data-hire-confirm]");
    if (!confirmBtn) return true;
    return !confirmBtn.disabled;
  };
  const buildPreEngagementDraft = () => {
    const hasRequirements = preEngagementState.confidentialityAgreement || preEngagementState.conflictsCheck;
    if (!hasRequirements || preEngagementState.none) return null;
    return {
      confidentialityAgreementSelected: !!preEngagementState.confidentialityAgreement,
      conflictsCheckSelected: !!preEngagementState.conflictsCheck,
      confidentialityFile: preEngagementState.confidentialityAgreement ? preEngagementState.confidentialityFile || null : null,
      confidentialityFileName: preEngagementState.confidentialityAgreement ? preEngagementState.fileName || "" : "",
      conflictsDetails: preEngagementState.conflictsCheck ? String(preEngagementState.conflictsDetails || "") : "",
    };
  };
  const getPreEngagementValidation = () => {
    const requiresConfidentiality = !!preEngagementState.confidentialityAgreement;
    const requiresConflicts = !!preEngagementState.conflictsCheck;
    const missingConfidentialityFile =
      requiresConfidentiality &&
      !preEngagementState.confidentialityFile &&
      !normalizedExistingPreEngagement?.confidentialityDocument?.key;
    const missingConflictsDetails =
      requiresConflicts && !String(preEngagementState.conflictsDetails || "").trim();
    return {
      missingConfidentialityFile,
      missingConflictsDetails,
      showConfidentialityError: missingConfidentialityFile && preEngagementState.confidentialityTouched,
      showConflictsError: missingConflictsDetails && preEngagementState.conflictsTouched,
      hasErrors: missingConfidentialityFile || missingConflictsDetails,
    };
  };
  const getPreEngagementPrimaryLabel = () => {
    if (preEngagementState.none || (!preEngagementState.confidentialityAgreement && !preEngagementState.conflictsCheck)) {
      return "Next: Fund and Hire";
    }
    return normalizedExistingPreEngagement ? "Update and resend" : `Send to ${safeName}`;
  };
  const renderPreEngagementStep = () => `
    ${(() => {
      const validation = getPreEngagementValidation();
      return `
    <div data-hire-step="pre-engagement">
      <div class="hire-confirm-title" id="hireConfirmTitle">Pre-Engagement</div>
      ${
        normalizedExistingPreEngagement
          ? `<div class="hire-confirm-success">Sent to <strong>${safeName}</strong>. Awaiting completion from the paralegal.</div>`
          : ""
      }
      <p class="hire-pre-helper">${
        normalizedExistingPreEngagement
          ? `Sent to <strong>${safeName}</strong>. Awaiting completion from the paralegal.`
          : "Before moving forward, you may require pre-engagement items for this paralegal."
      }</p>
      <div class="hire-pre-options">
        <label class="hire-pre-option${preEngagementState.confidentialityAgreement ? " is-selected" : ""}">
          <input type="checkbox" data-pre-option="confidentiality"${preEngagementState.confidentialityAgreement ? " checked" : ""}>
          <span class="hire-pre-option-copy">
            <strong>Confidentiality agreement</strong>
          </span>
        </label>
        <label class="hire-pre-option${preEngagementState.conflictsCheck ? " is-selected" : ""}">
          <input type="checkbox" data-pre-option="conflicts"${preEngagementState.conflictsCheck ? " checked" : ""}>
          <span class="hire-pre-option-copy">
            <strong>Conflicts check</strong>
          </span>
        </label>
        <label class="hire-pre-option${preEngagementState.none ? " is-selected" : ""}">
          <input type="checkbox" data-pre-option="none"${preEngagementState.none ? " checked" : ""}>
          <span class="hire-pre-option-copy">
            <strong>None</strong>
          </span>
        </label>
      </div>
      ${
        preEngagementState.confidentialityAgreement
          ? `
            <div class="hire-pre-reveal">
              <div class="hire-pre-upload">
                <label>Upload confidentiality agreement</label>
                <label class="hire-pre-upload-trigger${validation.showConfidentialityError ? " is-invalid" : ""}" for="hirePreConfidentialityUpload">Choose file</label>
                <input id="hirePreConfidentialityUpload" type="file" accept=".pdf,.doc,.docx" data-pre-confidentiality-upload>
                <div class="hire-pre-upload-name">${escapeHtml(preEngagementState.fileName || "No file selected")}</div>
                ${
                  validation.showConfidentialityError
                    ? `<div class="hire-pre-field-help">Upload a confidentiality agreement to continue.</div>`
                    : ""
                }
              </div>
            </div>
          `
          : ""
      }
      ${
        preEngagementState.conflictsCheck
          ? `
            <div class="hire-pre-reveal">
              <label for="hirePreConflictsDetails">Conflicts check details</label>
              <textarea id="hirePreConflictsDetails" class="${validation.showConflictsError ? "is-invalid" : ""}" data-pre-conflicts-details placeholder="Enter the names, parties, or details the paralegal should review for conflicts.">${escapeHtml(
                preEngagementState.conflictsDetails
              )}</textarea>
              ${
                validation.showConflictsError
                  ? `<div class="hire-pre-field-help">Enter conflicts check details to continue.</div>`
                  : ""
              }
            </div>
          `
          : ""
      }
      <div class="hire-confirm-error"${preEngagementState.submitError ? "" : " hidden"} data-pre-error>${escapeHtml(
        preEngagementState.submitError || ""
      )}</div>
      <div class="hire-confirm-actions">
        <button class="btn secondary" type="button" data-hire-cancel${preEngagementState.submitting ? " disabled aria-disabled=\"true\"" : ""}>Cancel</button>
        <button class="btn primary" type="button" data-pre-next${validation.hasErrors || preEngagementState.submitting ? " disabled aria-disabled=\"true\"" : ""}>${escapeHtml(
          preEngagementState.submitting ? "Sending..." : getPreEngagementPrimaryLabel()
        )}</button>
      </div>
    </div>
  `;})()}
  `;
  const renderFundHireStep = () => `
    <div data-hire-step="fund-hire">
      <div class="hire-confirm-title" id="hireConfirmTitle">Confirm &amp; Hire</div>
      <p>You’re about to hire <strong>${safeName}</strong>. Your payment will be processed through Stripe upon confirmation. You can review the <a class="hire-confirm-terms-link" href="terms.html#payments" target="_blank" rel="noopener">payment terms here</a>.</p>
      <div class="hire-confirm-summary">
        <div class="hire-confirm-row">
          <span>Matter amount</span>
          <strong>${escapeHtml(formatCurrency(amountCents))}</strong>
        </div>
        <div class="hire-confirm-row">
          <span>Platform fee (${feeRate}%)</span>
          <strong>${escapeHtml(formatCurrency(feeCents))}</strong>
        </div>
        <div class="hire-confirm-row hire-confirm-total">
          <span>Total charge</span>
          <strong>${escapeHtml(formatCurrency(totalCents))}</strong>
        </div>
      </div>
      <div class="hire-confirm-help">
        <button class="hire-confirm-info" type="button" aria-label="${escapeAttribute(feeNote)}">
          ?
          <span class="hire-confirm-tooltip" aria-hidden="true">${escapeHtml(feeNote)}</span>
        </button>
      </div>
      <div class="hire-confirm-error" data-hire-error hidden></div>
      <div class="hire-confirm-success" data-hire-success hidden>Matter funded. Work can begin.</div>
      ${continueActionMarkup}
      <div class="hire-confirm-actions" data-hire-actions>
        <button class="btn secondary" type="button" data-hire-back>Back</button>
        <button class="btn secondary" type="button" data-hire-cancel>Cancel</button>
        <button class="btn primary" type="button" data-hire-confirm>Confirm Hire</button>
      </div>
    </div>
  `;
  const renderPreEngagementSentStep = () => `
    <div data-hire-step="pre-engagement-sent">
      <div class="hire-confirm-title" id="hireConfirmTitle">${normalizedExistingPreEngagement ? "Pre-Engagement Updated" : "Pre-Engagement Sent"}</div>
      <p>${normalizedExistingPreEngagement ? `Updated pre-engagement requirements for <strong>${safeName}</strong> have been saved. Hiring and funding will continue after the paralegal completes the requested items and you review them.` : `Pre-engagement requirements for <strong>${safeName}</strong> have been sent. Hiring and funding will continue after the paralegal completes the requested items and you review them.`}</p>
      <div class="hire-confirm-success">${normalizedExistingPreEngagement ? "Pre-engagement requirements updated successfully." : "Pre-engagement requirements sent successfully."}</div>
      <div class="hire-confirm-actions">
        <button class="btn secondary" type="button" data-hire-close>Close</button>
      </div>
    </div>
  `;
  const transitionStage = (html, bindFn) => {
    if (!stageEl) return;
    stageEl.classList.add("is-leaving");
    window.setTimeout(() => {
      stageEl.innerHTML = html;
      bindFn?.();
      stageEl.classList.remove("is-leaving");
      stageEl.classList.add("is-entering");
      window.requestAnimationFrame(() => {
        stageEl.classList.remove("is-entering");
        stageEl.querySelector('input:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]')?.focus();
      });
    }, 140);
  };
  const bindCancel = () => {
    stageEl?.querySelector("[data-hire-cancel]")?.addEventListener("click", () => {
      if (canClose()) close();
    });
  };
  const bindPreEngagementSentStep = () => {
    stageEl?.querySelector("[data-hire-close]")?.addEventListener("click", () => {
      close();
    });
  };
  const bindPreEngagementStep = () => {
    bindCancel();
    stageEl?.querySelectorAll("[data-pre-option]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const option = event.target?.dataset?.preOption || "";
        const checked = !!event.target?.checked;
        if (option === "none") {
          preEngagementState.submitError = "";
          preEngagementState.none = checked || (!preEngagementState.confidentialityAgreement && !preEngagementState.conflictsCheck);
          if (preEngagementState.none) {
            preEngagementState.confidentialityAgreement = false;
            preEngagementState.conflictsCheck = false;
            preEngagementState.confidentialityFile = null;
            preEngagementState.fileName = "";
            preEngagementState.confidentialityTouched = false;
            preEngagementState.conflictsTouched = false;
          }
        } else if (option === "confidentiality") {
          preEngagementState.submitError = "";
          preEngagementState.confidentialityAgreement = checked;
          if (checked) preEngagementState.none = false;
          if (!checked) {
            preEngagementState.confidentialityFile = null;
            preEngagementState.fileName = "";
            preEngagementState.confidentialityTouched = false;
          }
        } else if (option === "conflicts") {
          preEngagementState.submitError = "";
          preEngagementState.conflictsCheck = checked;
          if (checked) preEngagementState.none = false;
          if (!checked) preEngagementState.conflictsTouched = false;
        }
        if (!preEngagementState.confidentialityAgreement && !preEngagementState.conflictsCheck) {
          preEngagementState.none = true;
        }
        transitionStage(renderPreEngagementStep(), bindPreEngagementStep);
      });
    });
    stageEl?.querySelector("[data-pre-confidentiality-upload]")?.addEventListener("click", () => {
      preEngagementState.confidentialityTouched = true;
    });
    stageEl?.querySelector("[data-pre-confidentiality-upload]")?.addEventListener("change", (event) => {
      const file = event.target?.files?.[0] || null;
      preEngagementState.confidentialityTouched = true;
      preEngagementState.submitError = "";
      preEngagementState.confidentialityFile = file;
      preEngagementState.fileName = file?.name || "";
      transitionStage(renderPreEngagementStep(), bindPreEngagementStep);
    });
    stageEl?.querySelector("[data-pre-conflicts-details]")?.addEventListener("blur", () => {
      preEngagementState.conflictsTouched = true;
      transitionStage(renderPreEngagementStep(), bindPreEngagementStep);
    });
    stageEl?.querySelector("[data-pre-conflicts-details]")?.addEventListener("input", (event) => {
      preEngagementState.conflictsTouched = true;
      preEngagementState.submitError = "";
      preEngagementState.conflictsDetails = event.target?.value || "";
    });
    stageEl?.querySelector("[data-pre-next]")?.addEventListener("click", async () => {
      const draft = buildPreEngagementDraft();
      if (draft) {
        preEngagementState.submitError = "";
        preEngagementState.submitting = true;
        transitionStage(renderPreEngagementStep(), bindPreEngagementStep);
        try {
          await onSendPreEngagement?.({ preEngagement: draft });
          transitionStage(renderPreEngagementSentStep(), bindPreEngagementSentStep);
        } catch (err) {
          preEngagementState.submitting = false;
          preEngagementState.submitError = formatHireErrorMessage(err?.message) || "Unable to save pre-engagement requirements.";
          transitionStage(renderPreEngagementStep(), bindPreEngagementStep);
        }
        return;
      }
      transitionStage(renderFundHireStep(), bindFundHireStep);
    });
  };
  const bindFundHireStep = () => {
    bindCancel();
    const errorEl = stageEl?.querySelector("[data-hire-error]");
    const successEl = stageEl?.querySelector("[data-hire-success]");
    const continueEl = stageEl?.querySelector("[data-hire-continue]");
    const confirmBtn = stageEl?.querySelector("[data-hire-confirm]");
    const cancelBtn = stageEl?.querySelector("[data-hire-cancel]");
    const backBtn = stageEl?.querySelector("[data-hire-back]");
    backBtn?.addEventListener("click", () => {
      if (confirmBtn?.disabled) return;
      transitionStage(renderPreEngagementStep(), bindPreEngagementStep);
    });
    const setLoading = (isLoading) => {
      if (confirmBtn) {
        confirmBtn.disabled = isLoading;
        confirmBtn.textContent = isLoading ? "Charging..." : "Confirm Hire";
      }
      if (cancelBtn) cancelBtn.disabled = isLoading;
      if (backBtn) backBtn.disabled = isLoading;
    };
    const showError = (message) => {
      if (!errorEl) return;
      if (!message) {
        errorEl.hidden = true;
        errorEl.textContent = "";
        return;
      }
      errorEl.textContent = message;
      errorEl.hidden = false;
    };
    const showSuccess = () => {
      if (successEl) successEl.hidden = false;
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Hired";
      }
      if (backBtn) backBtn.hidden = true;
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = "Close";
      }
      if (continueEl) continueEl.hidden = false;
    };
    confirmBtn?.addEventListener("click", async () => {
      showError("");
      setLoading(true);
      try {
        await onConfirm?.({ preEngagement: buildPreEngagementDraft() });
        showSuccess();
      } catch (err) {
        showError(formatHireErrorMessage(err?.message));
        setLoading(false);
      }
    });
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && canClose()) close();
  });
  document.body.appendChild(overlay);
  stageEl.innerHTML = renderPreEngagementStep();
  bindPreEngagementStep();
  activateDialogFocus(overlay, {
    initialFocus: stageEl.querySelector('input:not([disabled]), button:not([disabled])'),
    onEscape: () => {
      if (canClose()) close();
    },
  });
  window.requestAnimationFrame(() => overlay.classList.add("is-visible"));
}

function formatCurrency(amountCents = 0) {
  const dollars = Number(amountCents || 0) / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function closeInviteModal() {
  elements.inviteModal?.classList.remove("show");
  elements.inviteModal?.setAttribute("aria-hidden", "true");
  elements.inviteModal?.setAttribute("inert", "");
  clearFieldError(elements.inviteCaseSelect);
  deactivateDialogFocus(elements.inviteModal);
}

async function sendInviteToCase() {
  if (!state.profileUser || !elements.inviteCaseSelect) return;
  const caseId = elements.inviteCaseSelect.value;
  clearFieldError(elements.inviteCaseSelect);
  if (!caseId) {
    showFieldError(elements.inviteCaseSelect, "Select a Matter to continue.");
    showToast("Select a Matter to continue.", "info");
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
    void showAlert(message, { title: type === "error" ? "Action unavailable" : "Notice" });
  }
}
