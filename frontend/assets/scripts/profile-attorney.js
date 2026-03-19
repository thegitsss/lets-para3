import { secureFetch, requireAuth, persistSession } from "./auth.js";

const state = {
  viewer: null,
  profile: null,
  jobContextId: ""
};

const elements = {
  content: document.getElementById("profileContent"),
  error: document.getElementById("profileError"),
  editBtn: document.getElementById("editProfileBtn"),
  backLink: document.getElementById("profileBackLink"),
  name: document.getElementById("profileName"),
  subtitle: document.getElementById("profileSubtitle"),
  firm: document.getElementById("profileFirm"),
  location: document.getElementById("profileLocation"),
  heroLinkedIn: document.getElementById("heroLinkedIn"),
  heroWebsite: document.getElementById("heroWebsite"),
  practiceBio: document.getElementById("practiceBio"),
  contactLinkedIn: document.getElementById("contactLinkedIn"),
  contactWebsite: document.getElementById("contactWebsite"),
  practiceAreas: document.getElementById("practiceAreasList"),
  experience: document.getElementById("experienceList"),
  languages: document.getElementById("languagesList"),
  publications: document.getElementById("publicationsList"),
  avatar: document.getElementById("profileAvatar"),
  avatarShell: document.getElementById("avatarShell"),
  avatarFallback: document.getElementById("avatarFallback"),
  heroPhoto: document.querySelector(".hero-photo")
};

function hasProfileAccess(user = {}) {
  const role = String(user.role || "").toLowerCase();
  if (role === "admin") return true;
  const status = String(user.status || "").toLowerCase();
  return status === "approved";
}

function getProfileAttorneyParams() {
  const searchParams = new URLSearchParams(window.location.search);
  let id = (searchParams.get("id") || "").trim();
  let job = (searchParams.get("job") || "").trim();

  // Handle cases where params are placed in the hash (e.g., after client-side routing)
  if (!id && window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    id = (hashParams.get("id") || "").trim();
    if (!job) job = (hashParams.get("job") || "").trim();
  }

  // Basic path fallback: allow /profile-attorney.html/<id> style URLs.
  if (!id) {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const maybeId = parts[parts.length - 1];
    if (maybeId && !maybeId.toLowerCase().endsWith("profile-attorney.html")) {
      id = maybeId;
    }
  }

  return { id, job };
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const { id: profileAttorneyId, job: profileJobId } = getProfileAttorneyParams();
  const viewer = typeof window.getStoredUser === "function" ? window.getStoredUser() : null;

  state.viewer = viewer;
  state.jobContextId = profileJobId;

  bindEditButton();

  if (profileAttorneyId) {
    try {
      if (!state.viewer) {
        try {
          state.viewer = await loadViewer();
        } catch (_) {
          /* session hydration best-effort */
        }
      }
      const profileUser = await fetchProfileById(profileAttorneyId, profileJobId);
      const normalizedProfile = { ...(profileUser || {}) };
      normalizedProfile._id = normalizedProfile._id || profileAttorneyId;
      const viewerId = normalizeId(state.viewer);
      const isOwner = viewerId && viewerId === profileAttorneyId;
      if (!isRenderableProfile(normalizedProfile) && !isOwner) {
        console.warn("[profile-attorney] loaded profile lacks required fields", normalizedProfile);
        return showError("Unable to load this attorney right now.");
      }
      state.profile = normalizedProfile;
      updateBackLink();
      updateEditButtonVisibility(state.viewer, normalizedProfile);
      renderProfile(normalizedProfile);
      return; // Early return so no session-based logic runs
    } catch (err) {
      console.warn("[profile-attorney] profile load failed", err);
      const fallback = err?.message || "Unable to load this attorney right now.";
      return showError(fallback);
    }
  }

  // If no id is present, do not attempt to render a generic/self profile.
  showError("Unable to load this attorney right now.");
}

async function fetchProfileById(id, jobId = "") {
  try {
    const attorneyProfile = await loadAttorneyById(id, jobId);
    if (isRenderableProfile(attorneyProfile)) return attorneyProfile;
    const fallback = await loadAttorneyFallback(id);
    return { ...(fallback || {}), ...(attorneyProfile || {}) };
  } catch (err) {
    // Try fallback when primary fails (e.g., empty body or 404)
    try {
      const fallback = await loadAttorneyFallback(id);
      if (fallback) return fallback;
    } catch (_) {
      /* ignore secondary failure */
    }
    throw err;
  }
}

async function loadViewer() {
  if (typeof window.checkSession === "function") {
    try {
      const session = await window.checkSession();
      if (session?.user) return session.user;
      if (session) return session;
    } catch (err) {
      console.warn("[profile-attorney] checkSession failed", err);
    }
  }
  const session = requireAuth();
  if (session?.user) return session.user;
  throw new Error("Authentication required");
}

async function loadSelfProfile() {
  const res = await secureFetch("/api/users/me", {
    headers: { Accept: "application/json" },
    noRedirect: true
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Unable to load your profile.");
  const sessionUser = typeof window.getStoredUser === "function" ? window.getStoredUser() : null;
  if (!data.status && (state.viewer?.status || sessionUser?.status)) {
    data.status = state.viewer?.status || sessionUser?.status;
  }
  persistSession({ user: data });
  return data;
}

async function loadPublicAttorney(id) {
  let primary = {};
  try {
    const res = await secureFetch(`/api/users/attorneys/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      noRedirect: true
    });
    primary = await res.json().catch(() => ({}));
    if (res.ok && primary && !needsEnrichment(primary)) {
      return primary;
    }
  } catch (_) {
    /* ignore primary failure */
  }

  // Secondary try: plain fetch with cookies (in case secureFetch headers/session differ)
  try {
    const res = await fetch(`/api/users/attorneys/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      credentials: "include"
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data) {
      primary = Object.keys(primary || {}).length ? primary : data;
      if (!needsEnrichment(data)) return data;
    }
  } catch (_) {
    /* ignore */
  }

  // Secondary attempt: use /api/users/:id to capture any stored profile fields (works for paralegal IDs too).
  try {
    const resUser = await secureFetch(`/api/users/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      noRedirect: true
    });
    const userData = await resUser.json().catch(() => ({}));
    if (resUser.ok && userData) {
      const merged = { ...(userData || {}), ...(primary || {}) };
      if (Object.keys(merged).length) return merged;
    }
  } catch (_) {
    /* ignore user fallback failure */
  }

  // Final fallback: if the current session matches this id, use the self profile.
  try {
    const meRes = await secureFetch("/api/users/me", {
      headers: { Accept: "application/json" },
      noRedirect: true
    });
    const me = await meRes.json().catch(() => ({}));
    if (meRes.ok && normalizeId(me) === String(id)) {
      const mergedSelf = { ...(primary || {}), ...(me || {}) };
      if (Object.keys(mergedSelf || {}).length) return mergedSelf;
    }
  } catch (_) {
    /* ignore */
  }

  if (Object.keys(primary || {}).length) return primary;
  throw new Error("Unable to load this attorney profile.");
}

async function loadAttorneyById(id, jobId = "") {
  const safeId = encodeURIComponent(id);
  const jobParam = jobId ? `?job=${encodeURIComponent(jobId)}` : "";

  // Primary: use the endpoint known to work for paralegal browse flows.
  const primaryRes = await secureFetch(`/api/users/attorneys/${safeId}${jobParam}`, {
    headers: { Accept: "application/json" },
    noRedirect: true
  });
  const primaryData = await primaryRes.json().catch(() => ({}));
  if (primaryRes.ok) return primaryData || {};

  // Fallback: legacy /api/attorneys/:id
  const res = await secureFetch(`/api/attorneys/${safeId}${jobParam}`, {
    headers: { Accept: "application/json" },
    noRedirect: true
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error("Attorney profiles are private inside LPC. Ask this attorney to share updates directly.");
    }
    throw new Error(data?.error || "Unable to load this attorney profile.");
  }
  return data || {};
}

async function loadAttorneyFallback(id) {
  try {
    const res = await secureFetch(`/api/users/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      noRedirect: true
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
  } catch (_) {}
  return null;
}

function needsEnrichment(profile = {}) {
  const hasName = Boolean((profile.firstName || profile.lastName || profile.name || "").trim());
  const hasFirm = Boolean(
    (profile.lawFirm || profile.firmName || profile.company || profile.organization || "").trim()
  );
  const hasSummary = Boolean(
    (profile.practiceDescription || profile.practiceOverview || profile.bio || profile.about || "").trim()
  );
  const hasAvatar = Boolean(profile.profileImage || profile.avatarURL);
  return !(hasName && hasFirm && hasSummary && hasAvatar);
}

function isRenderableProfile(profile = {}) {
  const hasName = Boolean((profile.firstName || profile.lastName || profile.name || "").trim());
  const hasFirm = Boolean(
    (profile.lawFirm || profile.firmName || profile.company || profile.organization || "").trim()
  );
  const hasSummary = Boolean(
    (profile.practiceDescription || profile.practiceOverview || profile.bio || profile.about || "").trim()
  );
  const hasAvatar = Boolean(profile.profileImage || profile.avatarURL);
  return hasName || hasFirm || hasSummary || hasAvatar;
}

function renderProfile(profile) {
  if (!profile) return;
  elements.content?.classList.remove("hidden");
  elements.error?.classList.add("hidden");

  const fullName = formatName(profile);
  setText(elements.name, fullName, "Attorney");

  const summaryParts = [];
  const experienceLabel = describeExperience(profile.yearsExperience);
  if (experienceLabel) summaryParts.push(experienceLabel);
  const practicePreview = (profile.practiceAreas || profile.specialties || [])
    .filter(Boolean)
    .slice(0, 2)
    .join(" • ");
  if (practicePreview) summaryParts.push(practicePreview);
  const subtitle = summaryParts.join(" • ");
  setText(elements.subtitle, subtitle, "");
  if (elements.subtitle) {
    elements.subtitle.classList.toggle("hidden", !subtitle);
  }

  const firmCard = elements.firm?.closest(".contact-card");
  const firmValue = profile.lawFirm || profile.firmName || "";
  if (firmValue) {
    elements.firm.textContent = firmValue;
    elements.firm.classList.remove("muted");
    firmCard?.classList.remove("hidden");
  } else {
    if (elements.firm) elements.firm.textContent = "";
    firmCard?.classList.add("hidden");
  }

  const locationCard = elements.location?.closest(".contact-card");
  const locationValue = profile.location || "";
  if (locationValue) {
    elements.location.textContent = locationValue;
    elements.location.classList.remove("muted");
    locationCard?.classList.remove("hidden");
  } else {
    if (elements.location) elements.location.textContent = "";
    locationCard?.classList.add("hidden");
  }

  const linkedIn = sanitizeHttpUrl(profile.linkedInURL);
  const website = sanitizeHttpUrl(profile.firmWebsite || profile.website);
  setHeroLink(elements.heroLinkedIn, linkedIn, "LinkedIn");

  const summary = profile.practiceDescription || profile.bio || "";
  if (summary && elements.practiceBio) {
    elements.practiceBio.textContent = summary;
    elements.practiceBio.classList.remove("hidden");
    elements.practiceBio.closest(".bio")?.classList.remove("hidden");
  } else {
    if (elements.practiceBio) elements.practiceBio.textContent = "";
    elements.practiceBio?.closest(".bio")?.classList.add("hidden");
  }

  const hasLinkedIn = setLinkField(elements.contactLinkedIn, linkedIn, "View LinkedIn");
  const hasWebsite = setLinkField(elements.contactWebsite, website, "Firm site");
  const connectCard = elements.contactLinkedIn?.closest(".contact-card") || elements.contactWebsite?.closest(".contact-card");
  if (connectCard) {
    connectCard.classList.toggle("hidden", !hasLinkedIn && !hasWebsite);
  }
  const contactGrid = elements.firm?.closest(".contact-grid");
  if (contactGrid) {
    const cards = Array.from(contactGrid.querySelectorAll(".contact-card"));
    const hasVisible = cards.some((card) => !card.classList.contains("hidden"));
    contactGrid.classList.toggle("hidden", !hasVisible);
  }

  renderAvatar(fullName, profile.profileImage || profile.avatarURL);
  renderPracticeAreas(profile);
  renderExperience(profile.experience);
  renderLanguages(profile.languages);
  renderPublications(profile.publications);
  updateMetaGridVisibility();
  updateTabsVisibility();
}

function bindEditButton() {
  const btn = elements.editBtn;
  if (!btn || btn.dataset.bound === "true") return;
  btn.addEventListener("click", () => {
    window.location.href = "profile-settings.html";
  });
  btn.dataset.bound = "true";
}

function updateBackLink() {
  if (!elements.backLink) return;
  const role = String(state.viewer?.role || "").toLowerCase();
  if (role === "paralegal" && state.jobContextId) {
    elements.backLink.textContent = "← Back to browse";
    elements.backLink.href = "browse-jobs.html";
    return;
  }
  if (role === "paralegal") {
    elements.backLink.textContent = "← Back to dashboard";
    elements.backLink.href = "dashboard-paralegal.html";
    return;
  }
  if (role === "admin") {
    elements.backLink.textContent = "← Back to dashboard";
    elements.backLink.href = "admin-dashboard.html";
    return;
  }
  elements.backLink.textContent = "← Back to dashboard";
  elements.backLink.href = "dashboard-attorney.html";
}

function renderAvatar(name, src) {
  const initials = buildInitials(name);
  if (elements.avatarFallback) elements.avatarFallback.textContent = initials || "A";
  if (src) {
    elements.heroPhoto?.classList.remove("no-photo");
    elements.avatarShell?.classList.add("has-photo");
    if (elements.avatar) {
      elements.avatar.src = cacheBust(src);
      elements.avatar.alt = `${name} portrait`;
    }
  } else {
    elements.heroPhoto?.classList.add("no-photo");
    elements.avatarShell?.classList.remove("has-photo");
    if (elements.avatar) elements.avatar.removeAttribute("src");
  }
}

function renderPracticeAreas(profile) {
  const container = elements.practiceAreas;
  if (!container) return;
  container.textContent = "";
  const practiceCard = container.closest(".practice-card");
  const values = [
    ...(Array.isArray(profile.practiceAreas) ? profile.practiceAreas : []),
    ...(Array.isArray(profile.specialties) ? profile.specialties : [])
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  if (!unique.length) {
    practiceCard?.classList.add("hidden");
    return;
  }
  practiceCard?.classList.remove("hidden");
  unique.forEach((value) => {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = value;
    container.appendChild(pill);
  });
}

function renderExperience(entries = []) {
  const list = elements.experience;
  if (!list) return;
  list.textContent = "";
  if (!Array.isArray(entries) || !entries.length) {
    list.closest(".meta-card")?.classList.add("hidden");
    return;
  }
  list.closest(".meta-card")?.classList.remove("hidden");
  entries.slice(0, 5).forEach((entry) => {
    if (!entry) return;
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = entry.title || entry.role || "Experience";
    item.appendChild(title);
    if (entry.years) {
      const years = document.createElement("span");
      years.textContent = entry.years;
      item.appendChild(years);
    }
    if (entry.description) {
      const copy = document.createElement("p");
      copy.textContent = entry.description;
      copy.className = "muted";
      item.appendChild(copy);
    }
    list.appendChild(item);
  });
}

function renderLanguages(entries = []) {
  const container = elements.languages;
  if (!container) return;
  container.textContent = "";
  if (!Array.isArray(entries) || !entries.length) {
    container.closest(".meta-card")?.classList.add("hidden");
    return;
  }
  container.closest(".meta-card")?.classList.remove("hidden");
  entries.forEach((entry) => {
    if (!entry?.name) return;
    const pill = document.createElement("span");
    pill.className = "pill";
    const prof = entry.proficiency ? ` — ${entry.proficiency}` : "";
    pill.textContent = `${entry.name}${prof}`;
    container.appendChild(pill);
  });
}

function renderPublications(items = []) {
  const list = elements.publications;
  if (!list) return;
  list.textContent = "";
  if (!Array.isArray(items) || !items.length) {
    list.closest(".meta-card")?.classList.add("hidden");
    return;
  }
  list.closest(".meta-card")?.classList.remove("hidden");
  items.forEach((entry) => {
    if (!entry) return;
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = entry;
    item.appendChild(title);
    list.appendChild(item);
  });
}

function setText(el, value, fallback = "") {
  if (!el) return;
  const text = value && String(value).trim() ? value : fallback;
  el.textContent = text || fallback;
  el.classList.toggle("muted", !value);
}

function setHeroLink(el, url, label) {
  if (!el) return;
  if (url) {
    el.href = url;
    el.textContent = label;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function setLinkField(el, url, label) {
  if (!el) return;
  el.textContent = "";
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = label || url;
    link.className = "inline-link";
    el.classList.remove("muted");
    el.classList.remove("hidden");
    el.appendChild(link);
    return true;
  } else {
    el.classList.add("hidden");
    el.classList.remove("muted");
    return false;
  }
}

function showError(message) {
  if (elements.error) {
    elements.error.textContent = message;
    elements.error.classList.remove("hidden");
  }
  elements.content?.classList.add("hidden");
}

function updateEditButtonVisibility(viewer, profile) {
  const btn = elements.editBtn;
  if (!btn) return;
  const viewerRole = String(viewer?.role || "").toLowerCase();
  const viewerId = normalizeId(viewer);
  const profileId = normalizeId(profile);
  const canEdit = viewerRole === "attorney" && viewerId && profileId && viewerId === profileId;
  btn.classList.toggle("hidden", !canEdit);
  btn.disabled = !canEdit;
}

function buildPlaceholder(copy) {
  const span = document.createElement("span");
  span.className = "placeholder";
  span.textContent = copy;
  return span;
}

function updateMetaGridVisibility() {
  document.querySelectorAll(".meta-grid").forEach((grid) => {
    const cards = Array.from(grid.querySelectorAll(".meta-card"));
    const hasVisible = cards.some((card) => !card.classList.contains("hidden"));
    grid.classList.toggle("hidden", !hasVisible);
  });
}

function updateTabsVisibility() {
  const tabs = document.getElementById("profileTabs");
  if (!tabs) return;
  const hasPublications = Array.isArray(state.profile?.publications) && state.profile.publications.length > 0;
  tabs.classList.toggle("hidden", !hasPublications);
}

function formatName(user = {}) {
  const first = user.firstName || "";
  const last = user.lastName || "";
  const name = `${first} ${last}`.trim();
  return name || user.name || user.email || "Attorney";
}

function describeExperience(value) {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return "";
  if (value === 1) return "1 year of experience";
  return `${value} years of experience`;
}


function sanitizeHttpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value).trim());
    const protocol = url.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      return url.href;
    }
  } catch {}
  return "";
}

function buildInitials(name) {
  if (!name) return "A";
  const matches = name.trim().split(/\s+/).slice(0, 2);
  return matches.map((part) => part.charAt(0).toUpperCase()).join("") || "A";
}

function normalizeId(user) {
  if (!user) return "";
  return String(user._id || user.id || user.userId || "");
}

function cacheBust(url) {
  if (!url) return "";
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
}
