import { secureFetch, requireAuth, persistSession } from "./auth.js";

const state = {
  viewer: null,
  profile: null,
  targetId: "",
  viewingSelf: true
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
  avatar: document.getElementById("profileAvatar"),
  avatarShell: document.getElementById("avatarShell"),
  avatarFallback: document.getElementById("avatarFallback")
};

const PENDING_ACCESS_MESSAGE =
  "Your account is pending admin approval. Profiles open up once an administrator approves your access.";

function hasProfileAccess(user = {}) {
  const role = String(user.role || "").toLowerCase();
  if (role === "admin") return true;
  const status = String(user.status || "").toLowerCase();
  return status === "approved";
}

document.addEventListener("DOMContentLoaded", init);

function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    attorneyId: (params.get("id") || "").trim(),
    jobId: (params.get("job") || "").trim()
  };
}

async function init() {
  try {
    state.viewer = await loadViewer();
  } catch (err) {
    console.warn("[profile-attorney] viewer load failed", err);
    return showError("Please sign in to view attorney profiles.");
  }

  if (!hasProfileAccess(state.viewer)) {
    return showError(PENDING_ACCESS_MESSAGE);
  }

  const viewerId = normalizeId(state.viewer);
  const { attorneyId, jobId } = getQueryParams();
  state.targetId = attorneyId || viewerId;
  state.viewingSelf = !attorneyId || attorneyId === viewerId;
  state.jobContextId = jobId;
  updateBackLink();

  bindEditButton();

  try {
    state.profile = state.viewingSelf
      ? await loadSelfProfile()
      : await loadAttorneyById(state.targetId, jobId);
    renderProfile(state.profile);
  } catch (err) {
    console.warn("[profile-attorney] profile load failed", err);
    const fallback = err?.message || "Unable to load this attorney right now.";
    showError(fallback);
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

async function loadAttorneyById(id, jobId = "") {
  const safeId = encodeURIComponent(id);
  const jobParam = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
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
  return data;
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
  setText(elements.subtitle, summaryParts.join(" • "), "Share how you collaborate with paralegals.");

  setText(elements.firm, profile.lawFirm || profile.firmName || "Independent attorney", "Independent attorney");
  setText(elements.location, profile.location || formatTimezone(profile.timezone), "Location not provided");

  const linkedIn = cleanUrl(profile.linkedInURL);
  const website = cleanUrl(profile.firmWebsite || profile.website);
  setHeroLink(elements.heroLinkedIn, linkedIn, "LinkedIn");
  setHeroLink(elements.heroWebsite, website, "Firm Website");

  const summary = profile.practiceDescription || profile.bio ||
    "Keep this space updated so paralegals know what types of matters you collaborate on.";
  setText(elements.practiceBio, summary);

  setLinkField(elements.contactLinkedIn, linkedIn, "View LinkedIn");
  setLinkField(elements.contactWebsite, website, "Visit site");

  renderAvatar(fullName, profile.profileImage || profile.avatarURL);
  renderPracticeAreas(profile);
  renderExperience(profile.experience);
  renderLanguages(profile.languages);
}

function bindEditButton() {
  if (!elements.editBtn) return;
  if (!state.viewingSelf) {
    elements.editBtn.classList.add("hidden");
    return;
  }
  elements.editBtn.classList.remove("hidden");
  elements.editBtn.addEventListener("click", () => {
    window.location.href = "profile-settings.html";
  });
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
  elements.backLink.textContent = "← Back to dashboard";
  elements.backLink.href = "dashboard-attorney.html";
}

function renderAvatar(name, src) {
  const initials = buildInitials(name);
  if (elements.avatarFallback) elements.avatarFallback.textContent = initials || "A";
  if (src) {
    elements.avatarShell?.classList.add("has-photo");
    if (elements.avatar) {
      elements.avatar.src = cacheBust(src);
      elements.avatar.alt = `${name} portrait`;
    }
  } else {
    elements.avatarShell?.classList.remove("has-photo");
    if (elements.avatar) elements.avatar.removeAttribute("src");
  }
}

function renderPracticeAreas(profile) {
  const container = elements.practiceAreas;
  if (!container) return;
  container.textContent = "";
  const values = [
    ...(Array.isArray(profile.practiceAreas) ? profile.practiceAreas : []),
    ...(Array.isArray(profile.specialties) ? profile.specialties : [])
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  if (!unique.length) {
    container.appendChild(buildPlaceholder("Add your focus areas to stand out."));
    return;
  }
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
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "Share notable roles or cases to build trust.";
    list.appendChild(item);
    return;
  }
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
    container.appendChild(buildPlaceholder("Add languages you speak to streamline matches."));
    return;
  }
  entries.forEach((entry) => {
    if (!entry?.name) return;
    const pill = document.createElement("span");
    pill.className = "pill";
    const prof = entry.proficiency ? ` — ${entry.proficiency}` : "";
    pill.textContent = `${entry.name}${prof}`;
    container.appendChild(pill);
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
    el.appendChild(link);
  } else {
    el.textContent = "Not provided";
    el.classList.add("muted");
  }
}

function showError(message) {
  if (elements.error) {
    elements.error.textContent = message;
    elements.error.classList.remove("hidden");
  }
  elements.content?.classList.add("hidden");
}

function buildPlaceholder(copy) {
  const span = document.createElement("span");
  span.className = "placeholder";
  span.textContent = copy;
  return span;
}

function formatName(user = {}) {
  const first = user.firstName || "";
  const last = user.lastName || "";
  const name = `${first} ${last}`.trim();
  return name || user.email || "Attorney";
}

function describeExperience(value) {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return "";
  if (value === 1) return "1 year of experience";
  return `${value} years of experience`;
}

function formatTimezone(tz) {
  if (!tz) return "";
  return `Timezone: ${tz}`;
}

function cleanUrl(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
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
