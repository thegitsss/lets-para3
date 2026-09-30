import { clearSession } from "../auth.js";
import { createSecurityApi } from "./security-api.mjs";
import { createSecurityView } from "./security-view.mjs";
import { createBlockedView } from "./blocked-view.mjs";
import { createClosureView } from "./closure-view.mjs";
import { clearClosureProof } from "../utils/account-closure-state.mjs";
import { startStripeOnboarding } from "../utils/stripe-connect.js";

const PROFILE_SAVE_DELAY_MS = 850;
const PROFILE_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROFILE_FIELDS = Object.freeze([
  "firstName",
  "lastName",
  "email",
  "phoneNumber",
  "linkedInURL",
  "yearsExperience",
  "bio",
  "practiceAreas",
  "stateExperience",
  "skills",
  "bestFor",
  "experience",
  "education",
  "languages",
]);
const PROFILE_DRAFT_PREFIX = "lpc_v2_profile_draft_v1";
const FONT_SIZES = Object.freeze({ xs: "15px", sm: "16px", md: "17px", lg: "20px", xl: "22px" });
const PRACTICE_AREAS = Object.freeze([
  "Administrative Law", "Admiralty & Maritime Law", "Antitrust Law", "Appellate Law", "Banking Law",
  "Bankruptcy Law", "Business / Corporate Law", "Civil Rights Law", "Class Action Law", "Commercial Law",
  "Communications Law", "Construction Law", "Consumer Protection Law", "Contract Law", "Criminal Defense Law",
  "Education Law", "Elder Law", "Election Law", "Employment & Labor Law", "Energy Law", "Entertainment Law",
  "Environmental Law", "Estate Planning & Probate", "Family Law", "Franchise Law", "Government Contracts Law",
  "Health Care Law", "Immigration Law", "Insurance Law", "Intellectual Property (IP) Law", "International Law",
  "Land Use & Zoning Law", "Litigation", "Media Law", "Medical Malpractice", "Military Law", "Municipal Law",
  "Personal Injury Law", "Product Liability Law", "Real Estate Law", "Securities Law",
  "Social Security / Disability Law", "Sports Law", "Tax Law", "Technology Law", "Telecommunications Law",
  "Torts", "Transportation Law", "Trusts & Estates", "Estate Planning", "White Collar Crime",
  "Workers’ Compensation",
]);
const STATES = Object.freeze([
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"],
  ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
]);
const STATE_CODES = new Set(STATES.map(([code]) => code));
const STATE_NAME_TO_CODE = new Map(STATES.map(([code, name]) => [name.toLowerCase(), code]));
const PROFICIENCIES = Object.freeze(["Native", "Fluent", "Professional", "Conversational", "Basic"]);
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = value;
    else if (name === "value") element.value = value;
    else if (name === "checked") element.checked = Boolean(value);
    else if (name === "disabled") element.disabled = Boolean(value);
    else if (name === "hidden") element.hidden = Boolean(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  (Array.isArray(children) ? children : [children]).filter(Boolean).forEach((child) => {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}



function text(value, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function list(value, maximum = 50) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 500)).filter(Boolean))].slice(0, maximum);
}

function recordList(value, keys, maximum = 30) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).map((entry) => {
    const source = entry && typeof entry === "object" ? entry : {};
    return Object.fromEntries(keys.map((key) => [key, text(source[key], key === "description" ? 5000 : 1000)]));
  });
}

function normalizeExperienceEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((entry) => {
    if (typeof entry === "string") {
      return { title: "Paralegal", years: "", description: text(entry, 5000) };
    }
    const source = entry && typeof entry === "object" ? entry : {};
    return {
      title: text(source.title || (source.firm ? "Paralegal" : ""), 300),
      years: text(source.years || source.dates, 120),
      description: text(source.description || source.firm, 5000),
    };
  });
}

function normalizeEducationEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((entry) => {
    if (typeof entry === "string") {
      return { school: text(entry, 200), degree: "", fieldOfStudy: "", grade: "", activities: "", startMonth: "", startYear: "", endMonth: "", endYear: "" };
    }
    const source = entry && typeof entry === "object" ? entry : {};
    return {
      school: text(source.school || source.institution, 200),
      degree: text(source.degree || source.certification, 200),
      fieldOfStudy: text(source.fieldOfStudy || source.field, 200),
      grade: text(source.grade, 120),
      activities: text(source.activities || source.activitiesAndSocieties, 1000),
      startMonth: text(source.startMonth || source.beginMonth, 20),
      startYear: text(source.startYear || source.beginYear || source.year, 10),
      endMonth: text(source.endMonth || source.finishMonth, 20),
      endYear: text(source.endYear || source.finishYear, 10),
    };
  });
}

function formatDate(value) {
  if (!value) return "Unknown";
  const raw = typeof value === "string" ? value.trim() : value;
  const calendarDate = typeof raw === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const date = calendarDate
    ? new Date(Number(calendarDate[1]), Number(calendarDate[2]) - 1, Number(calendarDate[3]), 12)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}



function nameOf(user = {}) {
  return [user.firstName, user.lastName].map((part) => text(part, 150)).filter(Boolean).join(" ") || "Paralegal";
}

function initialsOf(user = {}) {
  return nameOf(user).split(/\s+/).map((part) => part[0]).join("").toUpperCase().slice(0, 2) || "P";
}

function photoOf(user = {}) {
  return text(user.pendingProfileImage || user.profileImage || user.avatarURL, 1000);
}

function previewAvailability(user = {}) {
  const details = user.availabilityDetails || {};
  const unavailable = String(details.status || "").toLowerCase() === "unavailable"
    || /unavailable/i.test(String(user.availability || ""));
  if (!unavailable) return "Available now";
  const next = details.nextAvailable ? formatDate(details.nextAvailable) : "";
  return next && next !== "Unknown" ? `Not available until ${next}` : "Not available";
}

function normalizedState(value) {
  const raw = text(value, 120);
  const upper = raw.toUpperCase();
  if (STATE_CODES.has(upper)) return upper;
  return STATE_NAME_TO_CODE.get(raw.toLowerCase()) || "";
}

function currentTheme(value) {
  return /dark$/i.test(String(value || "").trim()) ? "dark" : "light";
}

function field(label, control, { copy = "", className = "" } = {}) {
  if (control.matches("input, textarea, select") && !control.hasAttribute("aria-label")) control.setAttribute("aria-label", label);
  const wrapper = node("label", { className: `v2-settings-field ${className}`.trim() }, [
    node("span", { className: "v2-settings-field__label" }, [document.createTextNode(label), control.getAttribute("aria-required") === "true" ? node("small", { className: "v2-settings-required", "aria-hidden": "true", text: "Required" }) : null]),
    control,
  ]);
  if (copy) wrapper.append(node("span", { className: "v2-settings-field__copy", text: copy }));
  return wrapper;
}

function input(attributes = {}) {
  return node("input", { className: "v2-settings-input", ...attributes });
}

function textarea(attributes = {}) {
  return node("textarea", { className: "v2-settings-input v2-settings-textarea", ...attributes });
}

function select(options, attributes = {}) {
  const requestedValue = attributes.value;
  const control = node("select", { className: "v2-settings-input v2-settings-select", ...attributes, value: undefined }, options.map((option) => {
    const [value, label] = Array.isArray(option) ? option : [option, option];
    return node("option", { value, text: label });
  }));
  if (requestedValue !== undefined) control.value = requestedValue;
  return control;
}

function action(label, { className = "v2-settings-action", type = "button", ...attributes } = {}) {
  return node("button", { className, type, text: label, ...attributes });
}



function sectionHeader(title, copy = "", required = false) {
  return node("header", { className: "v2-settings-section-heading" }, [
    node("h2", { text: title }),
    required ? node("small", { className: "v2-settings-required", text: "Required" }) : null,
    copy ? node("p", { text: copy }) : null,
  ]);
}

function optionalDetails(title, children, { open = false, label = "" } = {}) {
  return node("details", { className: "v2-settings-optional", open }, [
    node("summary", label ? { "aria-label": label } : {}, [node("span", { text: title }), node("span", { className: "v2-settings-disclosure-mark", "aria-hidden": "true", text: "+" })]),
    node("div", { className: "v2-settings-optional-body" }, children),
  ]);
}

function settingsGroup(title, children, className = "") {
  return node("section", { className: `v2-settings-group ${className}`.trim() }, [
    node("h2", { className: "v2-settings-group-title", text: title }), ...children,
  ]);
}

// Keep section labels separate from their working controls without recreating
// inputs or their listeners. This also preserves drafts and focus targets.
function arrangeSettingsSections(panel) {
  panel.querySelectorAll('.v2-settings-card').forEach((card) => {
    const heading = card.querySelector(':scope > .v2-settings-section-heading');
    if (!heading || card.querySelector(':scope > .v2-settings-card-body')) return;
    const body = node('div', { className: 'v2-settings-card-body' });
    [...card.childNodes].filter(child => child !== heading).forEach(child => body.append(child));
    card.append(body);
  });
}

function updateSaveIndicator(indicator, copy, state = "saved") {
  if (!indicator) return;
  const description = copy;
  indicator.dataset.state = state;
  indicator.dataset.message = description;
  indicator.setAttribute("aria-label", description);
  indicator.textContent = description;
}

function saveIndicator(attributes = {}) {
  const indicator = node("span", { className: "v2-settings-save-status", role: "status", "aria-live": "polite", ...attributes });
  updateSaveIndicator(indicator, "Changes saved", "saved");
  return indicator;
}

function normalizeProfile(user = {}) {
  return {
    firstName: text(user.firstName, 150),
    lastName: text(user.lastName, 150),
    email: text(user.pendingEmail || user.email, 320),
    phoneNumber: text(user.phoneNumber, 40),
    linkedInURL: text(user.linkedInURL, 500),
    yearsExperience: Number.isFinite(Number(user.yearsExperience)) ? Math.max(0, Math.min(80, Number(user.yearsExperience))) : 0,
    bio: text(user.bio || user.about, 4000),
    practiceAreas: list(user.practiceAreas).length
      ? list(user.practiceAreas)
      : (list(user.specialties).length ? list(user.specialties) : list(user.preferredPracticeAreas)),
    stateExperience: (list(user.stateExperience).length ? list(user.stateExperience) : list(user.jurisdictions))
      .map(normalizedState)
      .filter(Boolean),
    skills: list(user.skills),
    bestFor: list(user.bestFor),
    experience: normalizeExperienceEntries(user.experience),
    education: normalizeEducationEntries(user.education),
    languages: (Array.isArray(user.languages) ? user.languages : []).slice(0, 30).map((entry) => typeof entry === "string"
      ? { name: text(entry, 120), proficiency: "" }
      : { name: text(entry?.name || entry?.language, 120), proficiency: text(entry?.proficiency || entry?.level, 120) }),
  };
}

function normalizeLinkedIn(value) {
  const raw = text(value, 500);
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error("Enter a valid LinkedIn URL."); }
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || (host !== "linkedin.com" && !host.endsWith(".linkedin.com"))) {
    throw new Error("Enter a valid LinkedIn URL.");
  }
  return url.toString();
}

function profilePayload(profile) {
  if (!text(profile.firstName, 150) || !text(profile.lastName, 150)) {
    throw Object.assign(new Error("First and last name are required."), { field: !text(profile.firstName, 150) ? "firstName" : "lastName" });
  }
  if (!/^\S+@\S+\.\S+$/.test(text(profile.email, 320))) throw Object.assign(new Error("Enter a valid email address."), { field: "email" });
  let linkedInURL;
  try { linkedInURL = normalizeLinkedIn(profile.linkedInURL); }
  catch (error) { error.field = "linkedInURL"; throw error; }
  return {
    firstName: text(profile.firstName, 150),
    lastName: text(profile.lastName, 150),
    email: text(profile.email, 320),
    phoneNumber: text(profile.phoneNumber, 40),
    linkedInURL,
    yearsExperience: Math.max(0, Math.min(80, Number(profile.yearsExperience) || 0)),
    bio: text(profile.bio, 4000),
    practiceAreas: list(profile.practiceAreas),
    stateExperience: list(profile.stateExperience).map(normalizedState).filter(Boolean),
    highlightedSkills: list(profile.skills),
    skills: list(profile.skills),
    bestFor: list(profile.bestFor),
    experience: recordList(profile.experience, ["title", "years", "description"]).filter((entry) => Object.values(entry).some(Boolean)),
    education: recordList(profile.education, ["school", "degree", "fieldOfStudy", "grade", "activities", "startMonth", "startYear", "endMonth", "endYear"]).filter((entry) => Object.values(entry).some(Boolean)),
    languages: recordList(profile.languages, ["name", "proficiency"]).filter((entry) => entry.name),
  };
}

function readiness(user, profile) {
  const missing = [];
  if (!text(profile.bio)) missing.push("Bio");
  if (!list(profile.skills).length) missing.push("Skills");
  if (!list(profile.practiceAreas).length) missing.push("Practice areas");
  if (!profileDocumentValue(user, "resumeURL")) missing.push("Résumé");
  if (!photoOf(user)) missing.push("Profile photo");
  return missing;
}

function profileDocumentValue(user = {}, key = "") {
  if (key === "resumeURL") return text(user.resumeURL || user.resumeKey, 1000);
  if (key === "certificateURL") return text(user.certificateURL || user.certificateKey, 1000);
  if (key === "writingSampleURL") return text(user.writingSampleURL || user.writingSampleKey, 1000);
  return text(user[key], 1000);
}

function routeLink(label, path, className = "v2-settings-action") {
  return node("a", {
    className,
    href: `paralegal-v2.html#${path}`,
    "data-view": path,
    "data-v2-route": "",
    text: label,
  });
}

function createLoadingView() {
  return node("section", { className: "v2-settings v2-settings-loading", "aria-label": "Loading Profile Settings" }, [
    node("div", { className: "v2-settings-loading__line" }),
    node("div", { className: "v2-settings-loading__tabs" }),
    node("div", { className: "v2-settings-loading__panel" }),
  ]);
}

export function createSettingsView({ api, getIdentity, showToast, updateIdentity, invalidateHome, invalidateBrowse, invalidateWork, onReplayTour, onSessionLost, onClosurePending }) {
  let user = null;
  let preferences = null;
  let root = null;
  let tabLayoutObserver = null;
  let corePromise = null;
  let coreInvalidated = false;
  let interactionRevision = 0;
  let profile = null;
  let profileRevision = 0;
  let profileSavedRevision = 0;
  let profileSaveTimer = null;
  let profileSavePromise = null;
  const dirtyProfileFields = new Map();
  const dirtyProfileBaselines = new Map();
  let profileStatus = null;
  let profileFeedback = { copy: "Changes saved", state: "saved" };
  let primaryStateFeedback = { copy: "Changes saved", state: "saved" };
  let profileSaveButton = null;
  let readinessNode = null;
  let recoveryNode = null;
  let preferenceQueue = Promise.resolve();
  let preferencePendingCount = 0;
  let securityLoaded = false;
  let securityPromise = null;
  let securityPanel = null;
  let securityController = null;
  let securityApi = null;
  let signInSecurity = null;
  let blockedSettings = null;
  let closureSettings = null;
  const closureAccountState = {};
  const securityAccountState = {};
  let profilePanel = null;
  let preferencesPanel = null;
  let beforeUnloadBound = false;
  const renderers = new Map();
  const documentStates = new Map();
  const documentWindows = new Set();
  const hasPendingDocuments = () => [...documentStates.values()].some(state => state.busy || state.attempt);

  let accountGeneration = 0;
  let unresolvedProfileSave = null;
  let profileConflict = null;
  let accountStopped = false;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const ownerOf = value => String(value?._id || value?.id || "");
  const accountRequests = new Set();

  async function accountTransport(path, options = {}, { image = false } = {}) {
    const controller = new AbortController(); accountRequests.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try { return await (image ? api.blob(path, { ...options, signal: controller.signal }) : api.request(path, { ...options, signal: controller.signal })); }
    finally { window.clearTimeout(timeout); accountRequests.delete(controller); }
  }

  function accountContext() {
    const ownerId = ownerOf(user) || ownerOf(getIdentity?.());
    if (accountStopped || !/^[a-f\d]{24}$/i.test(ownerId)) throw new Error("Verify your signed-in account before continuing.");
    return { ownerId, generation: accountGeneration };
  }

  function assertAccount(context) {
    const identity = getIdentity?.();
    if (accountStopped || context.generation !== accountGeneration || (identity && ownerOf(identity) !== context.ownerId)) {
      throw Object.assign(new Error("Your signed-in account changed. Reopen Settings for the current account."), { kind: "authentication" });
    }
  }

  async function verifyAccount(context) {
    assertAccount(context);
    const session = await accountTransport("/api/auth/me");
    assertAccount(context);
    const identity = session?.user || session;
    if (ownerOf(identity) !== context.ownerId || identity.role !== "paralegal" || identity.status !== "approved") {
      clearAccountDrafts();
      throw Object.assign(new Error("Your signed-in account changed. Reopen Settings for the current account."), { kind: "authentication" });
    }
  }

  function acceptAccountProfile(value, context) {
    assertAccount(context);
    if (!value || ownerOf(value) !== context.ownerId || !/^[a-f\d]{64}$/.test(value.profilePhotoRevision || "")) {
      throw new Error("The saved account could not be verified. Check the saved values before trying again.");
    }
    return value;
  }

  async function readAccountProfile(context = accountContext()) {
    const value = await accountTransport(`/api/users/me?expectedOwnerId=${encodeURIComponent(context.ownerId)}`);
    await verifyAccount(context);
    return acceptAccountProfile(value, context);
  }

  async function writeAccount(path, method, values, context = accountContext()) {
    await verifyAccount(context);
    const body = values instanceof FormData ? values : { ...values, expectedOwnerId: context.ownerId };
    if (body instanceof FormData) body.set("expectedOwnerId", context.ownerId);
    const result = await accountTransport(path, { method, body: body instanceof FormData ? body : JSON.stringify(body) });
    await verifyAccount(context);
    return result;
  }

  function expectedProfileValues(payload, snapshot = user) {
    const result = Object.fromEntries(Object.keys(payload).map(key => [key, clone(snapshot[key])]));
    if (Object.hasOwn(payload, "email")) result.pendingEmail = snapshot.pendingEmail || "";
    if (Object.hasOwn(payload, "bio")) result.about = snapshot.about || "";
    if (Object.hasOwn(payload, "practiceAreas")) result.specialties = clone(snapshot.specialties || []);
    if (Object.hasOwn(payload, "stateExperience")) result.jurisdictions = clone(snapshot.jurisdictions || []);
    return result;
  }

  function profileValuesMatch(snapshot, payload) {
    return Object.entries(payload).every(([key, value]) => {
      if (key === "email") return text(snapshot.pendingEmail || snapshot.email, 320).toLowerCase() === text(value, 320).toLowerCase();
      if (key === "linkedInURL") return (snapshot[key] || null) === (value || null);
      return equal(snapshot[key], value);
    });
  }

  function applyProfileSnapshot(updated, attempt) {
    acceptAccountProfile(updated, attempt.context);
    user = updated;
    documentStates.forEach((state, field) => { if (state.changed) user[field] = user[field.replace("URL", "Key")] = state.savedKey; });
    attempt.fields.forEach((revision, field) => {
      if ((dirtyProfileFields.get(field) || 0) <= revision) { dirtyProfileFields.delete(field); dirtyProfileBaselines.delete(field); }
      else {
        const committed = { ...updated, ...attempt.payload };
        if (Object.hasOwn(attempt.payload, "bio")) committed.about = attempt.payload.bio;
        if (Object.hasOwn(attempt.payload, "practiceAreas")) committed.specialties = attempt.payload.practiceAreas;
        if (Object.hasOwn(attempt.payload, "stateExperience")) committed.jurisdictions = attempt.payload.stateExperience;
        dirtyProfileBaselines.set(field, expectedProfileValues({ [field]: attempt.payload[field] }, committed));
      }
    });
    const normalized = normalizeProfile(user);
    dirtyProfileFields.forEach((_revision, field) => { normalized[field] = profile[field]; });
    // Empty entry editors are local drafts even before the first character is typed.
    // Append them to authoritative rows without discarding unrelated remote edits.
    for (const field of ["experience", "education", "languages"]) {
      if (!dirtyProfileFields.has(field)) {
        const emptyDrafts = profile[field].filter(entry => Object.values(entry).every(value => !String(value || "").trim()));
        normalized[field] = [...normalized[field], ...emptyDrafts];
      }
    }
    const previousProfile = profile;
    profile = normalized;
    profilePanel?.querySelectorAll("[data-profile-field]").forEach(control => {
      const field = control.dataset.profileField;
      if (!dirtyProfileFields.has(field) && PROFILE_FIELDS.includes(field) && !Array.isArray(profile[field])) control.value = profile[field] ?? "";
    });
    for (const field of ["practiceAreas", "stateExperience", "skills", "experience", "education", "languages"]) if (!dirtyProfileFields.has(field) && !equal(previousProfile[field], profile[field])) renderers.get(field)?.();
    profileSavedRevision = attempt.revision;
    unresolvedProfileSave = null;
    profileConflict = null;
    if (!dirtyProfileFields.size) { profileSavedRevision = profileRevision; clearDraft(); }
    else persistDraft();
    setProfileStatus(dirtyProfileFields.size ? "Saving newer changes…" : user.pendingEmail ? "Saved · check your inbox to confirm the new email" : "Changes saved", dirtyProfileFields.size ? "saving" : "saved");
    renderers.get("emailNotice")?.(); renderers.get("photo")?.();
    updateIdentity?.(user); invalidateHome?.(); invalidateBrowse?.(); updateReadiness();
  }

  function reviewProfileConflict() {
    if (!profileConflict || accountStopped) return;
    const latest = profileConflict;
    const context = accountContext();
    const dialog = dialogShell({ title: "Review profile changes", copy: "These fields changed in another session. Choose which values to keep." });
    const latestProfile = normalizeProfile(latest);
    dirtyProfileFields.forEach((_revision, field) => {
      const labels = { practiceAreas: "Practice areas", stateExperience: "State experience", skills: "Skills", experience: "Experience", education: "Education", languages: "Languages", bestFor: "Preferred work" };
      const label = profilePanel?.querySelector(`[data-profile-field="${field}"]`)?.getAttribute("aria-label") || labels[field] || field;
      const format = value => Array.isArray(value)
        ? value.map(entry => entry && typeof entry === "object" ? Object.values(entry).filter(Boolean).join(" · ") : String(entry)).filter(Boolean).join("; ") || "Empty"
        : String(value ?? "") || "Empty";
      dialog.append(node("section", {}, [node("h3", { text: label }), node("p", { text: `Saved: ${format(latestProfile[field])}` }), node("p", { text: `Your draft: ${format(profile[field])}` })]));
    });
    const useLatest = action("Use saved values", { className: "v2-settings-secondary" });
    const keep = action("Save my changes", { className: "v2-settings-primary" });
    const cancel = action("Cancel", { className: "v2-settings-secondary" });
    cancel.addEventListener("click", () => dialog.close("cancel"));
    useLatest.addEventListener("click", async () => {
      try { await verifyAccount(context); } catch (error) { if (!accountStopped) showToast?.(error.message); return; }
      assertAccount(context); user = latest; profile = normalizeProfile(latest); dirtyProfileFields.clear(); dirtyProfileBaselines.clear(); profileSavedRevision = profileRevision;
      profileConflict = null; unresolvedProfileSave = null; clearDraft(); dialog.close("latest"); rebuildProfilePanel(); setProfileStatus("Changes saved", "saved"); updateIdentity?.(user);
    });
    keep.addEventListener("click", async () => {
      try { await verifyAccount(context); } catch (error) { if (!accountStopped) showToast?.(error.message); return; }
      assertAccount(context); user = latest;
      dirtyProfileFields.forEach((_revision, field) => dirtyProfileBaselines.set(field, expectedProfileValues({ [field]: profile[field] }, latest)));
      profileConflict = null; unresolvedProfileSave = null; dialog.close("keep"); void saveProfile();
    });
    dialog.append(node("div", { className: "v2-settings-dialog-actions" }, [cancel, useLatest, keep])); dialog.showModal(); useLatest.focus();
  }

  async function recoverProfileSave(attempt, originalError) {
    try {
      const latest = await readAccountProfile(attempt.context);
      if (profileValuesMatch(latest, attempt.payload)) { applyProfileSnapshot(latest, attempt); return true; }
      unresolvedProfileSave = null;
      const untouched = Object.entries(attempt.expectedValues).every(([key, value]) => equal(latest[key], value));
      if (untouched) {
        user = latest;
        const reason = originalError?.name === "AbortError" ? "The profile save timed out." : originalError?.message;
        setProfileStatus(reason ? `${reason} Your edits are retained. Try again.` : "Your edits weren’t saved. Try again.", "error");
      } else {
        profileConflict = latest;
        setProfileStatus("This profile changed in another session. Review the saved values.", "error");
        setProfileAction("Review saved values");
      }
      return false;
    } catch (error) {
      if (attempt.context.generation !== accountGeneration || accountStopped) return false;
      unresolvedProfileSave = attempt;
      setProfileStatus("Save status is unknown. Check saved values before trying again.", "error");
      setProfileAction("Check saved values");
      return false;
    }
  }

  function draftKey() {
    const id = text(user?._id || user?.id || user?.email, 320).toLowerCase();
    return id ? `${PROFILE_DRAFT_PREFIX}:${id}` : "";
  }

  function clearDraft() {
    const key = draftKey();
    if (!key) return;
    try { sessionStorage.removeItem(key); } catch {}
  }

  function persistDraft() {
    const key = draftKey();
    if (!key || !profile) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({
        savedAt: Date.now(),
        serverUpdatedAt: String(user?.updatedAt || ""),
        fields: [...dirtyProfileFields.keys()], baselines: Object.fromEntries(dirtyProfileBaselines),
        profile,
      }));
    } catch {}
  }

  function readDraft() {
    const key = draftKey();
    if (!key) return null;
    try {
      const parsed = JSON.parse(sessionStorage.getItem(key) || "null");
      const age = Date.now() - Number(parsed?.savedAt || 0);
      if (!parsed?.profile || age < 0 || age > PROFILE_DRAFT_MAX_AGE_MS) {
        clearDraft();
        return null;
      }
      return parsed;
    } catch {
      clearDraft();
      return null;
    }
  }

  async function loadCore({ force = false } = {}) {
    if (!force && !coreInvalidated && user && preferences) return { user, preferences };
    if (corePromise) return corePromise;
    corePromise = (async () => {
      const context = accountContext();
      const priorUser = user;
      const startingInteraction = interactionRevision;
      const [userResult, preferenceResult] = await Promise.allSettled([
        readAccountProfile(context),
        accountTransport(`/api/account/preferences?expectedOwnerId=${encodeURIComponent(context.ownerId)}`),
      ]);
      assertAccount(context);
      if (userResult.status !== "fulfilled") throw userResult.reason;
      // Focus starts an edit before its first input event. Keep that control
      // mounted when a background read completes between focus and typing.
      const focusedField = root?.contains(document.activeElement)
        && document.activeElement.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (root && (focusedField || startingInteraction !== interactionRevision || user !== priorUser || hasPendingSettings())) return { user, preferences };
      if (root) resetView();
      coreInvalidated = false;
      user = userResult.value || {};
      preferences = preferenceResult.status === "fulfilled"
        ? preferenceResult.value || {}
        : {
            email: user.notificationPrefs?.email !== false,
            theme: currentTheme(user.preferences?.theme),
            fontSize: user.preferences?.fontSize || "md",
            hideProfile: user.preferences?.hideProfile === true,
            state: user.state || user.location || "",
          };
      profile = normalizeProfile(user);
      updateIdentity?.(user);
      return { user, preferences };
    })().finally(() => { corePromise = null; });
    return corePromise;
  }

  function refreshProfileFeedback() {
    const primaryError = primaryStateFeedback.state === "error";
    const pending = primaryError ? [profileFeedback] : [profileFeedback, primaryStateFeedback];
    const current = pending.find(item => item.state === "error")
      || pending.find(item => item.state === "saving")
      || pending.find(item => item.state === "dirty")
      || profileFeedback;
    updateSaveIndicator(profileStatus, current.copy, current.state);
    if (profileStatus) profileStatus.hidden = localProfileError(current) || (hasPendingDocuments() || primaryError) && ["saved", "idle"].includes(current.state);
  }

  function localProfileError(feedback) {
    return feedback.state === "error" && [...(profilePanel?.querySelectorAll('.v2-settings-field-error') || [])].some(error => error.textContent === feedback.copy);
  }

  function setPrimaryStateStatus(copy, state) {
    primaryStateFeedback = { copy, state };
    refreshProfileFeedback();
  }

  function setProfileAction(label) {
    if (!profileSaveButton) return;
    profileSaveButton.textContent = label === "Save changes" ? "↻" : label;
    profileSaveButton.setAttribute("aria-label", label === "Save changes" ? "Save now" : label);
    profileSaveButton.title = label;
  }

  function setProfileStatus(copy, state = "idle") {
    profileFeedback = { copy, state };
    refreshProfileFeedback();
    if (profileSaveButton) {
      profileSaveButton.hidden = state === "saved" || state === "idle" || localProfileError(profileFeedback);
      profileSaveButton.disabled = state === "saving";
    }
  }

  function updateReadiness() {
    if (!readinessNode || !profile) return;
    const missing = readiness(user || {}, profile);
    readinessNode.hidden = missing.length === 0;
    readinessNode.replaceChildren();
    if (!missing.length) return;
    const copy = node("div", {}, [
      node("strong", { text: `${missing.length} required ${missing.length === 1 ? "item remains" : "items remain"}` }),
      node("span", { text: missing.join(" · ") }),
    ]);
    const review = action("Review", { className: "v2-settings-text-action" });
    review.addEventListener("click", () => {
      const section = missing[0] === "Résumé" ? "résumé" : missing[0].toLowerCase().replace(/[^a-z]+/g, "-");
      const target = profilePanel?.querySelector(`[data-profile-section="${section}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.querySelector("input:not([hidden]):not(:disabled), textarea:not([hidden]):not(:disabled), select:not([hidden]):not(:disabled), button:not([hidden]):not(:disabled)")?.focus({ preventScroll: true });
    });
    readinessNode.append(copy, review);
  }

  function updateCollectionRenderer(name) {
    renderers.get(name)?.();
    markProfileChanged(name);
  }

  function markProfileChanged(field = "") {
    profileRevision += 1;
    const fields = PROFILE_FIELDS.includes(field) ? [field] : PROFILE_FIELDS;
    fields.forEach(key => {
      if (!dirtyProfileBaselines.has(key)) dirtyProfileBaselines.set(key, expectedProfileValues({ [key]: profile[key] }));
      dirtyProfileFields.set(key, profileRevision);
    });
    persistDraft();
    updateReadiness();
    setProfileStatus("Unsaved changes", "dirty");
    window.clearTimeout(profileSaveTimer);
    if (!unresolvedProfileSave && !profileConflict) profileSaveTimer = window.setTimeout(() => void saveProfile(), PROFILE_SAVE_DELAY_MS);
  }

  async function saveProfile() {
    window.clearTimeout(profileSaveTimer); profileSaveTimer = null;
    if (accountStopped) return false;
    if (profileSavePromise) return profileSavePromise;
    if (profileConflict) { reviewProfileConflict(); return false; }
    if (unresolvedProfileSave) {
      const attempt = unresolvedProfileSave;
      profileSavePromise = recoverProfileSave(attempt).then(committed => {
        if (committed && dirtyProfileFields.size) profileSaveTimer = window.setTimeout(() => void saveProfile(), PROFILE_SAVE_DELAY_MS);
        return committed;
      }).finally(() => { if (attempt.context.generation === accountGeneration) profileSavePromise = null; });
      return profileSavePromise;
    }
    if (profileSavedRevision === profileRevision) return true;
    let completePayload;
    try { completePayload = profilePayload(profile); }
    catch (error) { showProfileFieldError(error.field, error.message); setProfileStatus(error.message, "error"); return false; }
    const fields = new Map(dirtyProfileFields);
    const payload = Object.fromEntries([...fields.keys()].map(field => [field, completePayload[field]]));
    if (!fields.size) { profileSavedRevision = profileRevision; clearDraft(); setProfileStatus("Changes saved", "saved"); return true; }
    const attempt = { context: accountContext(), revision: profileRevision, fields, payload, expectedValues: Object.assign({}, ...[...fields.keys()].map(field => dirtyProfileBaselines.get(field) || expectedProfileValues({ [field]: payload[field] }))) };
    unresolvedProfileSave = attempt;
    setProfileAction("Save changes");
    setProfileStatus("Saving…", "saving");
    let committed = false;
    profileSavePromise = (async () => {
      try {
        const updated = await writeAccount("/api/users/me", "PATCH", { ...payload, expectedValues: attempt.expectedValues }, attempt.context);
        applyProfileSnapshot(updated, attempt); committed = true; return true;
      } catch (error) {
        if (attempt.context.generation !== accountGeneration || accountStopped) return false;
        committed = await recoverProfileSave(attempt, error); return committed;
      } finally {
        if (attempt.context.generation === accountGeneration) {
          profileSavePromise = null;
          if (committed && dirtyProfileFields.size && !profileConflict && !unresolvedProfileSave) profileSaveTimer = window.setTimeout(() => void saveProfile(), PROFILE_SAVE_DELAY_MS);
        }
      }
    })();
    return profileSavePromise;
  }

  function showProfileFieldError(key, message) {
    const control = profilePanel?.querySelector(`[data-profile-field="${key}"]`);
    if (!control) return;
    const wrapper = control.closest(".v2-settings-field");
    if (!wrapper) return;
    let error = wrapper.querySelector(".v2-settings-field-error");
    if (!error) {
      error = node("span", { className: "v2-settings-field-error", id: `v2-settings-error-${key}`, role: "status" });
      wrapper.append(error);
    }
    error.textContent = message;
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", error.id);
    for (let parent = wrapper.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === "DETAILS") parent.open = true;
    }
  }

  function bindProfileInput(control, key, transform = (value) => value) {
    control.dataset.profileField = key;
    if (["firstName", "lastName", "email"].includes(key)) control.setAttribute("aria-required", "true");
    control.addEventListener("input", () => {
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-describedby");
      control.closest(".v2-settings-field")?.querySelector(".v2-settings-field-error")?.remove();
      profile[key] = transform(control.value);
      markProfileChanged(key);
    });
    control.addEventListener("blur", () => {
      if (profileSavedRevision !== profileRevision) void saveProfile();
    });
    return control;
  }

  function tokenEditor({ key, label, copy, placeholder, options = [], normalize = (value) => text(value, 200), section = "", maximum = 50 }) {
    const wrapper = node("section", { className: "v2-settings-card", "data-profile-section": section || key }, [
      sectionHeader(label, copy, ["skills", "practiceAreas"].includes(key)),
    ]);
    const chips = node("div", { className: "v2-settings-chips", "aria-live": "polite" });
    const entry = options.length
      ? select([["", "Choose…"], ...options.map((item) => [item, item])], { "aria-label": placeholder })
      : input({ type: "text", placeholder, "aria-label": placeholder, autocomplete: "off" });
    const add = action("Add", { className: "v2-settings-secondary" });
    const controls = node("div", { className: "v2-settings-token-entry" }, [entry, add]);
    const render = () => {
      chips.replaceChildren(...list(profile[key]).map((value) => {
        const remove = action(`Remove ${value}`, { className: "v2-settings-chip-remove", "aria-label": `Remove ${value}` });
        remove.append(node("span", { "aria-hidden": "true", text: "×" }));
        remove.addEventListener("click", () => {
          profile[key] = list(profile[key]).filter((item) => item !== value);
          updateCollectionRenderer(key);
        });
        return node("span", { className: "v2-settings-chip" }, [node("span", { text: value }), remove]);
      }));
      chips.classList.toggle("is-empty", !profile[key]?.length);
    };
    const addValue = () => {
      const value = normalize(entry.value);
      if (!value || list(profile[key]).includes(value)) return;
      if (list(profile[key]).length >= maximum) {
        showToast?.(`You can list up to ${maximum} ${label.toLowerCase()}.`);
        return;
      }
      profile[key] = [...list(profile[key]), value];
      entry.value = "";
      updateCollectionRenderer(key);
      entry.focus();
    };
    add.addEventListener("click", addValue);
    entry.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== ",") return;
      event.preventDefault();
      addValue();
    });
    renderers.set(key, render);
    render();
    wrapper.append(chips, controls);
    return wrapper;
  }

  function profileIdentityCard() {
    const summaryReview = node("small");
    const refreshSummary = () => {
      const status = text(user.profilePhotoStatus, 40).toLowerCase();
      summaryReview.textContent = status === "pending_review"
        ? "Attorneys can’t find your profile until your photo is approved."
        : status === "rejected" ? "A new photo is required"
          : "Updating your photo hides your profile from attorneys until it’s approved.";
    };
    refreshSummary();
    const image = node("img", { alt: "", src: photoOf(user) || "/assets/avatar-placeholder.svg" });
    image.addEventListener("error", () => { image.src = "/assets/avatar-placeholder.svg"; });
    const initials = node("span", { text: initialsOf(user) });
    const photoButton = node("button", {
      className: "v2-settings-photo",
      type: "button",
      "aria-label": photoOf(user) ? "Open profile photo actions" : "Add profile photo",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    }, [image, initials, node("span", { className: "v2-settings-photo__hint", text: "Photo" })]);
    image.hidden = !photoOf(user);
    initials.hidden = Boolean(photoOf(user));

    const fileInput = input({ type: "file", accept: ".jpg,.jpeg,.png,image/jpeg,image/png", hidden: true, "aria-label": "Choose profile photo" });
    const menu = node("div", { className: "v2-settings-photo-menu", role: "menu", hidden: true }, [
      action(photoOf(user) ? "Change photo" : "Add photo", { className: "v2-settings-menu-action", role: "menuitem", "data-photo-change": "" }),
      action("Edit crop", { className: "v2-settings-menu-action", role: "menuitem", hidden: !photoOf(user), "data-photo-edit": "" }),
      action("Remove photo", { className: "v2-settings-menu-action v2-settings-menu-action--danger", role: "menuitem", hidden: !photoOf(user), "data-photo-remove": "" }),
    ]);
    const photoWrap = node("div", { className: "v2-settings-photo-wrap" }, [photoButton, fileInput, menu]);
    const refreshPhoto = () => {
      refreshSummary();
      const url = photoOf(user);
      image.hidden = !url;
      initials.hidden = Boolean(url);
      if (url) image.src = url;
      initials.textContent = initialsOf(user);
      photoButton.setAttribute("aria-label", url ? "Open profile photo actions" : "Add profile photo");
      menu.querySelector("[data-photo-change]").textContent = url ? "Change photo" : "Add photo";
      menu.querySelector("[data-photo-edit]").hidden = !url;
      menu.querySelector("[data-photo-remove]").hidden = !url;
      renderers.get("visibilityControl")?.();
    };
    renderers.set("photo", refreshPhoto);

    function closePhotoMenu({ restoreFocus = false } = {}) {
      menu.hidden = true;
      photoButton.setAttribute("aria-expanded", "false");
      if (restoreFocus) photoButton.focus();
    }
    photoButton.addEventListener("click", () => {
      if (!photoOf(user)) {
        fileInput.click();
        return;
      }
      const open = menu.hidden;
      menu.hidden = !open;
      photoButton.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("button:not([hidden])")?.focus();
    });
    menu.querySelector("[data-photo-change]").addEventListener("click", () => {
      closePhotoMenu();
      fileInput.click();
    });
    menu.querySelector("[data-photo-edit]").addEventListener("click", () => {
      closePhotoMenu();
      void editExistingPhoto(photoButton);
    });
    menu.querySelector("[data-photo-remove]").addEventListener("click", async () => {
      closePhotoMenu();
      const context = accountContext();
      const expectedPhotoRevision = user.profilePhotoRevision;
      const confirmed = await confirmAction({
        title: "Remove profile photo?",
        launcher: photoButton,
        copy: "This removes your profile photo throughout LPC.",
        confirmLabel: "Remove photo",
        danger: true,
      });
      if (!confirmed) return;
      try {
        const updated = await writeAccount("/api/users/me", "PATCH", { avatarURL: "", expectedPhotoRevision, expectedValues: {} }, context);
        user = acceptAccountProfile(updated, context);
        renderers.get("photo")?.();
        updateReadiness();
        updateIdentity?.(user);
        invalidateHome?.();
        invalidateBrowse?.();
        showToast?.("Profile photo removed.");
      } catch (error) {
        if (accountStopped) return;
        try {
          user = await readAccountProfile(context);
          renderers.get("photo")?.(); updateReadiness(); updateIdentity?.(user);
          showToast?.(photoOf(user) ? "The photo changed or could not be removed. Review the saved photo before removing it." : "Profile photo removed.");
        } catch {
          photoButton.disabled = true;
          showToast?.("Removal status is unknown. Reload Settings to check the saved photo before trying again.");
        }
      }
    });
    fileInput.addEventListener("change", () => {
      const selected = fileInput.files?.[0];
      fileInput.value = "";
      if (selected) void openPhotoEditor(selected, { editExisting: false, returnFocus: photoButton });
    });
    document.addEventListener("click", (event) => {
      if (!photoWrap.isConnected || menu.hidden || photoWrap.contains(event.target)) return;
      closePhotoMenu();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePhotoMenu({ restoreFocus: true });
    });

    return node("aside", { className: "v2-settings-identity-card", "data-profile-section": "profile-photo" }, [
      photoWrap,
      node("div", { className: "v2-settings-identity-copy" }, [
        summaryReview,
      ]),
      routeLink("View profile", "/profile/me", "v2-settings-secondary"),
    ]);
  }

  function basicProfileCard() {
    const first = bindProfileInput(input({ type: "text", value: profile.firstName, autocomplete: "given-name", maxlength: "150" }), "firstName", (value) => text(value, 150));
    const last = bindProfileInput(input({ type: "text", value: profile.lastName, autocomplete: "family-name", maxlength: "150" }), "lastName", (value) => text(value, 150));
    const email = bindProfileInput(input({ type: "email", value: profile.email, autocomplete: "email", maxlength: "320" }), "email", (value) => text(value, 320));
    const emailField = field("Email", email);
    const emailNotice = node("span", { className: "v2-settings-field__copy", "aria-live": "polite" });
    const refreshEmailNotice = () => {
      emailNotice.textContent = user.pendingEmail
        ? `Verify ${text(user.pendingEmail, 320)}. Until then, sign in with ${text(user.email, 320)}.`
        : email.value.trim() !== text(user.email, 320) ? "Verify your new email before using it to sign in." : "";
      emailNotice.hidden = !emailNotice.textContent;
    };
    emailField.append(emailNotice);
    email.addEventListener("input", refreshEmailNotice);
    renderers.set("emailNotice", refreshEmailNotice);
    refreshEmailNotice();
    const phone = bindProfileInput(input({ type: "tel", value: profile.phoneNumber, autocomplete: "tel", maxlength: "40" }), "phoneNumber", (value) => text(value, 40));
    const linkedIn = bindProfileInput(input({ type: "url", value: profile.linkedInURL, autocomplete: "url", maxlength: "500", placeholder: "linkedin.com/in/your-name" }), "linkedInURL", (value) => text(value, 500));
    return node("section", { className: "v2-settings-card v2-settings-card--identity" }, [
      sectionHeader("Personal details"),
      node("div", { className: "v2-settings-field-grid v2-settings-personal-fields" }, [
        field("First name", first), field("Last name", last), emailField,
        field("Phone", phone),
      ]),
      optionalDetails("LinkedIn", [field("Profile URL", linkedIn)], { open: Boolean(profile.linkedInURL) }),
    ]);
  }

  function bioCard() {
    const control = bindProfileInput(textarea({ rows: "4", maxlength: "4000", value: profile.bio, "aria-label": "Bio" }), "bio", (value) => String(value || "").slice(0, 4000));
    const counter = node("span", { className: "v2-settings-counter", text: `${profile.bio.length} / 4000` });
    control.addEventListener("input", () => { counter.textContent = `${control.value.length} / 4000`; });
    return node("section", { className: "v2-settings-card", "data-profile-section": "bio" }, [
      sectionHeader("About you", "", true),
      control,
      counter,
    ]);
  }

  function repeaterCard({ key, title, copy, addLabel, createEntry, renderEntry, fields }) {
    const section = node("section", { className: "v2-settings-card", "data-profile-section": key }, [sectionHeader(title, copy)]);
    const rows = node("div", { className: "v2-settings-repeater" });
    const add = action(addLabel, { className: "v2-settings-text-action" });
    let openEntries = new Set();
    const render = () => {
      rows.replaceChildren();
      profile[key].forEach((entry, index) => {
        const row = node("details", { className: "v2-settings-repeater-row", open: openEntries.has(index) });
        const name = node("strong");
        const subtitle = node("span", { className: "v2-settings-entry-subtitle" });
        const summary = node("summary", {}, [node("span", { className: "v2-settings-entry-copy" }, [name, subtitle]), node("span", { className: "v2-settings-entry-edit", "aria-hidden": "true", text: "Edit" })]);
        const refreshSummary = () => {
          const current = profile[key][index] || entry;
          name.textContent = current.title || current.school || current.name || `New ${title.toLowerCase()}`;
          subtitle.textContent = key === "experience" ? current.years || "" : key === "education" ? [current.degree, current.fieldOfStudy].filter(Boolean).join(" · ") : current.proficiency || "";
          subtitle.hidden = !subtitle.textContent;
        };
        const remove = action("Delete", { className: "v2-settings-text-action v2-settings-text-action--danger", "aria-label": `Delete ${title.toLowerCase()} entry ${index + 1}` });
        remove.addEventListener("click", () => {
          profile[key].splice(index, 1);
          openEntries = new Set([...openEntries].filter(value => value !== index).map(value => value > index ? value - 1 : value));
          updateCollectionRenderer(key);
          (rows.children[Math.min(index, rows.children.length - 1)]?.querySelector("summary") || add).focus();
        });
        const editor = renderEntry(entry, index);
        editor.querySelectorAll("input, textarea, select").forEach((control, fieldIndex) => {
          const fieldName = fields[fieldIndex];
          const update = () => {
            if (fieldName && profile[key][index]) profile[key][index][fieldName] = control.value;
            refreshSummary();
            markProfileChanged(key);
          };
          control.addEventListener("input", update);
          control.addEventListener("change", update);
          control.addEventListener("blur", () => { if (profileSavedRevision !== profileRevision) void saveProfile(); });
        });
        if (key === "education") {
          const labels = [...editor.children];
          const extras = [labels[3], labels[8]];
          labels[2].classList.add("v2-settings-field--wide");
          editor.append(
            node("div", { className: "v2-settings-date-pair" }, [labels[4], labels[5]]),
            node("div", { className: "v2-settings-date-pair" }, [labels[6], labels[7]]),
            optionalDetails("Additional details", extras, { open: Boolean(entry.grade || entry.activities) }),
          );
        }
        const done = action("Done", { className: "v2-settings-secondary" });
        done.addEventListener("click", () => { row.open = false; summary.focus(); });
        row.addEventListener("toggle", () => {
          if (!row.isConnected) return;
          if (row.open) openEntries.add(index); else openEntries.delete(index);
        });
        row.append(summary, node("div", { className: "v2-settings-entry-editor" }, [editor, node("div", { className: "v2-settings-entry-actions" }, [remove, done])]));
        refreshSummary();
        rows.append(row);
      });
    };
    renderers.set(key, render);
    add.addEventListener("click", () => {
      openEntries.add(profile[key].length);
      profile[key].push(createEntry());
      render();
      rows.lastElementChild?.querySelector("input, textarea, select")?.focus();
    });
    render();
    section.append(rows, add);
    return section;
  }

  function experienceCard() {
    return repeaterCard({
      key: "experience",
      title: "Experience",
      copy: "",
      addLabel: "Add experience",
      emptyCopy: "No experience entries yet.",
      createEntry: () => ({ title: "", years: "", description: "" }),
      fields: ["title", "years", "description"],
      renderEntry: (entry) => node("div", { className: "v2-settings-field-grid" }, [
        field("Role or firm", input({ type: "text", value: entry.title, maxlength: "300" })),
        field("Dates", input({ type: "text", value: entry.years, maxlength: "120", placeholder: "2022–present" }), { className: "v2-settings-field--dates" }),
        field("Description", textarea({ rows: "4", value: entry.description, maxlength: "5000" }), { className: "v2-settings-field--wide" }),
      ]),
    });
  }

  function educationCard() {
    return repeaterCard({
      key: "education",
      title: "Education",
      copy: "",
      addLabel: "Add education",
      emptyCopy: "No education entries yet.",
      createEntry: () => ({ school: "", degree: "", fieldOfStudy: "", grade: "", activities: "", startMonth: "", startYear: "", endMonth: "", endYear: "" }),
      fields: ["school", "degree", "fieldOfStudy", "grade", "startMonth", "startYear", "endMonth", "endYear", "activities"],
      renderEntry: (entry) => node("div", { className: "v2-settings-field-grid" }, [
        field("School", input({ type: "text", value: entry.school, maxlength: "200" })),
        field("Degree", input({ type: "text", value: entry.degree, maxlength: "200" })),
        field("Field of study", input({ type: "text", value: entry.fieldOfStudy, maxlength: "200" })),
        field("Grade", input({ type: "text", value: entry.grade, maxlength: "120" })),
        field("Start month", select([["", "Choose…"], ...MONTHS.map((item) => [item, item])], { value: entry.startMonth })),
        field("Start year", input({ type: "text", value: entry.startYear, maxlength: "10", inputmode: "numeric" })),
        field("End month", select([["", "Choose…"], ...MONTHS.map((item) => [item, item])], { value: entry.endMonth })),
        field("End year", input({ type: "text", value: entry.endYear, maxlength: "10", inputmode: "numeric" })),
        field("Activities", textarea({ rows: "3", value: entry.activities, maxlength: "1000" }), { className: "v2-settings-field--wide" }),
      ]),
    });
  }

  function languageCard() {
    return repeaterCard({
      key: "languages",
      title: "Language",
      copy: "",
      addLabel: "Add language",
      emptyCopy: "No languages added yet.",
      createEntry: () => ({ name: "", proficiency: "" }),
      fields: ["name", "proficiency"],
      renderEntry: (entry) => node("div", { className: "v2-settings-field-grid" }, [
        field("Language", input({ type: "text", value: entry.name, maxlength: "120" })),
        field("Proficiency", select([["", "Choose…"], ...PROFICIENCIES.map((item) => [item, item])], { value: entry.proficiency })),
      ]),
    });
  }

  function documentReadUrl(field, key, endpoint = "download") {
    const context = accountContext();
    const query = new URLSearchParams({ key, expectedOwnerId: context.ownerId, documentField: field, expectedDocumentKey: key });
    return `/api/uploads/${endpoint}?${query}`;
  }

  function documentsCard() {
    const section = node("section", { className: "v2-settings-card", "data-profile-section": "résumé" }, [
      sectionHeader("Documents", "PDFs are visible only to people with access to your profile."),
    ]);
    const documents = [
      { key: "resumeURL", label: "Résumé", endpoint: "/api/uploads/paralegal-resume" },
      { key: "certificateURL", label: "Certificate", endpoint: "/api/uploads/paralegal-certificate" },
      { key: "writingSampleURL", label: "Writing sample", endpoint: "/api/uploads/paralegal-writing-sample" },
    ];
    documents.forEach(({ key, label, endpoint }) => {
      const state = documentStates.get(key) || { busy: false, attempt: null, savedKey: profileDocumentValue(user, key), changed: false, needsRead: false, review: false, retryLabel: "Check saved document", message: "", outcome: "" };
      if (!state.busy && !state.attempt) {
        const latestKey = profileDocumentValue(user, key);
        if (state.savedKey !== latestKey && state.message) { state.message = latestKey ? "Saved document updated." : "Saved document removed."; state.outcome = "saved"; }
        state.savedKey = latestKey;
      }
      documentStates.set(key, state);
      const status = node("span", { className: "v2-settings-document-status", role: "status", "aria-live": "polite" });
      const file = input({ type: "file", accept: "application/pdf,.pdf", hidden: true, "aria-label": `Choose ${label} PDF` });
      const upload = action("Upload PDF", { className: "v2-settings-secondary" });
      const open = action("Open", { className: "v2-settings-text-action", "aria-label": `Open ${label}` });
      const download = action("Download", { className: "v2-settings-text-action", "aria-label": `Download ${label}` });
      const remove = action("Remove", { className: "v2-settings-text-action v2-settings-text-action--danger", "aria-label": `Remove ${label}` });
      const retry = action("Check saved document", { className: "v2-settings-text-action", hidden: true });
      const keep = action("Use saved document", { className: "v2-settings-text-action", hidden: true });
      const refresh = () => state.render?.();
      state.render = () => {
        status.textContent = state.message;
        retry.textContent = state.retryLabel || "Check saved document";
        refreshProfileFeedback();
        if (state.outcome) status.dataset.state = state.outcome;
        const value = state.savedKey;
        upload.textContent = value ? "Replace" : "Upload PDF";
        upload.disabled = file.disabled = state.busy || Boolean(state.attempt);
        open.hidden = download.hidden = remove.hidden = !value;
        open.disabled = download.disabled = state.busy || state.needsRead;
        remove.disabled = state.busy || Boolean(state.attempt);
        retry.hidden = !state.attempt || !state.review; retry.disabled = keep.disabled = state.busy;
        keep.hidden = !state.attempt || !state.review || state.needsRead;
      };
      const message = (copy, outcome = "error") => { state.message = copy; state.outcome = outcome; refresh(); };
      const accept = (latest, context) => {
        acceptAccountProfile(latest, context);
        state.savedKey = profileDocumentValue(latest, key); state.changed = true;
        user = { ...(user || latest), [key]: state.savedKey, [key.replace("URL", "Key")]: state.savedKey };
        updateReadiness(); invalidateHome?.(); invalidateBrowse?.();
      };
      const finish = (copy) => { state.attempt = null; state.needsRead = false; state.review = false; refresh(); message(copy, "saved"); };
      const recover = async (failure = null) => {
        const attempt = state.attempt;
        if (!attempt || accountStopped) return;
        state.review = true; state.needsRead = true; refresh();
        try {
          const latest = await readAccountProfile(attempt.context); accept(latest, attempt.context); state.needsRead = false;
          if (attempt.kind === "remove" && !state.savedKey) { finish(`${label} removed.`); return; }
          if (attempt.resultKey && state.savedKey === attempt.resultKey) { finish("Uploaded"); return; }
          const changed = state.savedKey !== attempt.expectedKey;
          if (!changed && [400, 413, 415].includes(failure?.status)) {
            state.attempt = null; refresh(); message(failure.message || "Choose a valid PDF and try again."); return;
          }
          state.retryLabel = attempt.kind === "remove" ? "Review removal" : changed ? "Replace with selected PDF" : "Retry upload";
          message(changed ? "The saved document changed. Review it before replacing or removing it." : "The change was not confirmed. Your selected PDF is retained here until you retry or keep the saved document.");
        } catch (error) {
          if (accountStopped) return;
          state.needsRead = true; state.retryLabel = "Check saved document";
          message("The result is unknown. Check the saved document before trying again.");
        }
        refresh();
      };
      const perform = async () => {
        const attempt = state.attempt;
        if (!attempt || state.busy) return;
        state.busy = true; state.review = false; refresh(); message(attempt.kind === "upload" ? "Uploading…" : "Removing…", "saving");
        try {
          if (attempt.kind === "upload") {
            const body = new FormData(); body.append("file", attempt.file); body.append("expectedDocumentKey", attempt.expectedKey);
            const result = await writeAccount(endpoint, "POST", body, attempt.context);
            if (typeof result?.url === "string" && result.url) attempt.resultKey = result.url;
          } else {
            await writeAccount("/api/users/me", "PATCH", { [key]: "", expectedValues: { [key]: attempt.expectedKey } }, attempt.context);
          }
          const latest = await readAccountProfile(attempt.context); accept(latest, attempt.context);
          if (attempt.kind === "remove" && !state.savedKey) finish(`${label} removed.`);
          else if (attempt.resultKey && state.savedKey === attempt.resultKey) finish("Uploaded");
          else await recover();
        } catch (error) { if (!accountStopped) await recover(error); }
        finally { state.busy = false; refresh(); }
      };
      async function openDocument(asDownload = false) {
        if (state.busy || state.needsRead || !state.savedKey) return;
        const context = accountContext(), expectedKey = state.savedKey;
        const popup = window.open("", "_blank");
        if (!popup) { message("Allow a new tab to open this document, then try again."); return; }
        popup.opener = null; documentWindows.add(popup); state.busy = true; refresh(); message("Checking document…", "saving");
        try {
          await verifyAccount(context);
          const result = await accountTransport(`${documentReadUrl(key, expectedKey)}${asDownload ? "&download=true" : ""}`);
          await verifyAccount(context);
          if (typeof result?.url !== "string") throw new Error("The document link could not be verified.");
          const url = new URL(result.url, location.origin);
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.protocol === "http:" && url.origin !== location.origin)) throw new Error("The document link could not be verified.");
          popup.location.replace(url.href); documentWindows.delete(popup); message(asDownload ? "Download opened in a new tab." : "Document opened in a new tab.", "saved");
        } catch (error) {
          popup.close(); documentWindows.delete(popup);
          if (!accountStopped) {
            message(error?.message || "The document could not be opened. Try again.");
            if (error?.kind === "conflict") {
              try { accept(await readAccountProfile(context), context); }
              catch { if (!accountStopped) message("The document changed and its current version couldn’t be checked. Refresh settings before opening it."); }
            }
          }
        } finally { state.busy = false; refresh(); }
      }
      const confirmRemoval = () => confirmAction({ title: `Remove ${label.toLowerCase()}?`, launcher: remove, copy: key === "resumeURL" ? "This removes the résumé from your current profile. Résumés already recorded with applications remain available under those applications." : "The document will no longer be available from your profile.", confirmLabel: "Remove document", danger: true });
      upload.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        const selected = file.files?.[0]; file.value = "";
        if (!selected || state.busy || state.attempt) return;
        if (selected.type !== "application/pdf" && !/\.pdf$/i.test(selected.name)) { message(`${label} must be a PDF.`); return; }
        if (selected.size > 10 * 1024 * 1024) { message(`${label} must be 10 MB or smaller.`); return; }
        state.attempt = { kind: "upload", file: selected, context: accountContext(), expectedKey: state.savedKey };
        await perform();
      });
      remove.addEventListener("click", async () => {
        const context = accountContext(), expectedKey = state.savedKey;
        if (!await confirmRemoval()) return;
        try { assertAccount(context); } catch { return; }
        state.attempt = { kind: "remove", context, expectedKey }; await perform();
      });
      retry.addEventListener("click", async () => {
        if (!state.attempt || state.busy) return;
        if (state.needsRead) { state.busy = true; refresh(); try { await recover(); } finally { state.busy = false; refresh(); } return; }
        const attempt = state.attempt;
        if (attempt.kind === "remove") { if (!await confirmRemoval()) return; }
        else if (state.savedKey !== attempt.expectedKey && !await confirmAction({ title: `Replace ${label.toLowerCase()}?`, launcher: retry, copy: "The selected PDF will replace the document currently saved on your profile.", confirmLabel: "Replace document" })) return;
        attempt.expectedKey = state.savedKey; attempt.resultKey = null; await perform();
      });
      keep.addEventListener("click", () => { if (state.attempt && !state.needsRead && !state.busy) finish("Saved document kept."); });
      open.addEventListener("click", () => void openDocument());
      download.addEventListener("click", () => void openDocument(true));
      renderers.set(`document:${key}`, refresh); refresh();
      section.append(node("article", { className: "v2-settings-document-row", "data-document-field": key }, [
        node("div", {}, [node("strong", {}, [document.createTextNode(label), key === "resumeURL" ? node("small", { className: "v2-settings-required", text: "Required" }) : null]), status]),
        node("div", { className: "v2-settings-document-actions" }, [open, download, upload, remove, retry, keep, file]),
      ]));
    });
    return section;
  }

  function renderProfilePanel() {
    const panel = node("section", { className: "v2-settings-panel", role: "tabpanel", id: "v2-settings-profile", "aria-labelledby": "v2-settings-tab-profile" });
    profileStatus = saveIndicator();
    refreshProfileFeedback();
    profileSaveButton = action("↻", { className: "v2-settings-text-action", hidden: true, "aria-label": "Save now", title: "Save now" });
    profileSaveButton.addEventListener("click", () => void saveProfile());
    recoveryNode = node("div", { className: "v2-settings-recovery", hidden: true });
    readinessNode = node("div", { className: "v2-settings-readiness", role: "status", "aria-live": "polite", hidden: true });

    const overview = node("div", { className: "v2-settings-profile-overview" }, [
      profileIdentityCard(), readinessNode, basicProfileCard(),
    ]);
    const practice = tokenEditor({ key: "practiceAreas", label: "Practice areas", placeholder: "Select a practice area", options: PRACTICE_AREAS, section: "practice-areas" });
    const states = tokenEditor({ key: "stateExperience", label: "State experience", placeholder: "Select a state", options: STATES.map(([code, name]) => `${code} — ${name}`), normalize: (value) => normalizedState(String(value).split("—")[0]), section: "state-experience" });
    const skills = tokenEditor({ key: "skills", label: "Skills", placeholder: "Add up to 5 skills", section: "skills", maximum: 5 });
    const experience = experienceCard();
    const education = educationCard();
    const languages = languageCard();
    mountSaveFeedback("profile", [profileStatus, profileSaveButton]);
    panel.append(
      recoveryNode,
      overview,
      settingsGroup("Professional details", [
        node("div", { className: "v2-settings-compact-grid" }, [
          node("section", { className: "v2-settings-card" }, [sectionHeader("Years of experience"),
            bindProfileInput(input({ type: "number", value: String(profile.yearsExperience), min: "0", max: "80", inputmode: "numeric", "aria-label": "Years of experience", className: "v2-settings-input v2-settings-input--years" }), "yearsExperience", (value) => Math.max(0, Math.min(80, Number(value) || 0))),
          ]), primaryStateCard(), practice, states,
        ]), bioCard(), skills,
      ]),
      settingsGroup("Background", [experience, education, languages]),
      documentsCard(),
    );

    const recovered = readDraft();
    if (recovered) {
      recoveryNode.hidden = false;
      const restore = action("Restore", { className: "v2-settings-secondary" });
      const discard = action("Discard", { className: "v2-settings-text-action" });
      recoveryNode.append(node("p", {}, [node("strong", { text: "Unsaved profile changes found." }), document.createTextNode(" Restore the draft saved in this browser?")]), restore, discard);
      restore.addEventListener("click", () => {
        const recoveredFields = Array.isArray(recovered.fields) ? recovered.fields.filter(field => PROFILE_FIELDS.includes(field)) : PROFILE_FIELDS;
        const draftProfile = normalizeProfile({ ...user, ...recovered.profile });
        recoveredFields.forEach(field => {
          profile[field] = draftProfile[field];
          dirtyProfileFields.set(field, ++profileRevision);
          dirtyProfileBaselines.set(field, recovered.baselines?.[field] || expectedProfileValues({ [field]: profile[field] }));
        });
        if (!recovered.baselines) profileConflict = user;
        clearDraft(); recoveryNode.hidden = true; rebuildProfilePanel(); persistDraft();
        setProfileStatus(profileConflict ? "Review the recovered draft against the saved values." : "Unsaved changes", "error");
        setProfileAction(profileConflict ? "Review saved values" : "Save changes");
      });
      discard.addEventListener("click", () => { clearDraft(); recoveryNode.hidden = true; });
    }
    updateReadiness();
    arrangeSettingsSections(panel);
    return panel;
  }

  function rebuildProfilePanel() {
    if (!profilePanel?.isConnected && !profilePanel) return;
    const replacement = renderProfilePanel();
    profilePanel.replaceWith(replacement);
    profilePanel = replacement;
  }

  function dialogShell({ title, copy = "", labelledBy = "" } = {}) {
    const titleId = labelledBy || `v2-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dialog = node("dialog", { className: "v2-settings-dialog", "data-v2-route-dialog": "", "aria-labelledby": titleId });
    const close = action("Close", { className: "v2-settings-dialog-close", "aria-label": "Close dialog" });
    close.innerHTML = "&times;";
    close.addEventListener("click", () => dialog.close("cancel"));
    dialog.append(node("header", {}, [node("h2", { id: titleId, text: title }), close]));
    if (copy) dialog.append(node("p", { className: "v2-settings-dialog-copy", text: copy }));
    document.querySelector("[data-v2-dialog-host]")?.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    return dialog;
  }

  function confirmAction({ title, copy, confirmLabel, danger = false, launcher = null }) {
    return new Promise((resolve) => {
      const active = launcher || document.activeElement;
      const dialog = dialogShell({ title, copy });
      const cancel = action("Cancel", { className: "v2-settings-secondary" });
      const confirm = action(confirmLabel, { className: danger ? "v2-settings-danger" : "v2-settings-primary" });
      const actions = node("div", { className: "v2-settings-dialog-actions" }, [cancel, confirm]);
      dialog.append(actions);
      cancel.addEventListener("click", () => dialog.close("cancel"));
      confirm.addEventListener("click", () => dialog.close("confirm"));
      dialog.addEventListener("close", () => {
        resolve(dialog.returnValue === "confirm");
        if (active instanceof HTMLElement && active.isConnected) active.focus();
      }, { once: true });
      dialog.showModal();
      cancel.focus();
    });
  }

  async function editExistingPhoto(returnFocus) {
    try {
      const context = accountContext();
      const expectedPhotoRevision = user.profilePhotoRevision;
      await verifyAccount(context);
      const blob = await accountTransport(`/api/uploads/profile-photo/original?expectedOwnerId=${encodeURIComponent(context.ownerId)}&expectedPhotoRevision=${expectedPhotoRevision}`, {}, { image: true });
      await verifyAccount(context);
      const type = /png/i.test(blob.type) ? "image/png" : "image/jpeg";
      const file = new File([blob], type === "image/png" ? "profile-original.png" : "profile-original.jpg", { type });
      await openPhotoEditor(file, { editExisting: true, returnFocus, expectedPhotoRevision });
    } catch (error) {
      showToast?.(error?.message || "The photo editor is unavailable.");
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({ image, url });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The selected image could not be opened.")); };
      image.src = url;
    });
  }

  async function openPhotoEditor(file, { editExisting = false, returnFocus = null, expectedPhotoRevision = user?.profilePhotoRevision } = {}) {
    if (!/^image\/(?:png|jpe?g)$/i.test(file.type || "") || file.size > 5 * 1024 * 1024) {
      showToast?.("Choose a JPEG or PNG image no larger than 5 MB.");
      return;
    }
    const context = accountContext();
    let loaded;
    try { loaded = await loadImage(file); assertAccount(context); } catch (error) { showToast?.(error.message); return; }
    const dialog = dialogShell({ title: "Edit profile photo", copy: "Drag and zoom to crop your photo. Saving sends it for review and hides your profile from attorneys until approval." });
    dialog.classList.add("v2-settings-photo-dialog");
    const viewport = node("div", { className: "v2-settings-crop-viewport", tabindex: "0", "aria-label": "Profile photo crop area" });
    const preview = loaded.image;
    preview.alt = "Photo crop preview";
    preview.draggable = false;
    viewport.append(preview);
    const zoom = input({ type: "range", min: "1", max: "2.5", value: "1", step: "0.01", "aria-label": "Photo zoom" });
    const cancel = action("Cancel", { className: "v2-settings-secondary" });
    const save = action("Save photo", { className: "v2-settings-primary" });
    const photoStatus = node("p", { className: "v2-settings-inline-status", role: "status", "aria-live": "polite" });
    const savedPhoto = node("img", { alt: "Currently saved profile photo", hidden: true, width: "96", height: "96" });
    const useSaved = action("Use saved photo", { className: "v2-settings-text-action", hidden: true });
    useSaved.addEventListener("click", () => dialog.close("saved-photo"));
    dialog.append(viewport, field("Zoom", zoom), photoStatus, savedPhoto, node("div", { className: "v2-settings-dialog-actions" }, [cancel, useSaved, save]));
    let photoNeedsCheck = false;
    async function reviewSavedPhoto() {
      try {
        const latest = await readAccountProfile(context);
        user = latest; updateIdentity?.(user); renderers.get("photo")?.(); updateReadiness();
        expectedPhotoRevision = latest.profilePhotoRevision;
        photoNeedsCheck = false;
        photoStatus.textContent = "The saved photo changed or its save could not be confirmed. Review it before saving this crop again.";
        photoStatus.dataset.state = "error";
        savedPhoto.hidden = !photoOf(latest); if (photoOf(latest)) savedPhoto.src = photoOf(latest);
        useSaved.hidden = false; save.textContent = "Save this crop";
      } catch (error) {
        if (accountStopped) return;
        photoNeedsCheck = true;
        photoStatus.textContent = "Photo save status is unknown. Check the saved photo before trying again.";
        photoStatus.dataset.state = "error"; save.textContent = "Check saved photo";
      }
    }
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const baseDimensions = () => {
      const size = viewport.clientWidth || 300;
      const scale = Math.max(size / preview.naturalWidth, size / preview.naturalHeight) * Number(zoom.value || 1);
      return { size, width: preview.naturalWidth * scale, height: preview.naturalHeight * scale };
    };
    const clampOffset = () => {
      const { size, width, height } = baseDimensions();
      offsetX = Math.max((size - width) / 2, Math.min((width - size) / 2, offsetX));
      offsetY = Math.max((size - height) / 2, Math.min((height - size) / 2, offsetY));
    };
    const renderCrop = () => {
      clampOffset();
      const { width, height } = baseDimensions();
      preview.style.width = `${width}px`;
      preview.style.height = `${height}px`;
      preview.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
    };
    zoom.addEventListener("input", renderCrop);
    viewport.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || save.disabled) return;
      event.preventDefault(); const step = event.shiftKey ? 1 : 5;
      offsetX += event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      offsetY += event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      renderCrop();
    });
    viewport.addEventListener("pointerdown", (event) => {
      if (save.disabled) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      offsetX += event.clientX - lastX;
      offsetY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      renderCrop();
    });
    viewport.addEventListener("pointerup", () => { dragging = false; });
    viewport.addEventListener("pointercancel", () => { dragging = false; });
    cancel.addEventListener("click", () => dialog.close("cancel"));
    save.addEventListener("click", async () => {
      save.disabled = true;
      if (photoNeedsCheck) { await reviewSavedPhoto(); save.disabled = false; return; }
      save.textContent = "Saving…";
      zoom.disabled = true; cancel.disabled = true;
      dialog.querySelector(".v2-settings-dialog-close").disabled = true;
      let photoWriteStarted = false;
      try {
        assertAccount(context);
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 600;
        const canvasContext = canvas.getContext("2d", { alpha: false });
        canvasContext.fillStyle = "#ffffff";
        canvasContext.fillRect(0, 0, 600, 600);
        const { size, width, height } = baseDimensions();
        const ratio = 600 / size;
        canvasContext.drawImage(preview, (600 - width * ratio) / 2 + offsetX * ratio, (600 - height * ratio) / 2 + offsetY * ratio, width * ratio, height * ratio);
        const type = /png/i.test(file.type) ? "image/png" : "image/jpeg";
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
        if (!blob) throw new Error("The photo could not be prepared.");
        const body = new FormData();
        body.append("file", blob, type === "image/png" ? "profile.png" : "profile.jpg");
        body.append("original", file, file.name || (type === "image/png" ? "profile-original.png" : "profile-original.jpg"));
        if (editExisting) body.append("editExisting", "1");
        body.set("expectedPhotoRevision", expectedPhotoRevision);
        photoWriteStarted = true;
        const result = await writeAccount("/api/uploads/profile-photo", "POST", body, context);
        const fresh = await readAccountProfile(context);
        if (fresh.profilePhotoRevision !== result.profilePhotoRevision) throw new Error("The saved photo changed in another session.");
        user = fresh;
        renderers.get("photo")?.();
        updateReadiness();
        updateIdentity?.(user);
        invalidateHome?.();
        invalidateBrowse?.();
        dialog.close("saved");
        showToast?.(String(result?.status || "").toLowerCase() === "pending_review" ? "Photo submitted for review." : "Profile photo updated.");
      } catch (error) {
        if (!accountStopped && photoWriteStarted) await reviewSavedPhoto();
        else if (!accountStopped) {
          photoStatus.textContent = "This image could not be prepared. Your photo has not been submitted. Choose another JPEG or PNG.";
          photoStatus.dataset.state = "error"; save.textContent = "Save photo";
        }
      } finally {
        save.disabled = false; zoom.disabled = false; cancel.disabled = false;
        dialog.querySelector(".v2-settings-dialog-close").disabled = false;
      }
    });
    dialog.addEventListener("cancel", event => { if (save.disabled) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      URL.revokeObjectURL(loaded.url);
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    }, { once: true });
    dialog.showModal();
    requestAnimationFrame(renderCrop);
    zoom.focus();
  }

  function securityCard(title, copy = "", className = "") {
    return node("section", { className: `v2-settings-card v2-settings-security-card ${className}`.trim() }, [sectionHeader(title, copy)]);
  }

  function payoutCard(stripe) {
    const state = stripe?.readiness || {};
    const ready = state.ready === true;
    const unavailable = !stripe || (state.evidenceState && state.evidenceState !== "verified");
    const card = securityCard("Stripe payouts", ready
      ? ""
      : unavailable ? "Open Stripe to check your setup."
        : "Complete Stripe setup before applying or receiving payments.", "v2-settings-payout-card");
    const badge = node("span", { className: "v2-settings-status-badge", "data-state": ready ? "ready" : unavailable ? "unknown" : "action", text: ready ? "Connected" : unavailable ? "Status unavailable" : "Action required" });
    const open = action(ready || state.accountPresent ? "Update Stripe details" : "Connect Stripe", { className: "v2-settings-primary" });
    open.addEventListener("click", async () => {
      open.disabled = true;
      open.textContent = "Opening Stripe…";
      try { await startStripeOnboarding(); } catch (error) {
        open.disabled = false;
        open.textContent = ready || state.accountPresent ? "Update Stripe details" : "Connect Stripe";
        showToast?.(error?.message || "Unable to open Stripe.");
      }
    });
    card.append(
      node("div", { className: "v2-settings-card-actions" }, [badge, open]),
    );
    card.id = "v2-settings-payments";
    return card;
  }

  function leaveSecurity() {
    securityController?.abort(); securityController = null;
    root?.querySelector('[data-settings-feedback="security"]')?.remove();
    securityApi?.clear(); securityApi = null; signInSecurity?.remove(); signInSecurity = null;
    blockedSettings?.remove(); blockedSettings = null;
    closureSettings?.remove(); closureSettings = null;
    securityPromise = null;
    securityLoaded = false;
  }

  function securitySignOut() {
    if (onSessionLost) { onSessionLost(); return; }
    const pending = closureAccountState.closure?.pending;
    clearAccountDrafts(); clearSession();
    location.replace(pending ? "/account-closure.html" : "/login.html");
  }

  function renderSecurityContent(snapshot) {
    if (!securityPanel || !signInSecurity || accountStopped) return;
    const { stripe } = snapshot;
    const retry = snapshot.failures ? action("Retry unavailable items", { className: "v2-settings-text-action" }) : null;
    retry?.addEventListener("click", () => { securityLoaded = false; void loadSecurity({ force: true }); });
    securityPanel.replaceChildren(
      ...(snapshot.failures ? [node("div", { className: "v2-settings-panel-toolbar" }, [node("p", { text: "Some account items are temporarily unavailable." }), retry])] : []),
      node("div", { className: "v2-settings-security-grid" }, [payoutCard(stripe), signInSecurity, blockedSettings]),
      closureSettings,
    );
    arrangeSettingsSections(securityPanel);
  }

  async function loadSecurity({ force = false } = {}) {
    if (!securityPanel || accountStopped) return;
    if (securityLoaded && !force) return;
    if (securityPromise) return securityPromise;
    const context = accountContext();
    if (!signInSecurity) {
      securityController = new AbortController();
      securityApi = createSecurityApi({ onAuthenticationLost: securitySignOut });
      signInSecurity = createSecurityView({ id: context.ownerId }, {
        securityApi, signal: securityController.signal, accountState: securityAccountState,
        onSessionLost: securitySignOut,
      });
      mountSaveFeedback("security", [signInSecurity.toolbar]);
      blockedSettings = createBlockedView({ id: context.ownerId }, { signal: securityController.signal, accountState: securityAccountState, onSessionLost: securitySignOut });
      closureSettings = createClosureView({ id: context.ownerId }, { signal: securityController.signal, accountState: closureAccountState, onSessionLost: securitySignOut, onClosurePending });
      securityPanel.replaceChildren(signInSecurity, blockedSettings, closureSettings);
    } else if (force) void signInSecurity.refresh();
    const view = signInSecurity;
    const controller = securityController;
    let pending;
    pending = (async () => {
      await verifyAccount(context);
      const results = await Promise.allSettled([
        api.get("/api/payments/connect/status", { signal: controller.signal }),
      ]);
      await verifyAccount(context);
      if (view !== signInSecurity || !securityPanel) return;
      const value = index => results[index].status === "fulfilled" ? results[index].value : null;
      renderSecurityContent({ stripe: value(0), failures: results.filter(entry => entry.status !== "fulfilled").length });
      if (results[0].status === "fulfilled") invalidateWork?.();
      securityLoaded = true;
    })().catch(() => {
      if (view !== signInSecurity || accountStopped) return;
      renderSecurityContent({ stripe: null, failures: 1 });
    }).finally(() => { if (securityPromise === pending) securityPromise = null; });
    securityPromise = pending;
    return pending;
  }

  function switchControl({ label, copy = "", checked = false, disabled = false, name = "" }) {
    const control = input({ type: "checkbox", checked, disabled, "aria-label": name || label });
    const toggle = node("label", { className: "v2-settings-switch" }, [control, node("span", { "aria-hidden": "true" })]);
    return {
      control,
      row: node("div", { className: `v2-settings-preference-row${disabled ? " is-disabled" : ""}` }, [
        node("div", {}, [node("strong", { text: label }), copy ? node("p", { text: copy }) : null]),
        toggle,
      ]),
    };
  }

  let preferenceRecovery = null;

  function preferenceSnapshot(snapshot = user) {
    return { ...(snapshot.preferences || {}), state: snapshot.state || snapshot.location || "", email: snapshot.notificationPrefs?.email !== false };
  }

  async function savePreferencePatch(payload, expectedValues, { notification = false, context = accountContext() } = {}) {
    if (preferenceRecovery) throw new Error("Check the saved settings before making another change.");
    try {
      return await writeAccount(notification ? "/api/users/me/notification-prefs" : "/api/account/preferences", notification ? "PATCH" : "POST", { ...payload, expectedValues }, context);
    } catch (error) {
      assertAccount(context);
      const attempt = { payload, notification, context };
      try { return await recoverPreference(attempt); }
      catch (recoveryError) {
        if (!recoveryError.latest) preferenceRecovery = attempt;
        else if (error?.status && error.status !== 409) recoveryError.message = error.message;
        throw recoveryError;
      }
    }
  }

  async function recoverPreference(attempt) {
    let latest;
    try { latest = await readAccountProfile(attempt.context); }
    catch (error) { throw new Error("Save status is unknown. Check saved settings before trying again."); }
    const current = attempt.notification ? Object.fromEntries(Object.keys(attempt.payload).map(key => [key, latest.notificationPrefs?.[key] !== false])) : preferenceSnapshot(latest);
    user = latest; preferences = preferenceSnapshot(latest); preferenceRecovery = null;
    updateIdentity?.(user);
    for (const key of ["notificationControls", "visibilityControl", "workspaceControls", "primaryStateControl"]) renderers.get(key)?.();
    if (!Object.entries(attempt.payload).every(([key, value]) => equal(current[key], value))) {
      throw Object.assign(new Error("This setting changed or was not saved. Review the saved value before choosing again."), { latest });
    }
    return { preferences, state: preferences.state, notificationPrefs: latest.notificationPrefs, updatedAt: latest.updatedAt };
  }

  function setPreferenceStatus(copy, state = "idle") {
    const status = root?.querySelector("[data-preference-status]");
    if (!status) return;
    const localError = root.querySelector('#v2-settings-preferences [data-preference-local-status][data-state="error"]:not([hidden])');
    const visible = Boolean(copy) && !(localError && ["error", "saved"].includes(state));
    updateSaveIndicator(status, visible ? copy : "", visible ? state : "idle");
    status.hidden = !visible;
  }

  function preferenceStatusFor(card) {
    const status = node("p", { className: "v2-settings-inline-status", role: "status", "data-preference-local-status": "", hidden: true });
    const retry = action("Check saved settings", { className: "v2-settings-text-action", hidden: true });
    const onStatus = (copy, state) => {
      status.textContent = state === "error" ? copy : "";
      status.dataset.state = state;
      status.hidden = state !== "error";
      retry.hidden = state !== "error" || !preferenceRecovery;
      setPreferenceStatus(copy, state);
    };
    retry.addEventListener("click", async () => {
      if (!preferenceRecovery) return;
      retry.disabled = true;
      try { await recoverPreference(preferenceRecovery); onStatus("Saved settings verified", "saved"); }
      catch (error) { onStatus(error.message, "error"); }
      finally { retry.disabled = false; }
    });
    card.append(status, retry);
    return onStatus;
  }

  function mergePreferences(result = {}, patch = {}) {
    const responsePreferences = result.preferences && typeof result.preferences === "object" ? result.preferences : {};
    preferences = { ...preferences, ...patch, ...responsePreferences };
    user = {
      ...user,
      ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
      preferences: {
        ...(user.preferences || {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, "theme") ? { theme: preferences.theme } : {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, "fontSize") ? { fontSize: preferences.fontSize } : {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, "hideProfile") ? { hideProfile: preferences.hideProfile } : {}),
      },
    };
    updateIdentity?.(user);
  }

  function queuePreferenceSave(work, { success = "Saved", rollback = null, onStatus = setPreferenceStatus } = {}) {
    onStatus("Saving…", "saving");
    preferencePendingCount += 1;
    preferenceQueue = preferenceQueue.then(work).then((result) => {
      onStatus(success, "saved");
      return result;
    }).catch((error) => {
      if (!accountStopped) rollback?.(error);
      onStatus(error?.message || "Couldn’t verify this setting. Check the saved values.", "error");
      return null;
    });
    preferenceQueue = preferenceQueue.finally(() => { preferencePendingCount -= 1; });
    return preferenceQueue;
  }

  function notificationsPreferenceCard() {
    const prefs = user.notificationPrefs || {};
    const card = node("section", { className: "v2-settings-card" }, [sectionHeader("Notifications")]);
    const onStatus = preferenceStatusFor(card);
    const email = switchControl({ label: "Email notifications", checked: prefs.email !== false });
    const messages = switchControl({ label: "New message alerts", checked: prefs.emailMessages !== false, disabled: prefs.email === false });
    const matters = switchControl({ label: "Matter updates", checked: prefs.emailCase !== false, disabled: prefs.email === false });

    const syncChildState = () => {
      const enabled = email.control.checked;
      [messages, matters].forEach((item) => {
        item.control.disabled = !enabled;
        item.row.classList.toggle("is-disabled", !enabled);
      });
    };
    [[email, "email"], [messages, "emailMessages"], [matters, "emailCase"]].forEach(([item, key]) => {
      item.control.addEventListener("change", () => {
        const next = item.control.checked;
        const previous = user.notificationPrefs?.[key] !== false;
        const context = accountContext();
        if (key === "email") syncChildState();
        queuePreferenceSave(async () => {
        const result = await savePreferencePatch({ [key]: next }, { [key]: previous }, { notification: true, context });
          user.notificationPrefs = { ...(user.notificationPrefs || {}), ...(result?.notificationPrefs || {}) };
          if (result?.updatedAt) user.updatedAt = result.updatedAt;
          if (key === "email") preferences.email = next;
          invalidateHome?.();
          return result;
        }, {
          success: "Notification preferences saved", onStatus,
          rollback: (error) => { if (error.latest) item.control.checked = error.latest.notificationPrefs?.[key] !== false; if (key === "email") syncChildState(); },
        });
      });
    });
    renderers.set("notificationControls", () => { email.control.checked = user.notificationPrefs?.email !== false; messages.control.checked = user.notificationPrefs?.emailMessages !== false; matters.control.checked = user.notificationPrefs?.emailCase !== false; syncChildState(); });
    card.append(email.row, messages.row, matters.row);
    return card;
  }

  function visibilityPreferenceCard() {
    const approvedPhoto = String(user.profilePhotoStatus || "").toLowerCase() === "approved" && !user.pendingProfileImage && Boolean(user.profileImage || user.avatarURL);
    const hidden = preferences.hideProfile === true || !approvedPhoto;
    const visibility = switchControl({
      label: "Hide profile",
      copy: approvedPhoto ? "" : "Your profile remains hidden until your profile photo is approved.",
      checked: hidden,
      disabled: !approvedPhoto,
    });
    const card = node("section", { className: "v2-settings-card" }, [sectionHeader("Profile visibility"), visibility.row]);
    const onStatus = preferenceStatusFor(card);
    visibility.control.addEventListener("change", () => {
      const next = visibility.control.checked;
      const previous = preferences.hideProfile === true;
      const context = accountContext();
      queuePreferenceSave(async () => {
        const result = await savePreferencePatch({ hideProfile: next }, { hideProfile: previous }, { context });
        mergePreferences(result, { hideProfile: next });
        invalidateBrowse?.();
        return result;
      }, { success: "Profile visibility saved", onStatus, rollback: (error) => { if (error.latest) visibility.control.checked = error.latest.preferences?.hideProfile === true; } });
    });
    renderers.set("visibilityControl", () => {
      const approved = String(user.profilePhotoStatus || "").toLowerCase() === "approved" && !user.pendingProfileImage && Boolean(user.profileImage || user.avatarURL);
      visibility.control.checked = preferences.hideProfile === true || !approved;
      visibility.control.disabled = !approved;
      visibility.row.classList.toggle("is-disabled", !approved);
      const description = visibility.row.querySelector("div");
      let copy = description.querySelector("p");
      if (!approved && !copy) { copy = node("p"); description.append(copy); }
      if (copy) { copy.textContent = approved ? "" : "Your profile remains hidden until your profile photo is approved."; copy.hidden = approved; }
    });
    return card;
  }

  function primaryStateCard() {
    const stateValue = normalizedState(preferences.state || user.state || user.location);
    const state = select([["", "Choose…"], ...STATES], { value: stateValue, "aria-label": "Primary state", required: true });
    state.options[0].disabled = true;
    const missingState = node("p", { className: "v2-settings-inline-status", text: "Choose your primary state to complete your profile.", hidden: Boolean(stateValue) });
    const localStatus = node("p", { className: "v2-settings-inline-status", role: "status", hidden: true });
    const retry = action("Check saved settings", { className: "v2-settings-text-action", hidden: true });
    retry.addEventListener("click", async () => {
      if (!preferenceRecovery) return;
      retry.disabled = true;
      try { await recoverPreference(preferenceRecovery); onStatus("Changes saved", "saved"); }
      catch (error) { onStatus(error.message, "error"); }
      finally { retry.disabled = false; }
    });
    const onStatus = (copy, phase) => {
      setPrimaryStateStatus(copy, phase);
      retry.hidden = phase !== "error" || !preferenceRecovery;
      localStatus.textContent = phase === "error" ? copy : "";
      localStatus.dataset.state = phase;
      localStatus.hidden = phase !== "error";
    };
    state.addEventListener("change", () => {
      const next = state.value;
      const previous = preferences.state || user.state || user.location || "";
      const context = accountContext();
      state.disabled = true;
      void queuePreferenceSave(async () => {
        const result = await savePreferencePatch({ state: next }, { state: previous }, { context });
        preferences.state = result?.state ?? next;
        user.state = result?.state ?? next;
        user.location = user.state;
        missingState.hidden = Boolean(normalizedState(user.state));
        if (result?.updatedAt) user.updatedAt = result.updatedAt;
        updateIdentity?.(user);
        invalidateHome?.();
        invalidateBrowse?.();
        return result;
      }, { success: "Changes saved", onStatus, rollback: (error) => { if (error.latest) state.value = normalizedState(error.latest.state || error.latest.location); } }).finally(() => { state.disabled = false; });
    });
    renderers.set("primaryStateControl", () => { state.value = normalizedState(user.state || user.location); missingState.hidden = Boolean(state.value); });
    return node("section", { className: "v2-settings-card", "data-profile-section": "primary-state" }, [
      sectionHeader("Primary state"),
      state, missingState, localStatus, retry,
    ]);
  }

  function workspacePreferenceCard() {
    const theme = currentTheme(preferences.theme || user.preferences?.theme);
    const size = FONT_SIZES[preferences.fontSize] ? preferences.fontSize : "md";
    const card = node("section", { className: "v2-settings-card v2-settings-card--workspace" }, [sectionHeader("Workspace")]);
    const onStatus = preferenceStatusFor(card);
    const themeGroup = node("div", { className: "v2-settings-theme-options", role: "radiogroup", "aria-label": "Appearance" });
    [
      ["light", "Light"],
      ["dark", "Dark"],
    ].forEach(([value, label]) => {
      const button = node("button", { className: "v2-settings-theme", type: "button", role: "radio", "aria-checked": String(theme === value), "data-theme": value }, [
        node("span", { className: `v2-settings-theme-swatch v2-settings-theme-swatch--${value}`, "aria-hidden": "true" }),
        node("span", {}, [node("strong", { text: label })]),
      ]);
      button.addEventListener("click", () => {
        const next = value;
        const previous = currentTheme(preferences.theme);
        const expectedTheme = preferences.theme || user.preferences?.theme || "light";
        const context = accountContext();
        if (next === previous) return;
        document.documentElement.classList.remove("theme-light", "theme-dark");
        document.documentElement.classList.add(`theme-${next}`);
        themeGroup.querySelectorAll("[role=radio]").forEach((candidate) => candidate.setAttribute("aria-checked", String(candidate.dataset.theme === next)));
        queuePreferenceSave(async () => {
          const result = await savePreferencePatch({ theme: next }, { theme: expectedTheme }, { context });
          mergePreferences(result, { theme: next });
          return result;
        }, {
          success: "Appearance saved", onStatus,
          rollback: (error) => {
            if (!error.latest) return;
            const latest = currentTheme(error.latest.preferences?.theme);
            document.documentElement.classList.remove("theme-light", "theme-dark");
            document.documentElement.classList.add(`theme-${latest}`);
            themeGroup.querySelectorAll("[role=radio]").forEach((candidate) => candidate.setAttribute("aria-checked", String(candidate.dataset.theme === latest)));
          },
        });
      });
      button.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const next = value === "light" ? "dark" : "light";
        themeGroup.querySelector(`[data-theme="${next}"]`)?.click();
        themeGroup.querySelector(`[data-theme="${next}"]`)?.focus();
      });
      themeGroup.append(button);
    });
    const font = select([["xs", "Extra small"], ["sm", "Small"], ["md", "Medium"], ["lg", "Large"], ["xl", "Extra large"]], { value: size, "aria-label": "Font size" });
    font.addEventListener("change", () => {
      const next = FONT_SIZES[font.value] ? font.value : "md";
      const previous = FONT_SIZES[preferences.fontSize] ? preferences.fontSize : "md";
      const context = accountContext();
      document.documentElement.style.fontSize = FONT_SIZES[next];
      queuePreferenceSave(async () => {
        const result = await savePreferencePatch({ fontSize: next }, { fontSize: previous }, { context });
        mergePreferences(result, { fontSize: next });
        return result;
      }, { success: "Reading size saved", onStatus, rollback: (error) => { if (error.latest) { font.value = error.latest.preferences?.fontSize || "md"; document.documentElement.style.fontSize = FONT_SIZES[font.value]; } } });
    });
    renderers.set("workspaceControls", () => {
      const latest = currentTheme(preferences.theme);
      document.documentElement.classList.remove("theme-light", "theme-dark"); document.documentElement.classList.add(`theme-${latest}`);
      themeGroup.querySelectorAll("[role=radio]").forEach(candidate => candidate.setAttribute("aria-checked", String(candidate.dataset.theme === latest)));
      font.value = preferences.fontSize || "md"; document.documentElement.style.fontSize = FONT_SIZES[font.value];
    });
    const tour = action("Replay tour", { className: "v2-settings-secondary" });
    tour.addEventListener("click", () => {
      onReplayTour?.(tour);
    });
    card.append(
      node("div", { className: "v2-settings-preference-block" }, [node("strong", { text: "Appearance" }), themeGroup]),
      node("div", { className: "v2-settings-field-grid" }, [
        field("Font size", font),
      ]),
      node("div", { className: "v2-settings-preference-row" }, [node("div", {}, [node("strong", { text: "Workspace tour" })]), tour]),
    );
    return card;
  }

  function renderPreferencesPanel() {
    const panel = node("section", { className: "v2-settings-panel", role: "tabpanel", id: "v2-settings-preferences", "aria-labelledby": "v2-settings-tab-preferences", hidden: true });
    mountSaveFeedback("preferences", [saveIndicator({ "data-preference-status": "" })]);
    panel.append(
      node("div", { className: "v2-settings-two-column v2-settings-preferences-grid" }, [notificationsPreferenceCard(), visibilityPreferenceCard()]),
      workspacePreferenceCard(),
    );
    arrangeSettingsSections(panel);
    return panel;
  }

  function mountSaveFeedback(tab, controls) {
    const host = root.querySelector(".v2-settings-header-feedback");
    const feedback = node("div", {
      className: "v2-settings-save-feedback",
      "data-settings-feedback": tab,
      hidden: root.querySelector(`[data-settings-tab="${tab}"]`)?.getAttribute("aria-selected") !== "true",
    }, controls);
    const previous = host.querySelector(`[data-settings-feedback="${tab}"]`);
    if (previous) previous.replaceWith(feedback);
    else host.append(feedback);
  }

  function settingsHeader() {
    const tabs = node("div", { className: "v2-settings-tabs", role: "tablist", "aria-label": "Profile Settings" });
    [["profile", "Profile"], ["security", "Security"], ["preferences", "Preferences"]].forEach(([name, label]) => {
      const link = node("a", {
        id: `v2-settings-tab-${name}`,
        className: "v2-settings-tab",
        role: "tab",
        href: `paralegal-v2.html#/settings?tab=${name}`,
        "data-view": `/settings?tab=${name}`,
        "data-v2-route": "",
        "data-settings-tab": name,
        "aria-controls": `v2-settings-${name}`,
        "aria-selected": "false",
        tabindex: "-1",
        text: label,
      });
      link.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const links = [...tabs.querySelectorAll("[role=tab]")];
        const index = links.indexOf(link);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % links.length : (index - 1 + links.length) % links.length;
        links[nextIndex].click();
        links[nextIndex].focus();
      });
      tabs.append(link);
    });
    return node("header", { className: "v2-settings-header" }, [
      node("div", {}, [node("h1", { text: "Profile Settings" })]),
      node("div", { className: "v2-settings-navigation" }, [
        tabs,
        node("div", { className: "v2-settings-header-feedback" }),
      ]),
    ]);
  }

  function buildRoot() {
    root = node("section", { className: "v2-settings", "data-v2-settings": "" }, [settingsHeader()]);
    profilePanel = renderProfilePanel();
    securityPanel = node("section", { className: "v2-settings-panel", role: "tabpanel", id: "v2-settings-security", "aria-labelledby": "v2-settings-tab-security", hidden: true }, [node("div", { className: "v2-settings-local-loading", text: "Open Security to manage your sign-in and payout settings." })]);
    preferencesPanel = renderPreferencesPanel();
    root.append(profilePanel, securityPanel, preferencesPanel);
    if (!beforeUnloadBound) {
      beforeUnloadBound = true;
      window.addEventListener("beforeunload", (event) => {
        if (profileSavedRevision === profileRevision && !hasPendingDocuments() && !signInSecurity?.hasPending() && !blockedSettings?.hasPending() && !closureSettings?.hasPending() && !closureAccountState.closure?.pending) return;
        event.preventDefault();
        event.returnValue = "";
      });
    }
    return root;
  }

  function activateTab(name) {
    const safe = ["profile", "security", "preferences"].includes(name) ? name : "profile";
    root?.querySelectorAll("[data-settings-tab]").forEach((tab) => {
      const current = tab.dataset.settingsTab === safe;
      tab.setAttribute("aria-selected", String(current));
      tab.tabIndex = current ? 0 : -1;
    });
    [["profile", profilePanel], ["security", securityPanel], ["preferences", preferencesPanel]].forEach(([tab, panel]) => {
      if (panel) panel.hidden = tab !== safe;
    });
    root?.querySelectorAll("[data-settings-feedback]").forEach((feedback) => {
      feedback.hidden = feedback.dataset.settingsFeedback !== safe;
    });
    if (safe === "security") void loadSecurity();
    else leaveSecurity();
    return safe;
  }

  function tabForRoute(route) {
    const requested = String(route?.query?.get("tab") || "").toLowerCase();
    const section = String(route?.query?.get("section") || "").toLowerCase();
    if (section === "payments" || section === "blocked" || section === "sessions" || section === "password" || section === "verification" || section === "passkeys" || section === "closure") return "security";
    return ["profile", "security", "preferences"].includes(requested) ? requested : "profile";
  }

  function afterMount(route, attempt = 0) {
    if (accountStopped) return;
    const tabs = root?.querySelector('.v2-settings-tabs');
    if (tabs && attempt === 0) {
      tabLayoutObserver?.disconnect();
      const syncOrientation = () => tabs.setAttribute('aria-orientation', getComputedStyle(tabs).flexDirection === 'column' ? 'vertical' : 'horizontal');
      syncOrientation();
      tabLayoutObserver = new ResizeObserver(syncOrientation);
      tabLayoutObserver.observe(tabs);
    }
    const section = String(route?.query?.get("section") || "").toLowerCase();
    if (!section) return;
    const profileSections = ["primary-state", "bio", "skills", "practice-areas", "résumé", "profile-photo"];
    const selector = profileSections.includes(section) ? `[data-profile-section="${section}"]` : { payments: "#v2-settings-payments", blocked: "#v2-settings-blocked", sessions: "#pv2-security-sessions", password: "#pv2-security-password", verification: "#pv2-security-verification", passkeys: "#pv2-security-passkeys", closure: "#v2-settings-closure" }[section];
    if (!selector) return;
    const target = root?.querySelector(selector);
    if (!target && tabForRoute(route) === "security" && attempt < 30) {
      window.setTimeout(() => afterMount(route, attempt + 1), 80);
      return;
    }
    requestAnimationFrame(() => { target?.scrollIntoView({ block: "start" }); if (target?.classList.contains("pv2-security-section")) target.querySelector("button:not(:disabled)")?.focus(); });
  }

  async function render({ route, isCurrent }) {
    try { await loadCore(); }
    catch (error) { if (!accountStopped) throw error; }
    if (!isCurrent()) return null;
    if (accountStopped) return createAccountRecoveryView();
    if (!root) {
      buildRoot();
      for (const event of ["focusin", "input", "change", "click"]) root.addEventListener(event, () => { interactionRevision += 1; }, { capture: true });
    }
    activateTab(tabForRoute(route));
    return root;
  }

  function previewList(title, values) {
    const clean = list(values);
    if (!clean.length) return null;
    return node("section", { className: "v2-settings-preview-section" }, [node("h2", { text: title }), node("div", { className: "v2-settings-chips" }, clean.map((item) => node("span", { className: "v2-settings-chip", text: item })))]);
  }

  async function renderPreview({ isCurrent }) {
    try { await loadCore(); }
    catch (error) { if (!accountStopped) throw error; }
    if (!isCurrent()) return null;
    if (accountStopped) return createAccountRecoveryView();
    const current = profile || normalizeProfile(user);
    const hidden = preferences?.hideProfile === true;
    const location = normalizedState(preferences?.state || user.state || user.location);
    const joined = user.approvedAt || user.createdAt;
    const documents = [
      ["Résumé", profileDocumentValue(user, "resumeURL"), "resumeURL"],
      ["Certificate", profileDocumentValue(user, "certificateURL"), "certificateURL"],
      ["Writing sample", profileDocumentValue(user, "writingSampleURL"), "writingSampleURL"],
    ].filter(([, value]) => text(value, 1000));
    const page = node("section", { className: "v2-settings-preview", "data-v2-profile-preview": "" }, [
      node("header", { className: "v2-settings-preview-header" }, [
        node("div", {}, [node("p", { className: "v2-settings-preview-kicker", text: "Attorney view" }), node("h1", { text: nameOf({ ...user, ...current }) }), node("p", { text: `${current.yearsExperience || 0} years of experience${location ? ` · ${location}` : ""}` })]),
        routeLink("Back to settings", "/settings?tab=profile", "v2-settings-secondary"),
      ]),
    ]);
    if (hidden) page.append(node("div", { className: "v2-settings-preview-notice" }, [node("strong", { text: "Your profile is hidden" }), node("span", { text: "This is how your profile will look when it’s visible to attorneys." })]));
    page.append(node("div", { className: "v2-settings-preview-layout" }, [
      node("aside", {}, [
        photoOf(user) ? node("img", { src: photoOf(user), alt: `Profile photo for ${nameOf(user)}` }) : node("span", { className: "v2-settings-preview-initials", text: initialsOf(user) }),
        node("dl", { className: "v2-settings-preview-meta" }, [
          location ? node("div", {}, [node("dt", { text: "Location" }), node("dd", { text: location })]) : null,
          node("div", {}, [node("dt", { text: "Availability" }), node("dd", { text: previewAvailability(user) })]),
          joined ? node("div", {}, [node("dt", { text: "Joined LPC" }), node("dd", { text: formatDate(joined) })]) : null,
        ]),
        current.linkedInURL ? node("a", { href: current.linkedInURL, target: "_blank", rel: "noopener noreferrer", text: "LinkedIn profile" }) : null,
        documents.length ? node("nav", { className: "v2-settings-preview-documents", "aria-label": "Profile documents" }, documents.map(([label, value, field]) => node("a", {
          href: documentReadUrl(field, value, "view"),
          target: "_blank",
          rel: "noopener noreferrer",
          text: label,
        }))) : null,
      ]),
      node("div", {}, [
        current.bio ? node("section", { className: "v2-settings-preview-section" }, [node("h2", { text: "About" }), node("p", { text: current.bio })]) : null,
        previewList("Practice areas", current.practiceAreas),
        previewList("Skills", current.skills),
        previewList("State experience", current.stateExperience),
        current.experience.length ? node("section", { className: "v2-settings-preview-section" }, [node("h2", { text: "Experience" }), ...current.experience.map((entry) => node("article", {}, [node("strong", { text: entry.title || "Experience" }), entry.years ? node("span", { text: entry.years }) : null, entry.description ? node("p", { text: entry.description }) : null]))]) : null,
        current.education.length ? node("section", { className: "v2-settings-preview-section" }, [node("h2", { text: "Education" }), ...current.education.map((entry) => node("article", {}, [node("strong", { text: entry.school || entry.degree || "Education" }), node("span", { text: [entry.degree, entry.fieldOfStudy].filter(Boolean).join(" · ") })]))]) : null,
        current.languages.length ? node("section", { className: "v2-settings-preview-section" }, [node("h2", { text: "Languages" }), node("p", { text: current.languages.map((entry) => [entry.name, entry.proficiency].filter(Boolean).join(" — ")).join(" · ") })]) : null,
      ]),
    ]));
    return page;
  }

  function createAccountRecoveryView() {
    const reload = action("Reload workspace", { className: "v2-settings-secondary" });
    reload.addEventListener("click", () => location.reload());
    return node("section", {
      className: "v2-route-state v2-settings-session-state",
      "data-v2-settings-recovery": "",
      "aria-labelledby": "v2-settings-session-title",
    }, [
      node("h1", { id: "v2-settings-session-title", text: "Your account changed" }),
      reload,
    ]);
  }

  function clearAccountDrafts() {
    leaveSecurity(); delete securityAccountState.securityNotice; delete securityAccountState.blockedAction;
    Object.keys(closureAccountState).forEach(key => delete closureAccountState[key]);
    window.clearTimeout(profileSaveTimer); profileSaveTimer = null; clearDraft();
    accountGeneration += 1; accountStopped = true;
    accountRequests.forEach(controller => controller.abort()); accountRequests.clear();
    documentStates.clear(); documentWindows.forEach(popup => popup.close()); documentWindows.clear();
    unresolvedProfileSave = null; profileConflict = null; profileSavePromise = null; preferenceRecovery = null;
    profileSavedRevision = profileRevision; dirtyProfileFields.clear(); dirtyProfileBaselines.clear();
    document.querySelectorAll("dialog.v2-settings-dialog").forEach(dialog => dialog.close("account-changed"));
    user = null; profile = null; preferences = null; renderers.clear();
    // A stopped controller is never revived. Reentry starts a fresh document
    // and verifies its owner before reading or restoring any account data.
    root?.replaceWith(createAccountRecoveryView());
    root = null;
  }

  function hasPendingSettings() {
    return hasPendingDocuments() || profileSavePromise || profileSavedRevision !== profileRevision || primaryStateFeedback.state === "saving" || preferencePendingCount || preferenceRecovery || securityPromise || signInSecurity?.hasPending() || blockedSettings?.hasPending() || closureSettings?.hasPending() || closureSettings?.isReviewing() || closureAccountState.closure?.pending || document.querySelector("dialog.v2-settings-dialog[open]");
  }

  function resetView() {
    leaveSecurity();
    tabLayoutObserver?.disconnect();
    tabLayoutObserver = null;
    root = null;
    dirtyProfileFields.clear(); dirtyProfileBaselines.clear();
    profileStatus = null;
    profileFeedback = { copy: "Changes saved", state: "saved" };
    primaryStateFeedback = { copy: "Changes saved", state: "saved" };
    profileSaveButton = null;
    readinessNode = null;
    recoveryNode = null;
    securityLoaded = false;
    securityPromise = null;
    securityPanel = null;
    profilePanel = null;
    preferencesPanel = null;
    renderers.clear();
  }

  return Object.freeze({
    createLoadingView,
    render,
    renderPreview,
    afterMount,
    getCachedUser: () => user,
    hasUnsavedChanges: () => profileSavedRevision !== profileRevision || hasPendingDocuments() || closureSettings?.hasPending() || Boolean(closureAccountState.closure?.pending),
    getPendingClosure: () => closureAccountState.closure?.pending ? { ...closureAccountState.closure } : null,
    discardClosure() { delete closureAccountState.closure; clearClosureProof(); },
    clearDrafts: clearAccountDrafts,
    leave: leaveSecurity,
    invalidate() {
      if (hasPendingSettings()) return false;
      coreInvalidated = true;
      return true;
    },
  });
}
