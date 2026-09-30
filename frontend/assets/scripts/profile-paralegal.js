import { createSaveParalegal } from "./attorney-v2/saved-paralegals.mjs";
import { createApiClient } from "./attorney-v2/api-client.mjs";
import { createLegacyInvitationDialog } from "./utils/legacy-invitation-dialog.mjs";
import { createLegacyEngagementDialog } from "./utils/legacy-engagement-dialog.mjs";
let invitationDialog, engagementDialog;
import { secureFetch, requireAuth } from "./auth.js";
import { showAlert } from "./utils/dialogs.js";
import { normalizeHttpNavigationUrl, normalizeSameOriginPath } from "./utils/navigation-url.js";

const PLACEHOLDER_AVATAR = "/assets/avatar-placeholder.svg";
const MISSING_DOCUMENT_MESSAGE = "This document is no longer available for download.";

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
    if (!/^[a-f0-9]{24}$/i.test(caseId) || !/^[a-f0-9]{24}$/i.test(applicantId)) return null;
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

const state = {
  viewerUser: null, // logged-in user (session/local cache)
  viewerRole: "",
  viewerId: "",
  paralegalId: "",
  viewingSelf: false,
  profileUser: null, // the paralegal being displayed
  caseContextId: null,
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
    updateInviteButtonState();
    if (state.profileUser && elements.inviteBtn && !document.querySelector('[data-save-paralegal]')) {
      const controller = new AbortController();
      window.addEventListener('pagehide', () => controller.abort(), { once: true });
      const api = createApiClient({ onAuthenticationLost: () => { controller.abort(); window.location.reload(); } });
      elements.inviteBtn.parentElement.after(createSaveParalegal(state.paralegalId, { api, signal: controller.signal, ownerId: state.viewerId }));
    }
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
  // Keep stored bestFor entries; this retired section is no longer displayed.
  renderBestFor([]);
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
    message = "Photo pending review. Your profile is hidden from attorney discovery until the photo is approved.";
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
  const today = window.LPCBusinessDate?.today() || new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const nextExpired = nextDate && !Number.isNaN(nextDate.getTime()) && nextDate.toISOString().slice(0, 10) <= today;
  const message = nextExpired ? "Available now" : profile.availability || "Availability on request";
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
    closeInviteModal();
    return;
  }
  const isAttorney = state.viewerRole === "attorney";
  const applicantCaseId = state.applicantContext?.caseId || "";
  if (isAttorney && applicantCaseId) {
    elements.inviteBtn.textContent = "Review hire";
    elements.inviteBtn.dataset.mode = "hire";
    toggleElement(elements.inviteBtn, true);
    elements.inviteBtn.disabled = !state.profileUser;
    return;
  }
  const canReviewInvitation = isAttorney && Boolean(state.profileUser);
  elements.inviteBtn.textContent = "Invite to Matter";
  elements.inviteBtn.dataset.mode = "invite";
  toggleElement(elements.inviteBtn, canReviewInvitation);
  elements.inviteBtn.disabled = !canReviewInvitation;
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

function openInviteModal() {
  if (state.viewerRole !== "attorney" || !state.profileUser || state.blockedByProfileOwner) return;
  invitationDialog ||= createLegacyInvitationDialog({ ownerId: state.viewerId, request: secureFetch });
  invitationDialog.open({ paralegalId: String(state.profileUser.id || state.profileUser._id || state.paralegalId), name: formatName(state.profileUser), trigger: elements.inviteBtn });
}

function handleHireForCase() {
  const caseId = state.applicantContext?.caseId || state.caseContextId || '';
  const paralegalId = String(state.profileUser?.id || state.profileUser?._id || state.paralegalId || '');
  if (!/^[a-f0-9]{24}$/i.test(caseId) || !/^[a-f0-9]{24}$/i.test(paralegalId) || state.viewerRole !== 'attorney' || state.blockedByProfileOwner) return;
  engagementDialog ||= createLegacyEngagementDialog({ ownerId: state.viewerId, request: secureFetch });
  engagementDialog.open({ caseId, paralegalId, trigger: elements.inviteBtn });
}

function closeInviteModal() {
  invitationDialog?.dispose(); invitationDialog = null;
  engagementDialog?.dispose(); engagementDialog = null;
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

function showToast(message, type = "info") {
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else {
    void showAlert(message, { title: type === "error" ? "Action unavailable" : "Notice" });
  }
}
