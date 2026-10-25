import {enableSwipeDelete} from '../utils/swipe-delete.mjs';
import {normalizeAccent} from '../utils/appearance-controls.mjs';
import { cropFrame, cropDescriptor, restoreCrop, imageDimensions } from "./photo-crop.mjs";
import { applyAppearance, normalizeAppearance, createReadingSizeControl } from "../utils/appearance.mjs";
import { createResumeImport } from "./resume-import.mjs";
import { resumeImportSnapshot } from "./resume-import-model.mjs";
import { nativeSelectControl, portalIcon } from "../utils/portal-controls.mjs";
import { clearSession } from "../auth.js";
import { createSecurityApi } from "./security-api.mjs";
import { createSecurityView } from "./security-view.mjs";
import { createBlockedView } from "./blocked-view.mjs";
import { createClosureView } from "./closure-view.mjs";
import { clearClosureProof } from "../utils/account-closure-state.mjs";
import { startStripeOnboarding } from "../utils/stripe-connect.js";
import { projectCandidate } from "../attorney-v2/candidate-model.mjs";
import { renderCandidateProfile } from "../attorney-v2/candidate-profile.mjs";

const PROFILE_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROFILE_FIELDS = Object.freeze([
  "firstName",
  "lastName",
  "email",
  "phoneNumber",
  "linkedInURL",
  "yearsExperience",
  "state",
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
const FONT_SIZES = Object.freeze({ xs: "14px", sm: "15px", md: "16px", lg: "18px", xl: "20px" });
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

function profileSymbol(kind) {
  const icon = portalIcon('more');
  icon.querySelector('path').setAttribute('d', kind === 'education' ? 'm1 6 7-3 7 3-7 3Z M4 7.5v4c2 2 6 2 8 0v-4 M15 6v5' : 'M4 1.5h5l3 3v10H4Z M9 1.5V5h3 M6 8h4 M6 11h4');
  return icon;
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

function normalizedState(value) {
  const raw = text(value, 120);
  const upper = raw.toUpperCase();
  if (STATE_CODES.has(upper)) return upper;
  return STATE_NAME_TO_CODE.get(raw.toLowerCase()) || "";
}

function displayState(value) {
  const code = normalizedState(value);
  return STATES.find(([stateCode]) => stateCode === code)?.[1] || text(value, 120);
}

function currentTheme(value) {
  return normalizeAppearance(value);
}

function field(label, control, { copy = "", className = "" } = {}) {
  if (control.matches("input, textarea, select") && !control.hasAttribute("aria-label")) control.setAttribute("aria-label", label);
  const wrapper = node("label", { className: `v2-settings-field ${className}`.trim() }, [
    node("span", { className: "v2-settings-field__label" }, [document.createTextNode(label), control.getAttribute("aria-required") === "true" ? node("small", { className: "v2-settings-required", "aria-hidden": "true", text: "Required" }) : null]),
    control.matches("select") ? nativeSelectControl(control) : control,
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

const saveIndicatorTimers = new WeakMap();
function updateSaveIndicator(indicator, copy, state = "saved") {
  if (!indicator) return;
  clearTimeout(saveIndicatorTimers.get(indicator));
  saveIndicatorTimers.delete(indicator);
  indicator.dataset.state = state;
  // Successful saves are quiet. Keep instructions that require a next step.
  const description = state === "saved"
    ? (/check your inbox/i.test(copy) ? copy.replace(/^Saved\s*·\s*/i, "") : "")
    : String(copy || "");
  const show = (message) => {
    indicator.dataset.message = message;
    if (message) indicator.setAttribute("aria-label", message);
    else indicator.removeAttribute("aria-label");
    indicator.textContent = message;
  };
  show(state === "saving" ? "" : description);
  if (state === "saving") {
    saveIndicatorTimers.set(indicator, setTimeout(() => {
      saveIndicatorTimers.delete(indicator);
      if (indicator.isConnected && indicator.dataset.state === "saving") show(description);
    }, 750));
  }
}

function saveIndicator(attributes = {}) {
  const indicator = node("span", { className: "v2-settings-save-status", role: "status", "aria-live": "polite", ...attributes });
  updateSaveIndicator(indicator, "Saved", "saved");
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
    state: normalizedState(user.state || user.location),
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

function profilePayload(profile, { fields = PROFILE_FIELDS } = {}) {
  if (fields.includes('state') && !normalizedState(profile.state)) throw Object.assign(new Error('Choose your residence.'), { field: 'state' });
  if (fields.includes('firstName') && !text(profile.firstName, 150) || fields.includes('lastName') && !text(profile.lastName, 150)) {
    throw Object.assign(new Error("First and last name are required."), { field: fields.includes("firstName") && !text(profile.firstName, 150) ? "firstName" : "lastName" });
  }
  if (fields.includes('email') && !/^\S+@\S+\.\S+$/.test(text(profile.email, 320))) throw Object.assign(new Error("Enter a valid email address."), { field: "email" });
  if (fields.includes('yearsExperience') && (!Number.isInteger(Number(profile.yearsExperience)) || Number(profile.yearsExperience) < 0 || Number(profile.yearsExperience) > 80)) throw Object.assign(new Error('Enter a whole number of years between 0 and 80.'), {field:'yearsExperience'});
  let linkedInURL = profile.linkedInURL || null;
  try { if (fields.includes('linkedInURL')) linkedInURL = normalizeLinkedIn(profile.linkedInURL); }
  catch (error) { error.field = "linkedInURL"; throw error; }
  return {
    firstName: text(profile.firstName, 150),
    lastName: text(profile.lastName, 150),
    email: text(profile.email, 320),
    phoneNumber: text(profile.phoneNumber, 40),
    linkedInURL,
    yearsExperience: Math.max(0, Math.min(80, Number(profile.yearsExperience) || 0)),
    state: normalizedState(profile.state),
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

export function createSettingsView({ api, getIdentity, showToast, updateIdentity, invalidateHome, invalidateBrowse, invalidateWork, onSessionLost, onClosurePending, resumePresentation, onResumeSaved, onResumeManual, getPhotoReturnFocus }) {
  let user = null;
  let preferences = null;
  let root = null;
  let documentMenuController = null;
  let tabLayoutObserver = null;
  let corePromise = null;
  let coreRenderIsCurrent = () => true;
  let coreInvalidated = false;
  let interactionRevision = 0;
  let profile = null;
  let profileRevision = 0;
  let profileSavedRevision = 0;
  let profileSaveTimer = null;
  let profileSavePromise = null;
  let profileComposing = false;
  let profileToolbarInteracting = false;
  let profileAutosaveBlocked = false;
  const profileUndo = [], profileRedo = [];
  const PROFILE_AUTOSAVE_DELAY = 900;
  const dirtyProfileFields = new Map();
  const dirtyProfileBaselines = new Map();
  let profileStatus = null;
  let profileFeedback = { copy: "Changes saved", state: "saved" };
  let primaryStateFeedback = { copy: "Changes saved", state: "saved" };
  let profileSaveButton = null;
  let profileEditing = false;
  let profileCompositionScope = "";
  let photoEditing = false;
  let profileEditingTitle = null;
  let profileEditingIndex = null;
  let profileEditingProperty = null;
  let profileEditReturnLabel = null;
  let profileEditBusy = false;
  let readinessNode = null;
  let recoveryNode = null;
  let preferenceQueue = Promise.resolve();
  let preferencePendingCount = 0;
  let securityLoaded = false;
  let securityCategory = "signin";
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
  const profileElements = selector => [...(profilePanel?.querySelectorAll(selector) || [])];
  let preferencesPanel = null;
  let beforeUnloadBound = false;
  const renderers = new Map();
  const documentStates = new Map();
  const documentWindows = new Set();
  const hasPendingDocuments = () => [...documentStates.values()].some(state => state.busy || state.attempt || state.draftFile || state.draftRemove);

  let resumeImport = null;
  function resumeImporter() {
    if (resumeImport) return resumeImport;
    resumeImport = createResumeImport({
      presentation: resumePresentation, onSaved: onResumeSaved, onManual: onResumeManual,
      getUser: () => user,
      getProfile: () => resumeImportSnapshot(user),
      canOpen: () => !accountStopped && !profileEditing && !photoEditing && !profileSavePromise && !dirtyProfileFields.size && !hasPendingDocuments(),
      toast: message => showToast?.(message),
      readPolicy: () => accountTransport("/api/users/me/resume-import"),
      async extract(source, file, signal) {
        const context = accountContext(); await verifyAccount(context);
        const body = new FormData(); body.set("source", source); body.set("consent", "local-v1"); body.set("expectedOwnerId", context.ownerId);
        body.set("expectedResumeKey", profileDocumentValue(user, "resumeURL"));
        if (file) body.set("file", file, file.name);
        const result = await api.request("/api/users/me/resume-import", { method: "POST", body, signal });
        await verifyAccount(context); assertAccount(context); return result;
      },
      async apply(payload, baseline) {
        const context = accountContext();
        const current = await readAccountProfile(context);
        const normalized = resumeImportSnapshot(current);
        if (Object.keys(payload).some(field => !equal(normalized[field], baseline[field]))) throw new Error("Your profile changed while you reviewed. Cancel and reopen Autofill to review against the current values.");
        const attempt = { context, fields: new Map(Object.keys(payload).filter(field => PROFILE_FIELDS.includes(field)).map(field => [field, profileRevision])), payload, revision: profileRevision, historyBefore: normalizeProfile(current), historySnapshot: clone(current) };
        let updated;
        try { updated = await writeAccount("/api/users/me", "PATCH", { ...payload, expectedValues: expectedProfileValues(payload, current) }, context); }
        catch (error) {
          // A lost response may follow a successful commit. Read before retrying.
          const recovered = await readAccountProfile(context);
          if (!profileValuesMatch(recovered, payload)) throw error;
          updated = recovered;
        }
        applyProfileSnapshot(updated, attempt);
        rebuildProfilePanel();
        const oldPreview = document.querySelector("[data-v2-profile-preview]");
        if (oldPreview) { const replacement = await renderPreview({ isCurrent: () => !accountStopped }); if (replacement) oldPreview.replaceWith(replacement); }
        updateIdentity?.(updated); invalidateHome?.(); invalidateBrowse?.();
      },
    });
    return resumeImport;
  }

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
      throw new Error("The saved account could not be verified. Check your saved profile before trying again.");
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
    const focusedField = profilePanel?.contains(document.activeElement) ? document.activeElement.dataset.profileField : '';
    if (PROFILE_FIELDS.includes(focusedField) && !attempt.fields.has(focusedField) && !dirtyProfileBaselines.has(focusedField)) {
      // The user may have opened this field before an unrelated save returned.
      // Compare against what was visible, even if this response contains a
      // newer remote value that must not replace the focused editor.
      dirtyProfileBaselines.set(focusedField, expectedProfileValues({[focusedField]:profile[focusedField]}, user));
    }
    acceptAccountProfile(updated, attempt.context);
    if (!attempt.historyRecorded) {
      attempt.historyRecorded = true;
      if (attempt.historyOperation) {
        const { kind, entry } = attempt.historyOperation;
        const from = kind === 'undo' ? profileUndo : profileRedo;
        const to = kind === 'undo' ? profileRedo : profileUndo;
        if (from.at(-1) === entry) { from.pop(); if (kind !== 'undo' || profileRevision === attempt.revision) to.push(entry); if (to.length > 20) to.shift(); }
        entry[kind === 'undo' ? 'beforeSnapshot' : 'afterSnapshot'] = clone(updated);
      } else if (attempt.historyBefore) {
        const keys = [...attempt.fields.keys()].filter(key => key !== 'email');
        if (keys.length) {
          const after = normalizeProfile(updated);
          profileUndo.push({ before: Object.fromEntries(keys.map(key => [key, clone(attempt.historyBefore[key])])), after: Object.fromEntries(keys.map(key => [key, clone(after[key])])), beforeSnapshot: attempt.historySnapshot, afterSnapshot: clone(updated) });
          if (profileUndo.length > 20) profileUndo.shift();
          profileRedo.length = 0;
        }
      }
    }
    profileAutosaveBlocked = false;
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
    profileElements("[data-profile-field]").forEach(control => {
      const field = control.dataset.profileField;
      if (document.activeElement !== control && !dirtyProfileFields.has(field) && PROFILE_FIELDS.includes(field) && !Array.isArray(profile[field])) control.value = profile[field] ?? "";
    });
    for (const field of ["practiceAreas", "stateExperience", "skills", "bestFor", "experience", "education", "languages"]) if (!dirtyProfileFields.has(field) && !equal(previousProfile[field], profile[field])) renderers.get(field)?.();
    profileSavedRevision = attempt.revision;
    unresolvedProfileSave = null;
    profileConflict = null;
    if (!dirtyProfileFields.size) { profileSavedRevision = profileRevision; clearDraft(); }
    else persistDraft();
    setProfileStatus(dirtyProfileFields.size ? "Unsaved changes" : user.pendingEmail ? "Saved · check your inbox to confirm the new email" : "Changes saved", dirtyProfileFields.size ? "dirty" : "saved");
    renderers.get("emailNotice")?.(); renderers.get("photo")?.();
    updateIdentity?.(user); invalidateHome?.(); invalidateBrowse?.(); updateReadiness();
  }

  function reviewProfileConflict() {
    if (!profileConflict || accountStopped) return;
    const latest = profileConflict;
    const context = accountContext();
    profilePanel.querySelector('.v2-profile-conflict-review')?.remove();
    const dialog = node('section', { className: 'v2-profile-conflict-review', 'aria-label': 'Review profile changes' }, [node('p',{text:'Your profile changed elsewhere. Choose which version to keep.'})]);
    const target = profilePanel.querySelector('.is-row-editing > .v2-settings-card-body') || profilePanel;
    target.append(dialog);
    const latestProfile = normalizeProfile(latest);
    dirtyProfileFields.forEach((_revision, field) => {
      const labels = { practiceAreas: "Practice areas", stateExperience: "State experience", skills: "Skills", experience: "Experience", education: "Education", languages: "Languages", bestFor: "Preferred work" };
      const label = profilePanel?.querySelector(`[data-profile-field="${field}"]`)?.getAttribute("aria-label") || labels[field] || field;
      const format = value => Array.isArray(value)
        ? value.map(entry => entry && typeof entry === "object" ? Object.values(entry).filter(Boolean).join(" · ") : String(entry)).filter(Boolean).join("; ") || "Empty"
        : String(value ?? "") || "Empty";
      dialog.append(node("section", {}, [node("h3", { text: label }), node("p", { text: `Saved: ${format(latestProfile[field])}` }), node("p", { text: `Your draft: ${format(profile[field])}` })]));
    });
    const useLatest = action("Use saved version", { className: "v2-settings-secondary" });
    const keep = action("Save my changes", { className: "v2-settings-primary" });
    const cancel = action("Cancel", { className: "v2-settings-secondary" });
    cancel.addEventListener("click", () => dialog.remove());
    useLatest.addEventListener("click", async () => {
      try { await verifyAccount(context); } catch (error) { if (!accountStopped) showToast?.(error.message); return; }
      assertAccount(context); user = latest; profile = normalizeProfile(latest); dirtyProfileFields.clear(); dirtyProfileBaselines.clear(); profileSavedRevision = profileRevision;
      profileConflict = null; unresolvedProfileSave = null; profileAutosaveBlocked = false; profileUndo.length = profileRedo.length = 0; clearDraft(); dialog.remove(); profileEditing = false; profileEditingTitle = null; profileEditingIndex = null; rebuildProfilePanel(); setProfileStatus("Changes saved", "saved"); updateIdentity?.(user);
    });
    keep.addEventListener("click", async () => {
      try { await verifyAccount(context); } catch (error) { if (!accountStopped) showToast?.(error.message); return; }
      assertAccount(context); user = latest;
      dirtyProfileFields.forEach((_revision, field) => dirtyProfileBaselines.set(field, expectedProfileValues({ [field]: profile[field] }, latest)));
      profileConflict = null; unresolvedProfileSave = null; profileAutosaveBlocked = false; dialog.remove(); void saveProfile({ automatic: !dirtyProfileFields.has("email") });
    });
    dialog.append(node("div", { className: "v2-profile-conflict-actions" }, [useLatest, keep, cancel])); useLatest.focus();
  }

  async function recoverProfileSave(attempt, originalError) {
    profileAutosaveBlocked = true;
    try {
      const latest = await readAccountProfile(attempt.context);
      if (profileValuesMatch(latest, attempt.payload)) { applyProfileSnapshot(latest, attempt); return true; }
      unresolvedProfileSave = null;
      const untouched = Object.entries(attempt.expectedValues).every(([key, value]) => equal(latest[key], value));
      if (untouched) {
        user = latest;
        const reason = originalError?.name === "AbortError" ? "The profile save timed out." : originalError?.message;
        setProfileStatus(reason ? `${reason} Your changes are still here. Try again.` : "Your edits weren’t saved. Try again.", "error");
      } else {
        profileConflict = latest;
        setProfileStatus("This profile changed in another session. Review your saved profile.", "error");
        setProfileAction("Review saved profile");
      }
      return false;
    } catch (error) {
      if (attempt.context.generation !== accountGeneration || accountStopped) return false;
      unresolvedProfileSave = attempt;
      setProfileStatus("Save status is unknown. Check saved profile before trying again.", "error");
      setProfileAction("Check saved profile");
      return false;
    }
  }

  function draftKey() {
    const id = text(user?._id || user?.id || user?.email, 320).toLowerCase();
    return id ? `${PROFILE_DRAFT_PREFIX}:${id}` : "";
  }

  let draftWriteRevision = 0;
  let recoveredDraft = null;
  let draftReadPromise = null;
  let draftSealPending = null;
  let draftSealRunning = false;

  function clearDraft() {
    draftWriteRevision += 1; recoveredDraft = null; draftSealPending = null;
    const key = draftKey();
    if (!key) return;
    try { sessionStorage.removeItem(key); } catch {}
  }

  function persistDraft() {
    const key = draftKey();
    if (!key || !profile) return;
    if (!dirtyProfileFields.size) { clearDraft(); return; }
    const revision = ++draftWriteRevision;
    const context = accountContext();
    const draft = clone({
      savedAt: Date.now(), serverUpdatedAt: String(user?.updatedAt || ""),
      fields: [...dirtyProfileFields.keys()], baselines: Object.fromEntries(dirtyProfileBaselines),
      profile: Object.fromEntries([...dirtyProfileFields.keys()].map(field => [field, profile[field]])),
    });
    draftSealPending = { key, revision, context, draft };
    void sealPendingDraft();
  }

  async function sealPendingDraft() {
    if (draftSealRunning) return;
    draftSealRunning = true;
    try {
      while (draftSealPending) {
        const pending = draftSealPending; draftSealPending = null;
        try {
          assertAccount(pending.context);
          const result = await accountTransport("/api/account/profile-draft/seal", {
            method: "POST", body: JSON.stringify({ expectedOwnerId: pending.context.ownerId, draft: pending.draft }),
          });
          assertAccount(pending.context);
          if (pending.revision !== draftWriteRevision || !dirtyProfileFields.size || typeof result?.capsule !== "string") continue;
          sessionStorage.setItem(pending.key, result.capsule);
        } catch { /* Keep unsaved values in the editor and retain the unload guard. */ }
      }
    } finally { draftSealRunning = false; }
  }

  async function loadProtectedDraft() {
    if (draftReadPromise) return draftReadPromise;
    const key = draftKey();
    if (!key || recoveredDraft || dirtyProfileFields.size) return;
    const context = accountContext(), revision = draftWriteRevision;
    let capsule;
    try { capsule = sessionStorage.getItem(key); } catch { return; }
    if (!capsule) return;
    draftReadPromise = (async () => {
      try {
        let parsed;
        if (capsule.startsWith("enc:v1:")) {
          const result = await accountTransport("/api/account/profile-draft/open", {
            method: "POST", body: JSON.stringify({ expectedOwnerId: context.ownerId, capsule }),
          });
          parsed = result.draft;
        } else {
          // Preserve an earlier same-owner draft while replacing its plaintext
          // storage immediately. Never write legacy plaintext back to storage.
          parsed = JSON.parse(capsule);
          sessionStorage.removeItem(key);
          // Keep legacy recovery available in memory even if re-encryption is
          // temporarily unavailable. Stored plaintext is never reintroduced.
          try {
            const result = await accountTransport("/api/account/profile-draft/seal", {
              method: "POST", body: JSON.stringify({ expectedOwnerId: context.ownerId, draft: parsed }),
            });
            assertAccount(context);
            if (revision === draftWriteRevision && typeof result?.capsule === "string") sessionStorage.setItem(key, result.capsule);
          } catch { assertAccount(context); }
        }
        assertAccount(context);
        if (revision !== draftWriteRevision || dirtyProfileFields.size) return;
        const age = Date.now() - Number(parsed?.savedAt || 0);
        if (!parsed?.profile || age < 0 || age > PROFILE_DRAFT_MAX_AGE_MS) { clearDraft(); return; }
        const saved = normalizeProfile(user);
        const fields = Array.isArray(parsed.fields) ? parsed.fields : PROFILE_FIELDS;
        if (!fields.some(field => PROFILE_FIELDS.includes(field) && !equal(parsed.profile[field], saved[field]))) { clearDraft(); return; }
        recoveredDraft = parsed;
      } catch (error) {
        // Transient offline/server failures retain the encrypted capsule for
        // retry. Invalid/expired ciphertext is discarded, never rendered.
        if (error?.status === 400 && revision === draftWriteRevision) clearDraft();
      }
    })().finally(() => { draftReadPromise = null; });
    return draftReadPromise;
  }

  function readDraft() { return recoveredDraft; }

  async function loadCore({ force = false, isCurrent = () => true } = {}) {
    // Concurrent renders share the read, but only the latest live navigation
    // may retire the controller attached to the visible Settings view.
    coreRenderIsCurrent = isCurrent;
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
      if (!coreRenderIsCurrent()) return { user, preferences };
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
    if (profileStatus) profileStatus.hidden = Boolean(profilePanel?.querySelector('.v2-profile-save-all:not([hidden])')) || localProfileError(current) || (hasPendingDocuments() || primaryError) && ["saved", "idle"].includes(current.state);
  }

  function localProfileError(feedback) {
    return feedback.state === "error" && profileElements('.v2-settings-field-error').some(error => error.textContent === feedback.copy && error.getClientRects().length);
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
      profileSaveButton.hidden = true;
      profileSaveButton.disabled = state === "saving";
    }
    renderers.get('profileEditActions')?.();
  }

  function updateReadiness() {
    if (!readinessNode || !profile) return;
    renderers.get("profileRows")?.();
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
      const edit = target?.querySelector(".v2-profile-row-edit");
      if (edit) edit.click();
      else target?.querySelector("button:not([hidden]):not(:disabled)")?.focus({ preventScroll: true });
    });
    readinessNode.append(copy, review);
  }

  function updateCollectionRenderer(name) {
    renderers.get(name)?.();
    markProfileChanged(name);
  }

  function markProfileChanged(field = "") {
    profileRevision += 1;
    profileAutosaveBlocked = false; profileRedo.length = 0;
    const fields = PROFILE_FIELDS.includes(field) ? [field] : PROFILE_FIELDS;
    const saved = normalizeProfile(user);
    fields.forEach(key => {
      if (equal(profile[key], saved[key])) { dirtyProfileFields.delete(key); dirtyProfileBaselines.delete(key); return; }
      if (!dirtyProfileBaselines.has(key)) dirtyProfileBaselines.set(key, expectedProfileValues({ [key]: profile[key] }));
      dirtyProfileFields.set(key, profileRevision);
    });
    if (!dirtyProfileFields.size) profileSavedRevision = profileRevision;
    persistDraft();
    updateReadiness();
    setProfileStatus(dirtyProfileFields.size ? "Unsaved changes" : "Changes saved", dirtyProfileFields.size ? "dirty" : "saved");
    scheduleProfileAutosave();
  }

  function scheduleProfileAutosave(immediate = false) {
    window.clearTimeout(profileSaveTimer); profileSaveTimer = null;
    if (accountStopped || profileComposing || profileToolbarInteracting || profileAutosaveBlocked || profileConflict || unresolvedProfileSave || ![...dirtyProfileFields.keys()].some(key => key !== 'email')) return;
    profileSaveTimer = window.setTimeout(() => { profileSaveTimer = null; void saveProfile({ automatic: true }); }, immediate ? 0 : PROFILE_AUTOSAVE_DELAY);
  }

  async function revertProfileEdit(kind) {
    if (accountStopped || !profile || !user) return;
    if (profileSavePromise || unresolvedProfileSave || profileConflict || profileEditBusy) return;
    window.clearTimeout(profileSaveTimer); profileSaveTimer = null;
    const pending = [...dirtyProfileFields.keys()];
    if (kind === 'undo' && pending.length) {
      const saved = normalizeProfile(user);
      const reversible = pending.filter(key => key !== 'email' && !equal(profilePayload(profile, {fields:[]})[key], profilePayload(saved, {fields:[]})[key]));
      if (reversible.length) profileRedo.push({ before: Object.fromEntries(reversible.map(key => [key,clone(saved[key])])), after: Object.fromEntries(reversible.map(key => [key,clone(profile[key])])), beforeSnapshot: clone(user), afterSnapshot: clone(user) });
      pending.forEach(key => { profile[key] = clone(saved[key]); dirtyProfileFields.delete(key); dirtyProfileBaselines.delete(key); });
      profileRevision++; if (!dirtyProfileFields.size) profileSavedRevision = profileRevision;
      profileAutosaveBlocked = false; persistDraft();
      profileEditing = false; profileEditingTitle = null; profileEditingIndex = null; profileEditingProperty = null;
      rebuildProfilePanel(); setProfileStatus(dirtyProfileFields.has('email') ? 'Email change needs verification' : 'Saved', 'saved');
      return;
    }
    if (dirtyProfileFields.size) return;
    const entry = (kind === 'undo' ? profileUndo : profileRedo).at(-1);
    if (!entry) return;
    const values = kind === 'undo' ? entry.before : entry.after;
    const snapshot = kind === 'undo' ? entry.afterSnapshot : entry.beforeSnapshot;
    profileEditBusy = true;
    try {
      Object.entries(values).forEach(([key,value]) => {
        profile[key] = clone(value); dirtyProfileFields.set(key, ++profileRevision);
        dirtyProfileBaselines.set(key, expectedProfileValues({[key]:value}, snapshot));
      });
      persistDraft();
      // Reflect the reversal before writing, then allow the next field to open.
      // A confirmed response must never close a newer editor or erase its draft.
      profileEditing = false; profileEditingTitle = null; profileEditingIndex = null; profileEditingProperty = null;
      rebuildProfilePanel(); profileEditBusy = false;
      await saveProfile({ automatic: true, historyOperation: {kind,entry} });
    } finally { profileEditBusy = false; renderers.get('profileEditActions')?.(); }
  }

  async function saveProfile({ automatic = false, historyOperation = null } = {}) {
    window.clearTimeout(profileSaveTimer); profileSaveTimer = null;
    if (accountStopped) return false;
    if (profileSavePromise) return profileSavePromise;
    if (profileConflict) { reviewProfileConflict(); return false; }
    if (unresolvedProfileSave) {
      const attempt = unresolvedProfileSave;
      profileSavePromise = recoverProfileSave(attempt).finally(() => { if (attempt.context.generation === accountGeneration) { profileSavePromise = null; renderers.get('profileEditActions')?.(); } });
      return profileSavePromise;
    }
    if (profileSavedRevision === profileRevision) return true;
    const saved = normalizeProfile(user);
    const fields = new Map(), payload = {}, errors = [];
    // Validate changed fields independently: an unfinished name must not block
    // a valid About edit. Never send an incomplete whole-profile snapshot.
    for (const [field, revision] of dirtyProfileFields) {
      if (automatic && field === 'email') continue;
      try {
        const candidate = profilePayload({ ...saved, [field]: profile[field] }, { fields: [field] });
        if (equal(candidate[field], profilePayload(saved, { fields: [] })[field])) {
          if (!Array.isArray(candidate[field])) profile[field] = candidate[field];
          dirtyProfileFields.delete(field); dirtyProfileBaselines.delete(field); continue;
        }
        fields.set(field, revision); payload[field] = candidate[field];
      } catch (error) { errors.push(error); }
    }
    if (!fields.size) {
      if (errors.length) { showProfileFieldError(errors[0].field, errors[0].message, { focus: !automatic }); setProfileStatus(errors[0].message + ' Not saved.', 'error'); }
      else if (!dirtyProfileFields.size) { profileSavedRevision = profileRevision; clearDraft(); setProfileStatus('Saved', 'saved'); }
      else setProfileStatus('Email change needs verification', 'dirty');
      return !dirtyProfileFields.size;
    }
    const attempt = { context: accountContext(), revision: profileRevision, fields, payload, expectedValues: Object.assign({}, ...[...fields.keys()].map(field => dirtyProfileBaselines.get(field) || expectedProfileValues({ [field]: payload[field] }))), historyBefore: clone(saved), historySnapshot: clone(user), historyOperation };
    unresolvedProfileSave = attempt;
    setProfileAction("Save changes");
    setProfileStatus("Saving…", "saving");
    let committed = false;
    profileSavePromise = (async () => {
      try {
        const updated = await writeAccount("/api/users/me", "PATCH", { ...payload, expectedValues: attempt.expectedValues }, attempt.context);
        applyProfileSnapshot(updated, attempt); committed = true;
        if (errors.length) { showProfileFieldError(errors[0].field, errors[0].message, { focus: false }); setProfileStatus(errors[0].message + ' Other valid changes saved.', 'error'); }
        return true;
      } catch (error) {
        if (attempt.context.generation !== accountGeneration || accountStopped) return false;
        committed = await recoverProfileSave(attempt, error); return committed;
      } finally {
        if (attempt.context.generation === accountGeneration) {
          profileSavePromise = null;
          renderers.get('profileEditActions')?.();
          // Only newer edits queue another write. Failed/invalid snapshots never
          // loop or retry an uncertain mutation without checking saved state.
          if (committed && !errors.length && profileRevision > attempt.revision) scheduleProfileAutosave(true);
        }
      }
    })();
    return profileSavePromise;
  }

  function showProfileFieldError(key, message, { focus = true } = {}) {
    let control = profileElements(`[data-profile-field="${key}"]`)[0];
    if (focus && control && !control.getClientRects().length && !profileEditBusy) {
      const labels = { firstName:'Edit personal details name', lastName:'Edit personal details name', state:'Edit personal details state', yearsExperience:'Edit personal details yearsExperience', email:'Edit email', linkedInURL:'Edit linkedin' };
      if (labels[key]) {
        if (profileEditing) finishProfileEdit();
        [...profilePanel.querySelectorAll('.lpc-profile-value')].find(button => button.getAttribute('aria-label') === labels[key])?.click();
        control = profileElements(`[data-profile-field="${key}"]`)[0];
      }
    }
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
    if (focus) requestAnimationFrame(() => control.focus({ preventScroll: true }));
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
    return control;
  }

  function tokenEditor({ key, label, copy, placeholder, options = [], normalize = (value) => text(value, 200), section = "", maximum = 50 }) {
    const wrapper = node("section", { className: "v2-settings-card v2-profile-inline-tokens", "data-profile-section": section || key, tabindex: "0", "aria-label": `Edit ${label.toLowerCase()}` }, [
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
    const addValue = ({ focus = true } = {}) => {
      const value = normalize(entry.value);
      if (!value || list(profile[key]).includes(value)) return;
      if (list(profile[key]).length >= maximum) {
        showToast?.(`You can list up to ${maximum} ${label.toLowerCase()}.`);
        return;
      }
      profile[key] = [...list(profile[key]), value];
      entry.value = "";
      updateCollectionRenderer(key);
      if (focus) entry.focus();
    };
    add.addEventListener("click", addValue);
    entry.addEventListener('blur', () => queueMicrotask(() => {
      if (!accountStopped && entry.isConnected && !controls.contains(document.activeElement) && entry.value.trim()) addValue({ focus: false });
    }));
    if (options.length) entry.addEventListener("change", addValue);
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
    const photoAction = action(photoOf(user) ? "Change photo" : "Add photo", { className: "v2-settings-photo-action", hidden: true, tabindex: "-1", "aria-hidden": "true" });
    if (photoOf(user)) { photoAction.setAttribute("aria-haspopup", "menu"); photoAction.setAttribute("aria-expanded", "false"); }
    const refreshSummary = () => {
      const status = text(user.profilePhotoStatus, 40).toLowerCase();
      summaryReview.textContent = status === "pending_review"
        ? "Awaiting LPC review"
        : status === "rejected" ? "A new photo is required"
          : "New photos require approval. Cropping an approved photo does not require another review.";
      summaryReview.hidden = status === "approved";
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
    }, [image, initials, node("span", { className: "v2-settings-photo-pencil", "aria-hidden": "true" })]);
    const pencil = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    pencil.setAttribute("viewBox", "0 0 24 24"); pencil.setAttribute("aria-hidden", "true");
    const pencilPath = document.createElementNS(pencil.namespaceURI, "path");
    pencilPath.setAttribute("d", "m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z");
    pencil.append(pencilPath); photoButton.querySelector(".v2-settings-photo-pencil").append(pencil);
    photoButton.title = "Edit profile photo";
    image.hidden = false;
    initials.hidden = true;

    const fileInput = input({ type: "file", accept: ".jpg,.jpeg,.png,image/jpeg,image/png", hidden: true, "aria-label": "Choose profile photo" });
    const menu = node("div", { className: "v2-settings-photo-menu", role: "menu", hidden: true }, [
      action(photoOf(user) ? "Change photo" : "Add photo", { className: "v2-settings-menu-action", role: "menuitem", "data-photo-change": "" }),
      action("Edit", { className: "v2-settings-menu-action", role: "menuitem", hidden: !photoOf(user), "data-photo-edit": "" }),
      action("Remove photo", { className: "v2-settings-menu-action v2-settings-menu-action--danger", role: "menuitem", hidden: !photoOf(user), "data-photo-remove": "" }),
    ]);
    const photoWrap = node("div", { className: "v2-settings-photo-wrap" }, [photoButton, fileInput, menu]);
    const refreshPhoto = () => {
      refreshSummary();
      const url = photoOf(user);
      image.hidden = false;
      initials.hidden = true;
      image.src = url || "/assets/avatar-placeholder.svg";
      initials.textContent = initialsOf(user);
      photoButton.setAttribute("aria-label", url ? "Open profile photo actions" : "Add profile photo");
      photoAction.textContent = url ? "Change photo" : "Add photo";
      if (url) { photoAction.setAttribute("aria-haspopup", "menu"); photoAction.setAttribute("aria-expanded", "false"); }
      else { photoAction.removeAttribute("aria-haspopup"); photoAction.removeAttribute("aria-expanded"); }
      menu.querySelector("[data-photo-change]").textContent = url ? "Change photo" : "Add photo";
      menu.querySelector("[data-photo-edit]").hidden = !url;
      menu.querySelector("[data-photo-remove]").hidden = !url;
      renderers.get("visibilityControl")?.();
    };
    renderers.set("photo", refreshPhoto);

    function closePhotoMenu({ restoreFocus = false } = {}) {
      menu.hidden = true;
      photoButton.setAttribute("aria-expanded", "false");
      if (photoAction.hasAttribute("aria-haspopup")) photoAction.setAttribute("aria-expanded", "false");
      if (restoreFocus) photoButton.focus();
    }
    photoButton.addEventListener("click", () => {
      if (photoEditing || profileEditing || [...documentStates.values()].some(state => state.editing)) return;
      if (!photoOf(user)) {
        fileInput.click();
        return;
      }
      const open = menu.hidden;
      menu.hidden = !open;
      photoButton.setAttribute("aria-expanded", String(open));
      photoAction.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("button:not([hidden])")?.focus();
    });
    photoAction.addEventListener("click", () => photoButton.click());
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
      photoEditing = true; renderers.get('profileEditActions')?.();
      const removal = node('div', {className:'v2-profile-photo-removal'}, [node('span',{text:'Remove photo?'}), action('Save',{className:'v2-profile-form-save','aria-label':'Save photo removal'}), action('Cancel',{className:'v2-profile-form-cancel','aria-label':'Cancel photo removal'})]);
      photoButton.hidden = true; photoWrap.append(removal);
      const confirmed = await new Promise(resolve => {
        removal.querySelector('.v2-profile-form-save').addEventListener('click',()=>resolve(true));
        removal.querySelector('.v2-profile-form-cancel').addEventListener('click',()=>resolve(false));
        removal.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();resolve(false);}});
        removal.querySelector('button').focus();
      });
      removal.remove(); photoButton.hidden = false; photoEditing = false; renderers.get('profileEditActions')?.(); photoButton.focus();
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
      if (!photoWrap.isConnected || menu.hidden || photoWrap.contains(event.target) || photoAction.contains(event.target)) return;
      closePhotoMenu();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePhotoMenu({ restoreFocus: true });
    });

    return node("aside", { className: "v2-settings-identity-card", "data-profile-section": "profile-photo" }, [
      photoWrap,
      node("div", { className: "v2-settings-identity-copy" }, [
        photoAction, summaryReview,
      ]),
    ]);
  }

  function basicProfileCards() {
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
    const linkedIn = bindProfileInput(input({ type: "url", value: profile.linkedInURL, autocomplete: "url", maxlength: "500", placeholder: "linkedin.com/in/your-name" }), "linkedInURL", (value) => text(value, 500));
    return {
      publicIdentity: node("section", { className: "v2-settings-card v2-settings-card--identity" }, [
        sectionHeader("Name"),
        node("div", { className: "v2-settings-field-grid v2-settings-personal-fields" }, [field("First name", first), field("Last name", last)]),
      ]),
      contact: node("section", { className: "v2-settings-card v2-settings-card--contact" }, [
        sectionHeader("Account details", "Your email is not shown to attorneys."),
        node("div", { className: "v2-settings-field-grid" }, [emailField]),
      ]),
      linkedIn: node("section", { className: "v2-settings-card" }, [sectionHeader("LinkedIn"), field("Profile URL", linkedIn)]),
    };
  }

  function bioCard() {
    const control = bindProfileInput(textarea({ rows: "1", maxlength: "4000", value: profile.bio, "aria-label": "Bio" }), "bio", (value) => String(value || "").slice(0, 4000));
    const counter = node("span", { className: "v2-settings-counter", text: `${profile.bio.length} / 4000` });
    const resize = () => { if (profileEditing) return; control.style.height = "auto"; control.style.height = `${Math.max(90, control.scrollHeight)}px`; };
    control.addEventListener("input", () => { counter.textContent = `${control.value.length} / 4000`; resize(); });
    requestAnimationFrame(resize);
    return node("section", { className: "v2-settings-card", "data-profile-section": "bio" }, [
      sectionHeader("About", "", true),
      control,
      counter,
    ]);
  }

  function canSwipeProfileDelete() {
    return !accountStopped && !photoEditing && !profileEditBusy && !profileSavePromise && !profileConflict && !unresolvedProfileSave;
  }
  function focusProfileCollection(title, addLabel) {
    requestAnimationFrame(() => profilePanel?.querySelector(`.lpc-profile-value[aria-label^="Edit ${title.toLowerCase()}"],.v2-profile-inline-add[aria-label="${addLabel}"]`)?.focus({preventScroll:true}));
  }
  function swipeSavedProfileEntry(row, key, title, index, addLabel) {
    enableSwipeDelete(row, {label:`${title.toLowerCase()} entry ${index+1}`,preserveLabel:key==='languages',canDelete:canSwipeProfileDelete,onDelete:()=>{
      if (profileEditing && !finishProfileEdit()) return;
      const remove = profilePanel?.querySelector(`[data-profile-section="${key}"] [data-profile-entry="${index}"] .v2-profile-entry-remove`);
      remove?.click();
      if (profileEditing) finishProfileEdit();
      focusProfileCollection(title,addLabel);
    }});
  }

  function repeaterCard({ key, title, addLabel, createEntry, renderEntry, fields }) {
    const section = node("section", { className: "v2-settings-card", "data-profile-section": key }, [sectionHeader(title)]);
    const rows = node("div", { className: "v2-settings-repeater" });
    const add = action(addLabel, { className: "v2-settings-text-action" });
    const render = () => {
      rows.replaceChildren();
      profile[key].forEach((entry, index) => {
        const row = node("article", { className: "v2-profile-entry", "data-profile-entry": String(index) });
        const value = node('div', { className: 'v2-profile-entry-value' });
        const editor = renderEntry(entry, index);
        editor.classList.add('v2-profile-entry-fields');
        editor.querySelectorAll('input, textarea, select').forEach((control, fieldIndex) => {
          const fieldName = fields[fieldIndex];
          control.dataset.profileField = key;
          control.closest('.v2-settings-field').dataset.entryProperty = fieldName;
          const update = () => {
            // Blur repeats the input value; keep a failed save available for Retry.
            if (key === 'education' && fieldName && profile[key][index]?.[fieldName] === control.value) return;
            if (fieldName && profile[key][index]) profile[key][index][fieldName] = control.value;
            markProfileChanged(key);
          };
          control.addEventListener('input', update);
          control.addEventListener('change', update);
        });
        if (key === 'education') {
          const byField = name => editor.querySelector(`[data-entry-property="${name}"]`);
          const main = node('div', {className:'v2-profile-entry-main'});
          byField('school').querySelector('input').setAttribute('aria-label','Institution');
          byField('fieldOfStudy').querySelector('input').setAttribute('aria-label','Subject');
          for (const name of ['degree','fieldOfStudy','school']) {
            const group = byField(name);
            if (name === 'school') group.classList.add('v2-profile-entry-wide');
            const control = group.querySelector('input');
            control.placeholder = {school:'Institution',degree:'Degree',fieldOfStudy:'Subject'}[name];
            main.append(group);
          }
          const dates = node('div', {className:'v2-profile-entry-dates'});
          for (const [prefix,label] of [['start','Started'],['end','Finished']]) {
            const month = byField(prefix+'Month'), year = byField(prefix+'Year');
            month.querySelector('select').options[0].textContent = 'Month';
            year.querySelector('input').placeholder = 'Year';
            dates.append(node('div',{className:'v2-profile-entry-date-pair',role:'group','aria-label':label},[
              node('span',{className:'v2-profile-entry-date-heading',text:label}),month,year,
            ]));
          }
          const extra = node('details',{className:'v2-profile-entry-extra',open:Boolean(entry.grade || entry.activities)},[
            node('summary',{text:'Additional details'}),byField('grade'),byField('activities'),
          ]);
          extra.querySelector('input').placeholder='Grade (optional)';
          extra.querySelector('textarea').placeholder='Activities (optional)';
          editor.replaceChildren(main,dates,extra);
        } else if (key === 'experience') {
          const placeholders = {title:'Role / title',years:'Dates / years',description:'Organization and description'};
          editor.querySelectorAll('[data-entry-property]').forEach(group=>{const control=group.querySelector('input,textarea');control.placeholder=placeholders[group.dataset.entryProperty] || '';});
        }
        const remove = action(key === 'education' ? 'Remove education' : 'Remove entry', { className: 'v2-settings-text-action v2-settings-text-action--danger' });
        remove.addEventListener('click', () => {
          profile[key].splice(index, 1);
          profileEditingIndex = null;
          markProfileChanged(key); render(); renderers.get('profileMode')?.();
        });
        const controls = node('div', { className: 'v2-profile-entry-editor' }, [editor, remove]);
        const removePreview = action('Remove', { className: 'v2-profile-entry-remove', 'aria-label': `Remove ${title.toLowerCase()} entry ${index + 1}` });
        removePreview.addEventListener('click', () => {
          if (!beginProfileEdit(title,index,addLabel)) return;
          remove.click();
        });
        const order = key === 'education' ? ['degree','fieldOfStudy','school','startMonth','startYear','endMonth','endYear','grade','activities'] : fields;
        order.filter(fieldName => entry[fieldName]).forEach(fieldName => {
          const fieldLabel = editor.querySelector(`[data-entry-property="${fieldName}"] .v2-settings-field__label`)?.textContent || fieldName;
          const editValue = action('', { className: 'v2-profile-entry-property', 'aria-label': `Edit ${fieldLabel.toLowerCase()}, ${title.toLowerCase()} entry ${index + 1}` });
          editValue.append(node('span', { className: 'v2-profile-entry-text', text: entry[fieldName] }));
          editValue.append(node('span', { className: 'v2-profile-edit-label', text: 'Edit', 'aria-hidden': 'true' }));
          if (fieldName === 'school' || fieldName === 'proficiency') editValue.classList.add('is-secondary');
          editValue.addEventListener('click', () => {
            row.style.minHeight = `${row.offsetHeight}px`;
            if (!beginProfileEdit(title, index, editValue.getAttribute('aria-label'), fieldName)) return;
            requestAnimationFrame(() => editor.querySelector(`[data-entry-property="${fieldName}"] input,[data-entry-property="${fieldName}"] select,[data-entry-property="${fieldName}"] textarea`)?.focus({ preventScroll: true }));
          });
          value.append(node('div', { className: 'v2-profile-entry-preview-field' }, [node('span', { className: 'v2-profile-entry-label', text: fieldLabel }), editValue]));
        });
        const missing = fields.filter(fieldName => !entry[fieldName]);
        if (missing.length) {
          const choose = select([['','Add detail…'], ...missing.map(fieldName => [fieldName, editor.querySelector(`[data-entry-property="${fieldName}"] .v2-settings-field__label`)?.textContent || fieldName])], { 'aria-label': `Add detail to ${title.toLowerCase()} entry ${index + 1}`, className: 'v2-profile-entry-add-detail' });
          choose.addEventListener('change', () => {
            const fieldName = choose.value; choose.value = '';
            row.style.minHeight = `${row.offsetHeight}px`;
            if (!fieldName || !beginProfileEdit(title,index,choose.getAttribute('aria-label'),fieldName)) return;
            requestAnimationFrame(() => editor.querySelector(`[data-entry-property="${fieldName}"] input,[data-entry-property="${fieldName}"] select,[data-entry-property="${fieldName}"] textarea`)?.focus({ preventScroll: true }));
          });
          value.append(choose);
        }
        value.append(removePreview);
        row.append(value, controls);
        enableSwipeDelete(row, {label:`${title.toLowerCase()} entry ${index+1}`,trigger:remove,canDelete:canSwipeProfileDelete,onDelete:()=>{
          remove.click(); finishProfileEdit(); focusProfileCollection(title,addLabel);
        }});
        rows.append(row);
      });
    };
    renderers.set(key, render);
    add.addEventListener('click', () => {
      if (!beginProfileEdit(title, profile[key].length, addLabel, fields[0])) return;
      profile[key].push(createEntry()); markProfileChanged(key); render();
      renderers.get('profileMode')?.();
      // Preview controls precede the editor in DOM order and are hidden while
      // adding an entry. Focus its active property instead of that preview.
      requestAnimationFrame(() => rows.lastElementChild?.querySelector(
        `[data-entry-property="${fields[0]}"] input,[data-entry-property="${fields[0]}"] select,[data-entry-property="${fields[0]}"] textarea`
      )?.focus({ preventScroll: true }));
    });
    render(); section.append(rows, add); return section;
  }

  function experienceCard() {
    // Reuse the existing three-field experience contract; no inferred employer
    // or dates; the existing multi-field save carries these records unchanged.
    return repeaterCard({
      key: "experience", title: "Work experience", addLabel: "Add work experience",
      createEntry: () => ({ title: "", years: "", description: "" }),
      fields: ["title", "years", "description"],
      renderEntry: entry => node("div", { className: "v2-settings-field-grid" }, [
        field("Role / title", input({ type: "text", value: entry.title, maxlength: "300" })),
        field("Dates / years", input({ type: "text", value: entry.years, maxlength: "120" })),
        field("Organization & description", textarea({ rows: "4", value: entry.description, maxlength: "5000" }), { className: "v2-settings-field--wide" }),
      ]),
    });
  }

  function educationCard() {
    // Keep full month names from existing records selected without rewriting
    // stored dates when the user edits a different education field.
    const monthOptions = current => {
      const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const choices = MONTHS.map((short,index)=>[current === names[index] ? current : short,names[index]]);
      if(current && !choices.some(([value])=>value === current))choices.unshift([current,current]);
      return [['','Month'],...choices];
    };
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
        field("Start month", select(monthOptions(entry.startMonth), { value: entry.startMonth })),
        field("Start year", input({ type: "text", value: entry.startYear, maxlength: "10", inputmode: "numeric" })),
        field("End month", select(monthOptions(entry.endMonth), { value: entry.endMonth })),
        field("End year", input({ type: "text", value: entry.endYear, maxlength: "10", inputmode: "numeric" })),
        field("Activities", textarea({ rows: "3", value: entry.activities, maxlength: "1000" }), { className: "v2-settings-field--wide" }),
      ]),
    });
  }

  function languageCard() {
    return repeaterCard({
      key: "languages",
      title: "Languages",
      copy: "",
      addLabel: "Add language",
      emptyCopy: "No languages added yet.",
      createEntry: () => ({ name: "", proficiency: "" }),
      fields: ["name"],
      renderEntry: (entry) => node("div", { className: "v2-settings-field-grid" }, [
        field("Language", input({ type: "text", value: entry.name, maxlength: "120" })),
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
      sectionHeader("Documents"),
    ]);
    documentMenuController?.abort();
    documentMenuController = new AbortController();
    const closeOtherMenus = (target) => {
      section.querySelectorAll('.v2-profile-document-menu[open]').forEach(menu => {
        if (!menu.contains(target)) menu.open = false;
      });
    };
    document.addEventListener('click', event => closeOtherMenus(event.target), { capture: true, signal: documentMenuController.signal });
    let pointerInteracting = false;
    document.addEventListener('pointerdown', () => { pointerInteracting = true; }, { capture: true, signal: documentMenuController.signal });
    document.addEventListener('click', () => { pointerInteracting = false; }, { signal: documentMenuController.signal });
    document.addEventListener('pointercancel', () => { pointerInteracting = false; }, { signal: documentMenuController.signal });
    document.addEventListener('keydown', () => { pointerInteracting = false; }, { capture: true, signal: documentMenuController.signal });
    document.addEventListener('focusin', event => {
      if (!pointerInteracting) closeOtherMenus(event.target);
    }, { signal: documentMenuController.signal });
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
      const open = action(label, { className: "v2-settings-text-action v2-profile-document-primary", "aria-label": `Open ${label}` });
      open.prepend(profileSymbol('document'));
      const viewDocument = action("View", { className: "v2-settings-text-action v2-profile-document-view", "aria-label": `View ${label}` });
      const download = action("Download", { className: "v2-settings-text-action v2-profile-document-secondary", "aria-label": `Download ${label}` });
      const remove = action("Remove", { className: "v2-settings-text-action v2-settings-text-action--danger v2-profile-document-secondary", "aria-label": `Remove ${label}` });
      upload.classList.add("v2-profile-document-secondary");
      download.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/></svg>';
      const retry = action("Check saved document", { className: "v2-settings-text-action", hidden: true });
      const keep = action("Use saved document", { className: "v2-settings-text-action", hidden: true });
      const emptyLabel = node("span", { text: label });
      const editDocument = action('Edit', { className: 'v2-profile-document-edit', 'aria-label': `Edit ${label.toLowerCase()}` });
      const saveDocument = action('Save', { className: 'v2-profile-form-save', 'aria-label': `Save ${label.toLowerCase()}` });
      const cancelDocument = action('Cancel', { className: 'v2-profile-form-cancel', 'aria-label': `Cancel ${label.toLowerCase()} edit` });
      const selection = node('span', { className: 'v2-profile-document-selection' });
      const editor = node('div', { className: 'v2-profile-document-editor', hidden: true }, [upload, selection, remove, saveDocument, cancelDocument]);
      const menuRemove = action('Remove', { className: 'v2-settings-text-action v2-settings-text-action--danger', 'aria-label': `Remove ${label}` });
      const menuSummary = node('summary', { 'aria-label': `${label} actions` }, [portalIcon('more')]);
      const menuItems = node('div', { className: 'v2-profile-document-menu-items' }, [viewDocument, editDocument, download, menuRemove]);
      const menu = node('details', { className: 'v2-profile-document-menu' }, [menuSummary, menuItems]);
      const actions = node('div', { className: 'v2-settings-document-actions' }, [menu, retry, keep, file]);
      menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.open = false; menuSummary.focus(); } });
      menuRemove.addEventListener('click', () => { menu.open = false; editDocument.click(); if (state.editing) remove.click(); });
      const restoreDocumentFocus = () => { if (state.savedKey) { menu.open = false; menuSummary.focus(); } else editDocument.focus(); };
      editDocument.addEventListener('click', () => {
        if (photoEditing || profileEditing || [...documentStates.values()].some(other => other !== state && other.editing)) return;
        menu.open = false; state.editing = true; refresh(); upload.focus();
      });
      cancelDocument.addEventListener('click', () => {
        if (state.busy || state.attempt) return;
        state.editing = false; state.draftFile = null; state.draftRemove = false; state.message = ''; refresh(); restoreDocumentFocus();
      });
      editor.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !cancelDocument.disabled) { event.preventDefault(); cancelDocument.click(); }
      });
      const refresh = () => state.render?.();
      state.render = () => {
        status.classList.toggle('lpc-document-announcement-only', state.announceOnly === true);
        status.textContent = state.message || (state.draftRemove ? `${label} will be removed when you save.` : state.draftFile?.name || '');
        retry.textContent = state.retryLabel || "Check saved document";
        refreshProfileFeedback(); renderers.get('profileEditActions')?.();
        if (state.outcome) status.dataset.state = state.outcome;
        const value = state.savedKey;
        emptyLabel.hidden = Boolean(value);
        editor.hidden = !state.editing || Boolean(state.attempt && state.review);
        actions.hidden = Boolean(state.editing) && !state.attempt;
        editDocument.hidden = Boolean(state.editing);
        menu.hidden = !value;
        if (value && editDocument.parentElement !== menuItems) menuItems.prepend(editDocument);
        if (!value && editDocument.parentElement !== actions) actions.prepend(editDocument);
        menuRemove.disabled = state.busy || Boolean(state.attempt);
        download.textContent = 'Download';
        const editLabel = value ? "Replace" : "Upload";
        if (editDocument.textContent !== editLabel) editDocument.textContent = editLabel;
        selection.textContent = state.draftRemove ? `${label} will be removed when you save.` : state.draftFile?.name || '';
        selection.hidden = !selection.textContent;
        saveDocument.disabled = state.busy || Boolean(state.attempt) || (!state.draftFile && !state.draftRemove);
        saveDocument.hidden = !state.draftFile && !state.draftRemove && !state.attempt;
        cancelDocument.disabled = state.busy || Boolean(state.attempt);
        const saveLabel = state.busy ? 'Saving…' : 'Save';
        if (saveDocument.textContent !== saveLabel) saveDocument.textContent = saveLabel;
        upload.textContent = value ? "Replace" : "Upload PDF";
        upload.disabled = file.disabled = state.busy || Boolean(state.attempt);
        upload.hidden = Boolean(state.draftFile || state.draftRemove || state.attempt);
        open.hidden = !value;
        viewDocument.hidden = download.hidden = !value || Boolean(state.attempt);
        remove.hidden = !value || Boolean(state.draftRemove || state.draftFile || state.attempt);
        open.disabled = viewDocument.disabled = download.disabled = state.busy || state.needsRead;
        remove.disabled = state.busy || Boolean(state.attempt);
        retry.hidden = !state.attempt || !state.review; retry.disabled = keep.disabled = state.busy;
        keep.hidden = !state.attempt || !state.review || state.needsRead;
      };
      const message = (copy, outcome = "error", announceOnly = false) => { state.message = copy; state.outcome = outcome; state.announceOnly = announceOnly; refresh(); };
      const accept = (latest, context) => {
        acceptAccountProfile(latest, context);
        state.savedKey = profileDocumentValue(latest, key); state.changed = true;
        user = { ...(user || latest), [key]: state.savedKey, [key.replace("URL", "Key")]: state.savedKey };
        updateReadiness(); invalidateHome?.(); invalidateBrowse?.();
      };
      const finish = (copy) => { state.attempt = null; state.needsRead = false; state.review = false; state.draftFile = null; state.draftRemove = false; state.editing = false; refresh(); message(copy, "saved"); };
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
          popup.location.replace(url.href); documentWindows.delete(popup); message(asDownload ? "Download opened in a new tab." : "Document opened in a new tab.", "saved", true);
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
      upload.addEventListener("click", () => file.click());
      file.addEventListener("change", () => {
        const selected = file.files?.[0]; file.value = "";
        if (!selected || state.busy || state.attempt) return;
        if (selected.type !== "application/pdf" && !/\.pdf$/i.test(selected.name)) { message(`${label} must be a PDF.`); return; }
        if (selected.size > 10 * 1024 * 1024) { message(`${label} must be 10 MB or smaller.`); return; }
        state.draftFile = selected; state.draftRemove = false; state.message = ''; state.outcome = 'dirty'; refresh();
      });
      remove.addEventListener("click", () => {
        state.draftRemove = true; state.draftFile = null; state.message = ''; state.outcome = 'dirty'; refresh(); saveDocument.focus();
      });
      saveDocument.addEventListener('click', async () => {
        if (state.busy || state.attempt || (!state.draftFile && !state.draftRemove)) return;
        state.attempt = { kind: state.draftRemove ? 'remove' : 'upload', file: state.draftFile, context: accountContext(), expectedKey: state.savedKey };
        await perform();
        if (!state.editing) restoreDocumentFocus();
      });
      retry.addEventListener("click", async () => {
        if (!state.attempt || state.busy) return;
        if (state.needsRead) { state.busy = true; refresh(); try { await recover(); } finally { state.busy = false; refresh(); } return; }
        const attempt = state.attempt;
        if (state.savedKey !== attempt.expectedKey) {
          attempt.expectedKey = state.savedKey;
          message("The current version is now selected. Review it, then retry to confirm this change.");
          return;
        }
        attempt.expectedKey = state.savedKey; attempt.resultKey = null; await perform();
        if (!state.editing) restoreDocumentFocus();
      });
      keep.addEventListener("click", () => { if (state.attempt && !state.needsRead && !state.busy) finish("Saved document kept."); });
      viewDocument.addEventListener("click", () => { menu.open = false; void openDocument(); });
      open.addEventListener("click", () => void openDocument());
      download.addEventListener("click", () => void openDocument(true));
      renderers.set(`document:${key}`, refresh); refresh();
      const row = node("article", { className: "v2-settings-document-row", "data-document-field": key }, [
        node("div", {}, [node("strong", {}, [open, emptyLabel])]),
        actions, editor, status,
      ]);
      section.append(row);
    });
    return section;
  }

  function renderProfilePanel() {
    const panel = node("section", { className: "v2-settings-panel v2-profile-editor", role: "tabpanel", id: "v2-settings-profile", "aria-labelledby": "v2-settings-tab-profile" });
    profileStatus = saveIndicator();
    refreshProfileFeedback();
    profileSaveButton = action("↻", { className: "v2-settings-text-action", hidden: true, "aria-label": "Save now", title: "Save now" });
    profileSaveButton.addEventListener("click", () => void saveProfile());
    recoveryNode = node("div", { className: "v2-settings-recovery", hidden: true });
    readinessNode = node("div", { className: "v2-settings-readiness", role: "status", "aria-live": "polite", hidden: true });

    const basics = basicProfileCards();
    const emailField = basics.contact.querySelector('.v2-settings-field');
    const email = node('section', { className: 'v2-settings-card' }, [sectionHeader('Email', 'Your email is not shown to attorneys.'), emailField]);
    const photo = profileIdentityCard();
    const photoNote = photo.querySelector('.v2-settings-identity-copy');
    const practice = tokenEditor({ key: "practiceAreas", label: "Practice areas", placeholder: "Select a practice area", options: PRACTICE_AREAS, section: "practice-areas" });
    const states = tokenEditor({ key: "stateExperience", label: "States of experience", placeholder: "Select a state", options: STATES.map(([code, name]) => `${code} — ${name}`), normalize: (value) => normalizedState(String(value).split("—")[0]), section: "state-experience" });
    const skills = tokenEditor({ key: "skills", label: "Skills", placeholder: "Add skill", section: "skills", maximum: 5 });
    const education = educationCard();
    const work = experienceCard();
    const workFocus = tokenEditor({ key: "bestFor", label: "Tasks & work focus", placeholder: "Add task or work focus", section: "bestFor" });
    const languages = languageCard();
    const years = node("section", { className: "v2-settings-card v2-profile-editor-years", "data-profile-section": "years-experience" }, [
      sectionHeader("Years of experience"),
      bindProfileInput(input({ type: "number", value: String(profile.yearsExperience), min: "0", max: "80", inputmode: "numeric", "aria-label": "Years of experience", className: "v2-settings-input v2-settings-input--years" }), "yearsExperience", (value) => value === "" ? "" : Number(value)),
      node("span", { text: "years of experience" }),
    ]);
    // Resting summaries and editor scopes share the existing field controls.
    // Opening a field never writes; valid profile changes autosave without closing editors.
    panel.classList.add('v2-profile-approved');
    const summary = (tag, className, value) => node(tag, { className, text: value });
    const cardFor = title => [...panel.querySelectorAll('.v2-settings-card')].find(card => card.querySelector(':scope > .v2-settings-section-heading :is(h2,h3)')?.textContent === title);
    const placeEditor = (anchor, title, property) => {
      const card = cardFor(title);
      if (!card) return;
      const slot = node('div', { className: `v2-profile-direct-editor${property === null ? ' is-entry-group' : ''}` });
      if (title === 'Education') slot.dataset.profileEntryKind = 'education';
      const range = document.createRange(); range.selectNodeContents(anchor);
      slot.style.font = getComputedStyle(anchor).font;
      slot.style.maxWidth = `${Math.max(140,Math.ceil(range.getBoundingClientRect().width) + (property === 'name' ? 120 : 90))}px`;
      if (property === null) { slot.style.width = '100%'; slot.style.maxWidth = '100%'; }
      if (property) slot.dataset.profileInlineProperty = property;
      anchor.hidden = true; anchor.after(slot); slot.append(card);
      if (title === 'Education') {
        const recovery = node('div', {className:'v2-education-recovery',hidden:true,'data-education-recovery':''});
        const reason = node('p', {id:'v2-education-save-reason'});
        const retry = action('Retry', {className:'v2-settings-text-action','data-education-retry':''});
        retry.addEventListener('pointerdown',()=>{profileToolbarInteracting=true;window.clearTimeout(profileSaveTimer);window.setTimeout(()=>{if(profileToolbarInteracting){profileToolbarInteracting=false;scheduleProfileAutosave();}},1000);});
        retry.addEventListener('pointercancel',()=>{profileToolbarInteracting=false;scheduleProfileAutosave();});
        retry.addEventListener('click',()=>profilePanel.querySelector('.v2-profile-autosave .v2-profile-form-save')?.click());
        recovery.append(reason,retry);slot.prepend(recovery);
        renderers.get('profileEditActions')?.();
      }
      if (title === 'Personal details') {
        const allowed = property === 'name' ? ['firstName','lastName'] : [property];
        card.querySelectorAll('[data-profile-field]').forEach(control => {
          const wrapper = control.closest('.v2-settings-field');
          if (wrapper) wrapper.hidden = !allowed.includes(control.dataset.profileField);
        });
        const names = card.querySelector('.v2-settings-personal-fields');
        if (names) names.hidden = property !== 'name';
        const unit = card.querySelector('.v2-personal-years-unit');
        if (unit) unit.hidden = property !== 'yearsExperience';
      }
      requestAnimationFrame(() => {
        if (!slot.isConnected || !profileEditing || !slot.contains(card)) return;
        if (title === 'Personal details' && property === 'name') {
          const controls = [...card.querySelectorAll('.v2-settings-personal-fields input')];
          const canvas = document.createElement('canvas'),context = canvas.getContext('2d');
          const names = card.querySelector('.v2-settings-personal-fields');
          if (!names || !context) return;
          const resizeNames = () => {
            const widths = controls.map(control => { context.font = getComputedStyle(control).font; return Math.ceil(context.measureText(control.value || control.placeholder).width) + 8; });
            names.style.gridTemplateColumns = widths.map(width => `minmax(0,${width}px)`).join(' ');
          };
          names.oninput = resizeNames;
          resizeNames();
        }
        const control = [...slot.querySelectorAll('input:not([type="file"]),textarea,select')].find(control => control.getClientRects().length);
        if (control?.tagName === 'TEXTAREA') {
          const resize = () => { control.style.height = 'auto'; control.style.height = `${Math.max(24,control.scrollHeight)}px`; };
          if (title === 'About') control.oninput = resize;
          resize();
        }
        control?.focus({ preventScroll: true });
      });
    };
    const directValue = (element, title, index = null, property = null, anchor = element) => {
      const edit = action('', { className: 'lpc-profile-value', 'aria-label': `Edit ${title.toLowerCase()}${property ? ` ${property}` : ''}${index !== null ? ` entry ${index + 1}` : ''}` });
      edit.append(...element.childNodes); element.append(edit);
      const card = cardFor(title);
      const section = card?.dataset.profileSection || ({'Personal details':'personal-details','About':'bio','Practice areas':'practice-areas','Skills':'skills','Tasks & work focus':'bestFor','States of experience':'state-experience','Work experience':'experience','Education':'education','Languages':'languages'})[title];
      if (section) edit.dataset.profileDirectSection = section;
      edit.addEventListener('click', () => {
        if (profileEditing) { switchProfileEditor(edit.getAttribute('aria-label')); return; }
        if (!beginProfileEdit(title,index,edit.getAttribute('aria-label'),property)) return;
        if (['Work experience','Education'].includes(title)) { profileEditingProperty = null; renderers.get('profileMode')?.(); }
        placeEditor(anchor,title,['Work experience','Education'].includes(title) ? null : property);
      });
    };
    const directAdd = (container, card, title, label) => {
      const add = action('+ Add', { className:'v2-profile-inline-add', 'aria-label':label });
      add.addEventListener('click', () => {
        if (profileEditing) { switchProfileEditor(label); return; }
        const original = [...card.querySelectorAll('button')].find(button => button.textContent === label);
        original?.click();
        if (!profileEditing || profileEditingTitle !== title) return;
        profileEditingProperty = null; renderers.get('profileMode')?.();
        profileEditReturnLabel = label; placeEditor(add,title,null);
      });
      container.append(add);
    };
    const fieldGroup = (key, title, fields, content, editLabel) => {
      const bank = node('div', { className: 'v2-profile-group-details v2-profile-editor-bank', 'data-profile-scope': key, hidden: true });
      const close = action('Close editor', { className: 'v2-settings-text-action', 'aria-label': `Close ${title.toLowerCase()} editor` });
      close.addEventListener('click', () => {
        if (profileEditBusy) return;
        if (profileEditing) { finishProfileEdit(); return; }
        profileCompositionScope = ''; syncScopes(); toggle.focus();
      });
      bank.append(node('div', { className: 'v2-profile-editor-bank-heading' }, [close]), ...fields);
      const toggle = action(editLabel || 'Edit', { className: 'v2-settings-text-action v2-profile-scope-toggle', 'aria-label': `Edit ${title.toLowerCase()}`, 'aria-expanded': 'false', 'aria-controls': `v2-profile-editor-${key}` });
      bank.id = `v2-profile-editor-${key}`;
      toggle.addEventListener('click', () => {
        if (profileEditing || photoEditing || [...documentStates.values()].some(state => state.editing)) { panel.querySelector('.is-row-editing input,.v2-profile-form-save')?.focus(); return; }
        if (key === 'identity') { beginProfileEdit('Personal details', null, toggle.getAttribute('aria-label')); return; }
        profileCompositionScope = key; syncScopes();
        requestAnimationFrame(() => {
          if (profileCompositionScope === key && !bank.contains(document.activeElement)) bank.querySelector('.v2-profile-row-edit,.v2-profile-entry-property')?.focus();
        });
      });
      const group = node('section', { className: `v2-profile-group v2-profile-group--${key}`, 'data-profile-group': key }, [
        node('header', { className: 'v2-profile-section-top' }, [node('h2', { text: title }), toggle]), content, bank,
      ]);
      if (key !== 'identity') {
        const body = node('div', {className:'lpc-profile-group-body'}, [content, bank]);
        group.append(body);
      }
      return group;
    };
    const identityText = node('div', { className: 'v2-profile-identity-text' });
    const identitySummary = node('div', { className: 'v2-profile-identity-summary' }, [photo, identityText]);
    const residence = primaryStateCard().querySelector('.v2-settings-field');
    residence.classList.add('v2-personal-location');
    residence.querySelector('.v2-settings-field__label').textContent = 'Location';
    residence.querySelector('select').setAttribute('aria-label', 'Location');
    const personal = node('section', { className: 'v2-settings-card v2-profile-personal-card', 'data-profile-section': 'personal-details' }, [
      sectionHeader('Personal details'),
      basics.publicIdentity.querySelector('.v2-settings-personal-fields'),
      residence,
      field('Years of experience', years.querySelector('input'), { className: 'v2-personal-years' }),
    ]);
    personal.querySelectorAll('.v2-settings-required').forEach(label => label.remove());
    personal.querySelectorAll('.v2-settings-field__label').forEach(label => label.remove());
    for (const [key, placeholder] of [['firstName', 'First name'], ['lastName', 'Last name'], ['yearsExperience', 'Experience']]) personal.querySelector(`[data-profile-field="${key}"]`).setAttribute('placeholder', placeholder);
    residence.querySelector('select').options[0].textContent = 'Location';
    const experienceInput = personal.querySelector('[data-profile-field="yearsExperience"]');
    const experienceUnit = node('span', { className: 'v2-personal-years-unit', 'aria-hidden': 'true' });
    const refreshExperienceUnit = () => { experienceUnit.textContent = Number(experienceInput.value) === 1 ? 'year' : 'years'; };
    experienceInput.addEventListener('input', refreshExperienceUnit);
    refreshExperienceUnit();
    experienceInput.closest('.v2-personal-years').append(experienceUnit);
    const identity = fieldGroup('identity', 'Identity', [personal], identitySummary, 'Edit details');
    const identityToggle = identity.querySelector('.v2-profile-scope-toggle');
    identityToggle.setAttribute('aria-haspopup', 'dialog');
    identityToggle.removeAttribute('aria-expanded');
    identityToggle.removeAttribute('aria-controls');
    const view = routeLink('View profile', '/profile/me', 'v2-settings-secondary v2-profile-view-link');
    identitySummary.append(view);
    const identityEdit = identity.querySelector('.v2-profile-scope-toggle');
    const identityName = summary('h2', 'v2-profile-person-name', '');
    const identityMeta = summary('div', 'v2-profile-person-meta', '');
    identityText.append(identityName, identityMeta, identityEdit);
    identity.append(photoNote, readinessNode);
    const expertiseSummary = node('div', { className: 'v2-profile-expertise-summary' });
    const professional = fieldGroup('professional', 'About', [bioCard(), practice, skills, workFocus, states, languages], expertiseSummary);
    professional.querySelector('.v2-profile-scope-toggle').setAttribute('aria-label', 'Edit about and expertise');
    const educationSummary = node('div', { className: 'v2-profile-education-summary' });
    const academic = fieldGroup('education', 'Education', [education], educationSummary);
    const workSummary = node('div', { className: 'v2-profile-work-summary' });
    const employment = fieldGroup('experience', 'Work experience', [work], workSummary);
    const background = node('div', { className: 'v2-profile-background' }, [employment, academic]);
    const documents = documentsCard();
    const documentsGroup = node('section', { className: 'v2-profile-group v2-profile-group--documents' }, [node('h2', { text: 'Documents' }), node('div', { className: 'v2-profile-group-details' }, [documents])]);
    const accountSummary = node('div', { className: 'v2-profile-account-summary' });
    const account = fieldGroup('account', 'Account & contact', [email, basics.linkedIn], accountSummary, 'Edit account & contact');
    const layout = node('div', { className: 'v2-profile-editor-list v2-profile-approved-layout' }, [identity, professional, background, documentsGroup, account]);
    const syncScopes = () => {
      panel.querySelectorAll('[data-profile-scope]').forEach(bank => {
        // The bank only stores the existing controls. The active field is
        // moved to its saved value; reopening this bank duplicates editors.
        bank.hidden = true;
        bank.closest('[data-profile-group]').querySelector('.v2-profile-scope-toggle').setAttribute('aria-expanded', 'false');
      });
    };
    const renderSummary = () => {
      // A refresh must not detach an active editor or replace its draft.
      if (profileEditing) return;
      // Settings shows the local draft; the public preview still reads saved data.
      const saved = profile;
      identityName.textContent = nameOf(saved);
      const location = summary('span','',displayState(saved.state) || 'Location');
      const yearsValue = summary('span','',`${saved.yearsExperience} ${saved.yearsExperience === 1 ? 'year' : 'years'} of experience`);
      identityMeta.replaceChildren(location,document.createTextNode(' · '),yearsValue);
      directValue(identityName,'Personal details',null,'name');
      directValue(location,'Personal details',null,'state');
      directValue(yearsValue,'Personal details',null,'yearsExperience');
      expertiseSummary.replaceChildren(summary('p', 'v2-profile-about-copy', saved.bio || 'About not added'), summary('h3', '', 'Expertise'));
      if (saved.practiceAreas.length) expertiseSummary.append(node('div', { className: 'v2-profile-practice-tags' }, saved.practiceAreas.map(value => summary('span', '', value))));
      // Display stored task/work-focus entries alongside skills/tools without
      // changing either source list or duplicating case-insensitive matches.
      const seen = new Set(saved.practiceAreas.map(value => value.toLocaleLowerCase()));
      const expertise = [...saved.skills, ...saved.bestFor].filter(value => {
        const key = value.toLocaleLowerCase(); if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      expertiseSummary.append(summary('h4', 'v2-profile-detail-label', 'Skills, tools & work focus'), summary('p', 'v2-profile-skills-summary', expertise.join(' · ') || 'Not added'));
      expertiseSummary.append(summary('h4', 'v2-profile-detail-label v2-profile-states-label', 'States of experience'), summary('p', '', saved.stateExperience.map(displayState).join(' · ') || 'Not added'));
      expertiseSummary.append(node('section', { className: 'v2-profile-language-summary', 'aria-label': 'Languages' }, [summary('h3', '', 'Languages'), ...(saved.languages.length ? saved.languages.map(entry => summary('p', '', entry.name || 'Add language')) : [summary('p', '', 'No languages added')])]));
      workSummary.replaceChildren(...saved.experience.map(entry => node('article', { className: 'v2-profile-work-item' }, [
        entry.title || !Object.values(entry).some(Boolean) ? summary('h3', '', entry.title || 'Add role') : null,
        entry.years ? summary('p', 'v2-profile-work-dates', entry.years) : null,
        entry.description ? summary('p', 'v2-profile-work-description', entry.description) : null,
      ])));
      if (!saved.experience.length) workSummary.append(summary('p', '', 'No work experience added'));
      educationSummary.replaceChildren(...saved.education.map(entry => node('article', { className: 'v2-profile-education-item' }, [
        node('span', { className: 'v2-profile-education-symbol', 'aria-hidden': 'true' }, [profileSymbol('education')]),
        node('div', {}, [summary('h3', '', [entry.degree, entry.fieldOfStudy].filter(Boolean).join(' in ') || entry.school || 'Education'),
          entry.school && (entry.degree || entry.fieldOfStudy) ? summary('p', '', entry.school) : null,
          [entry.startMonth, entry.startYear, entry.endMonth, entry.endYear].some(Boolean) ? summary('p', 'v2-profile-education-meta', [[entry.startMonth, entry.startYear].filter(Boolean).join(' '), [entry.endMonth, entry.endYear].filter(Boolean).join(' ')].filter(Boolean).join(' – ')) : null,
          entry.grade ? summary('p', 'v2-profile-education-meta', `Grade: ${entry.grade}`) : null,
          entry.activities ? summary('p', 'v2-profile-education-meta', entry.activities) : null,
        ]),
      ])));
      if (!saved.education.length) educationSummary.append(summary('p', '', 'No education added'));
      accountSummary.replaceChildren(node('div', {}, [summary('span', 'v2-profile-account-label', 'Account email · Private'), summary('p', '', saved.email || 'Not added')]), node('div', {}, [summary('span', 'v2-profile-account-label', 'LinkedIn'), summary('p', '', saved.linkedInURL || 'Not added')]));
      directValue(expertiseSummary.querySelector('.v2-profile-about-copy'),'About');
      const practices = expertiseSummary.querySelector('.v2-profile-practice-tags') || summary('p','','Add practice areas');
      if (!practices.isConnected && !expertiseSummary.contains(practices)) expertiseSummary.querySelector('h3').after(practices);
      directValue(practices,'Practice areas');
      directValue(expertiseSummary.querySelector('.v2-profile-skills-summary'),'Skills');
      const focus = summary('p','v2-profile-work-focus-summary',saved.bestFor.join(' · ') || 'Add work focus');
      const skillsSummary = expertiseSummary.querySelector('.v2-profile-skills-summary');
      skillsSummary.previousElementSibling.textContent = 'Skills & tools';
      skillsSummary.querySelector('button').textContent = saved.skills.join(' · ') || 'Add skills';
      skillsSummary.after(summary('h4','v2-profile-detail-label','Work focus'),focus);
      directValue(focus,'Tasks & work focus');
      directValue(expertiseSummary.querySelector('.v2-profile-states-label').nextElementSibling,'States of experience');
      expertiseSummary.querySelectorAll('.v2-profile-language-summary > p').forEach((line,index) => { if (saved.languages[index]) directValue(line,'Languages',index,'name'); });
      directAdd(expertiseSummary.querySelector('.v2-profile-language-summary'),languages,'Languages','Add language');
      workSummary.querySelectorAll('.v2-profile-work-item').forEach((entry,index) => {
        const title = entry.querySelector('h3'),dates = entry.querySelector('.v2-profile-work-dates'),copy = entry.querySelector('.v2-profile-work-description');
        if (title) directValue(title,'Work experience',index,index >= normalizeProfile(user).experience.length ? null : 'title');
        if (dates) directValue(dates,'Work experience',index,'years');
        if (copy) directValue(copy,'Work experience',index,'description');
      });
      directAdd(workSummary,work,'Work experience','Add work experience');
      educationSummary.querySelectorAll('.v2-profile-education-item').forEach((entry,index) => directValue(entry.querySelector('h3'),'Education',index,null,entry));
      directAdd(educationSummary,education,'Education','Add education');
      educationSummary.querySelectorAll('.v2-profile-education-item').forEach((row,index)=>swipeSavedProfileEntry(row,'education','Education',index,'Add education'));
      workSummary.querySelectorAll('.v2-profile-work-item').forEach((row,index)=>swipeSavedProfileEntry(row,'experience','Work experience',index,'Add work experience'));
      expertiseSummary.querySelectorAll('.v2-profile-language-summary > p').forEach((row,index)=>{if(saved.languages[index])swipeSavedProfileEntry(row,'languages','Languages',index,'Add language');});
      directValue(accountSummary.children[0].querySelector('p'),'Email');
      directValue(accountSummary.children[1].querySelector('p'),'LinkedIn');
    };
    renderers.set('profileSummary', renderSummary);
    renderers.set('profileScopes', syncScopes);
    renderSummary(); syncScopes();
    mountSaveFeedback('profile', [profileStatus, profileSaveButton]);
    panel.append(recoveryNode, profileEditToolbar(), layout);
    const autofill = action("Fill from résumé", { className: "ri-entry", "data-resume-autofill": "" });
    autofill.addEventListener("click", () => void resumeImporter().open(autofill));
    panel.append(autofill);

    const recovered = dirtyProfileFields.size ? null : readDraft();
    if (recovered) {
      recoveryNode.hidden = false;
      const restore = action("Restore", { className: "v2-settings-secondary" });
      const discard = action("Discard", { className: "v2-settings-text-action" });
      recoveryNode.append(node("p", {}, [node("strong", { text: "Unsaved profile changes found." }), document.createTextNode(" Restore the draft saved in this browser?")]), restore, discard);
      restore.addEventListener("click", () => {
        const recoveredFields = Array.isArray(recovered.fields) ? recovered.fields.filter(field => PROFILE_FIELDS.includes(field)) : PROFILE_FIELDS;
        const draftProfile = normalizeProfile({ ...user, ...recovered.profile });
        if (recoveredFields.includes("yearsExperience") && ["string","number"].includes(typeof recovered.profile.yearsExperience)) draftProfile.yearsExperience = recovered.profile.yearsExperience;
        recoveredFields.forEach(field => {
          profile[field] = draftProfile[field];
          dirtyProfileFields.set(field, ++profileRevision);
          dirtyProfileBaselines.set(field, recovered.baselines?.[field] || expectedProfileValues({ [field]: profile[field] }));
        });
        if (!recovered.baselines) profileConflict = user;
        clearDraft(); recoveryNode.hidden = true; rebuildProfilePanel(); persistDraft();
        setProfileStatus(profileConflict ? "Review the recovered draft against your saved profile." : "Changes waiting to save", profileConflict ? "error" : "dirty");
        setProfileAction(profileConflict ? "Review saved profile" : "Save changes");
        if (!profileConflict) { profileAutosaveBlocked = false; scheduleProfileAutosave(true); }
      });
      discard.addEventListener("click", () => { clearDraft(); recoveryNode.hidden = true; });
    }
    updateReadiness();
    arrangeSettingsSections(panel);
    mountProfileRows(panel);
    // Keep verification instructions visible when the email editor closes.
    const emailNotice = emailField.querySelector('.v2-settings-field__copy');
    if (emailNotice) { emailNotice.classList.add('v2-profile-email-notice'); account.append(emailNotice); }
    syncScopes();
    return panel;
  }

  function beginProfileEdit(title, index = null, returnLabel = null, property = null) {
    if (photoEditing || profileEditBusy || [...documentStates.values()].some(state => state.editing)) return false;
    if (profileEditing) {
      profilePanel.querySelector('.v2-profile-form-save')?.focus({ preventScroll: true });
      return false;
    }
    const target = [...profilePanel.querySelectorAll('.v2-settings-card')].find(card => card.querySelector(':scope > .v2-settings-section-heading h3')?.textContent === title);
    const scope = target?.closest('[data-profile-scope]');
    if (scope) { profileCompositionScope = scope.dataset.profileScope; renderers.get('profileScopes')?.(); }
    profileEditingTitle = title; profileEditingIndex = index; profileEditingProperty = property;
    profileEditReturnLabel = returnLabel || `Edit ${title.toLowerCase()}`;
    profileEditing = true;
    renderers.get('profileMode')?.();
    return true;
  }

  function restoreProfileEditFocus(label) {
    requestAnimationFrame(() => [...profilePanel.querySelectorAll('button,select')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)?.focus({ preventScroll: true }));
  }

  function flushProfileTokenEntry() {
    const controls = profilePanel?.querySelector('.is-row-editing .v2-settings-token-entry');
    const entry = controls?.querySelector('input,select');
    if (!entry?.value.trim()) return true;
    controls.querySelector('button')?.click();
    if (!entry.value.trim()) return true;
    const duplicate = [...controls.parentElement.querySelectorAll('.v2-settings-chip > span')]
      .some(chip => chip.textContent.trim() === entry.value.trim());
    if (duplicate) { entry.value = ''; return true; }
    entry.focus();
    return false;
  }

  function finishProfileEdit() {
    if (accountStopped || !profile || !profilePanel) return false;
    if (profileEditBusy || !flushProfileTokenEntry()) return false;
    profileEditing = false; profileEditingTitle = null; profileEditingIndex = null;
    profileEditingProperty = null; profileCompositionScope = '';
    dirtyProfileBaselines.forEach((_value,key) => { if (!dirtyProfileFields.has(key)) dirtyProfileBaselines.delete(key); });
    rebuildProfilePanel();
    scheduleProfileAutosave(true);
    return true;
  }

  function switchProfileEditor(label) {
    if (!finishProfileEdit()) return;
    const trigger = [...profilePanel.querySelectorAll('.lpc-profile-value,.v2-profile-inline-add')]
      .find(button => button.getAttribute('aria-label') === label);
    trigger?.click();
  }

  function profileEditToolbar() {
    const undo = action('Undo', { className: 'v2-settings-text-action', 'aria-label': 'Undo profile change' });
    const redo = action('Redo', { className: 'v2-settings-text-action', 'aria-label': 'Redo profile change' });
    const retry = action('Retry', { className: 'v2-profile-form-save' });
    const email = action('Send verification', { className: 'v2-settings-text-action' });
    const localStatus = node('span', { className: 'v2-profile-edit-status', role: 'status', 'aria-live': 'polite' });
    const toolbar = node('div', { className: 'v2-profile-form-actions v2-profile-save-all v2-profile-autosave', hidden: true, role: 'group', 'aria-label': 'Profile save status' }, [localStatus, undo, redo, email, retry]);
    const refresh = () => {
      const dirty = dirtyProfileFields.size > 0, saving = Boolean(profileSavePromise) || profileFeedback.state === 'saving';
      toolbar.hidden = !dirty && !saving && !profileUndo.length && !profileRedo.length && !unresolvedProfileSave && !profileConflict && profileFeedback.state !== 'error' && !user.pendingEmail;
      if (!toolbar.hidden && profileStatus) profileStatus.hidden = true;
      localStatus.dataset.state = profileFeedback.state;
      localStatus.classList.toggle('v2-visually-hidden', !saving && !dirty && !user.pendingEmail && profileFeedback.state !== 'error' && !unresolvedProfileSave && !profileConflict);
      const copy = saving ? 'Saving…' : profileFeedback.state === 'error' ? profileFeedback.copy : dirty ? dirtyProfileFields.size === 1 && dirtyProfileFields.has('email') ? 'Email change needs verification' : 'Changes waiting to save' : user.pendingEmail ? 'Saved · check your inbox to confirm your email' : 'Saved';
      if (localStatus.textContent !== copy) localStatus.textContent = copy;
      const locked = saving || profileEditBusy || Boolean(unresolvedProfileSave || profileConflict);
      undo.hidden = !profileUndo.length && !dirty;
      undo.disabled = locked;
      redo.hidden = !profileRedo.length; redo.disabled = locked || dirty;
      retry.hidden = !profileConflict && !unresolvedProfileSave && profileFeedback.state !== 'error';
      retry.disabled = saving || profileEditBusy;
      const label = profileConflict ? 'Review changes' : unresolvedProfileSave ? 'Check saved profile' : profileElements('[aria-invalid="true"]').length ? 'Review field' : 'Retry';
      if (retry.textContent !== label) retry.textContent = label;
      retry.setAttribute('aria-label',label);
      email.hidden = !dirtyProfileFields.has('email'); email.disabled = locked;
      for (const recovery of profilePanel?.querySelectorAll('[data-education-recovery]') || []) {
        const relevant = dirtyProfileFields.has('education') && profileFeedback.state === 'error';
        recovery.hidden = !relevant;
        recovery.querySelector('p').textContent = relevant ? profileFeedback.copy : '';
        const localRetry = recovery.querySelector('button');
        localRetry.textContent = label;
        localRetry.setAttribute('aria-label',`${label} for education`);
        localRetry.disabled = retry.disabled;
        for (const field of recovery.parentElement.querySelectorAll('[data-profile-field=education]')) {
          const described = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(id=>id && id!=='v2-education-save-reason');
          if (relevant) described.push('v2-education-save-reason');
          if (described.length) field.setAttribute('aria-describedby',described.join(' '));
          else field.removeAttribute('aria-describedby');
        }
      }
    };
    renderers.set('profileEditActions', refresh);
    // Safari does not always focus a clicked button. Capture pointer intent
    // before blur so autosave cannot disable Undo before its click arrives.
    toolbar.addEventListener('pointerdown', () => {
      profileToolbarInteracting = true; window.clearTimeout(profileSaveTimer);
      window.setTimeout(() => { if (profileToolbarInteracting) { profileToolbarInteracting = false; scheduleProfileAutosave(); } }, 1000);
    });
    toolbar.addEventListener('click', () => { profileToolbarInteracting = false; });
    toolbar.addEventListener('pointercancel', () => { profileToolbarInteracting = false; scheduleProfileAutosave(); });
    undo.addEventListener('click', () => void revertProfileEdit('undo'));
    redo.addEventListener('click', () => void revertProfileEdit('redo'));
    retry.addEventListener('click', async () => {
      const invalid = profileElements('[aria-invalid="true"]')[0];
      if (!profileConflict && !unresolvedProfileSave && invalid) { showProfileFieldError(invalid.dataset.profileField, profileFeedback.copy); return; }
      profileAutosaveBlocked = false;
      const hadUnresolved = Boolean(unresolvedProfileSave);
      await saveProfile({ automatic: true });
      if (hadUnresolved && !unresolvedProfileSave && !profileConflict && !profileAutosaveBlocked) scheduleProfileAutosave(true);
    });
    email.addEventListener('click', async () => {
      if (profileSavePromise || !flushProfileTokenEntry()) return;
      await saveProfile();
    });
    refresh(); return toolbar;
  }

  function mountProfileRows(panel) {
    const refreshers = [];
    const photo = panel.querySelector('[data-profile-section="profile-photo"]');
    photo.prepend(sectionHeader('Profile photo'));
    const cards = [...panel.querySelectorAll('.v2-profile-group-details > .v2-settings-card')];
    // Section headings are h2; individual field labels sit one level beneath.
    panel.querySelectorAll('.v2-profile-group-details > :is(.v2-settings-card,.v2-settings-identity-card) > .v2-settings-section-heading h2, [data-profile-section="profile-photo"] > .v2-settings-section-heading h2').forEach(label => {
      const heading = node('h3'); heading.append(...label.childNodes); label.replaceWith(heading);
    });
    cards.forEach(card => {
      const heading = card.querySelector(':scope > .v2-settings-section-heading');
      const body = card.querySelector(':scope > .v2-settings-card-body');
      const title = heading.querySelector('h3').textContent;
      const key = card.dataset.profileSection;
      heading.querySelector('p')?.remove(); card.removeAttribute('tabindex');
      card.classList.remove('v2-profile-inline-tokens');
      const collection = ['experience', 'education', 'languages'].includes(key), documents = key === 'résumé';
      if (collection || documents) return;
      const value = node('span', { className: 'v2-profile-row-value' });
      const edit = action('', { className: 'v2-profile-row-edit', 'aria-label': `Edit ${title.toLowerCase()}` });
      edit.append(value, node('span', { className: 'v2-profile-edit-label', text: 'Edit', 'aria-hidden': 'true' })); card.insertBefore(edit, body);
      const refresh = () => {
        let summary;
        if (['practice-areas', 'skills', 'bestFor', 'state-experience'].includes(key)) {
          summary = list(profile[{ 'practice-areas': 'practiceAreas', 'state-experience': 'stateExperience' }[key] || key]).join(', ');
        } else {
          summary = [...body.querySelectorAll('input:not([type="file"]),textarea,select')].map(control => control.tagName === 'SELECT' ? control.selectedOptions[0]?.textContent : control.value).filter(Boolean).join(title === 'Name' ? ' ' : ' · ');
        }
        value.textContent = summary || 'Not added'; value.classList.toggle('is-empty', !summary);
      };
      edit.addEventListener('click', () => {
        const direct = [...panel.querySelectorAll('.lpc-profile-value')].find(button => button.dataset.profileDirectSection === key);
        if (direct) { direct.click(); return; }
        card.style.minHeight = `${card.getBoundingClientRect().height}px`;
        const height = Math.max(36, edit.getBoundingClientRect().height);
        if (!beginProfileEdit(title)) return;
        if (key === "bio") {
          // Keep neighboring rows at their saved positions. The multiline
          // control scrolls inside the height already occupied by the summary.
          const textarea = body.querySelector("textarea");
          textarea.style.minHeight = `${height}px`;
          textarea.style.height = `${height}px`;
        }
        requestAnimationFrame(() => body.querySelector('input:not([type="file"]),textarea,select')?.focus({ preventScroll: true }));
      });
      refreshers.push(refresh); refresh();
    });
    const setMode = () => {
      panel.classList.toggle('is-form-editing', profileEditing);
      cards.forEach(card => {
        const title = card.querySelector(':scope > .v2-settings-section-heading h3').textContent;
        const body = card.querySelector(':scope > .v2-settings-card-body');
        const editing = profileEditing && profileEditingTitle === title;
        card.classList.toggle('is-row-editing', editing);
        const collection = ['experience','education','languages'].includes(card.dataset.profileSection), documents = card.dataset.profileSection === 'résumé';
        body.hidden = !editing && !collection && !documents;
        const preview = card.querySelector(':scope > .v2-profile-row-edit');
        if (preview) preview.hidden = editing;
        if (collection) {
          card.querySelectorAll('.v2-profile-entry').forEach(row => {
            const active = editing && Number(row.dataset.profileEntry) === profileEditingIndex;
            row.classList.toggle('is-entry-editing', active);
            row.querySelector('.v2-profile-entry-value').hidden = active;
            row.querySelector('.v2-profile-entry-editor').hidden = !active;
            row.querySelectorAll('[data-entry-property]').forEach(field => { field.hidden = !active || Boolean(profileEditingProperty && field.dataset.entryProperty !== profileEditingProperty); });
            if (active) row.style.minHeight = '';
          });
        }
      });
      renderers.get('profileEditActions')?.(); refreshers.forEach(refresh => refresh());
    };
    panel.addEventListener('compositionstart', () => { profileComposing = true; window.clearTimeout(profileSaveTimer); });
    panel.addEventListener('compositionend', () => { profileComposing = false; scheduleProfileAutosave(); });
    panel.addEventListener('focusout', event => {
      // Let Undo/Retry receive their click before a blur can start a write.
      if (profileToolbarInteracting || event.relatedTarget?.closest('.v2-profile-autosave,[data-education-recovery]')) { window.clearTimeout(profileSaveTimer); return; }
      if (event.target.matches('input,textarea,select') && !event.isComposing) queueMicrotask(() => {
        if (!accountStopped && !profileComposing && !event.target.closest('.v2-settings-token-entry')) scheduleProfileAutosave(true);
      });
    });
    panel.addEventListener('click', event => {
      if (!profileEditing || profileEditBusy) return;
      if (event.target.closest('.v2-profile-direct-editor,.lpc-profile-value,.v2-profile-inline-add,.v2-profile-save-all,.v2-profile-conflict-review,.v2-profile-editor-bank')) return;
      finishProfileEdit();
    });
    panel.addEventListener('keydown', event => {
      if (!profileEditing || profileEditBusy) return;
      if (event.key === 'Escape' || event.key === 'Enter' && event.target.matches('input:not([type="file"])') && !event.target.closest('.v2-settings-token-entry')) {
        event.preventDefault();
        const label = profileEditReturnLabel;
        if (finishProfileEdit()) restoreProfileEditFocus(label);
      }
    });
    renderers.set('profileRows', () => { refreshers.forEach(refresh => refresh()); renderers.get('profileSummary')?.(); });
    renderers.set('profileMode', setMode); setMode();
  }

  function rebuildProfilePanel() {
    if (!profilePanel?.isConnected && !profilePanel) return;
    const replacement = renderProfilePanel();
    profilePanel.replaceWith(replacement);
    profilePanel = replacement;
  }

  async function editExistingPhoto(returnFocus) {
    try {
      const context = accountContext();
      const expectedPhotoRevision = user.profilePhotoRevision;
      await verifyAccount(context);
      let framing = null;
      const blob = await accountTransport(`/api/uploads/profile-photo/original?expectedOwnerId=${encodeURIComponent(context.ownerId)}&expectedPhotoRevision=${expectedPhotoRevision}`, {onHeaders:headers=>{framing=headers.get("X-LPC-Photo-Crop");}}, { image: true });
      await verifyAccount(context);
      const type = /png/i.test(blob.type) ? "image/png" : "image/jpeg";
      const file = new File([blob], type === "image/png" ? "profile-original.png" : "profile-original.jpg", { type });
      await openPhotoEditor(file, { editExisting: true, returnFocus, expectedPhotoRevision, framing });
    } catch (error) {
      showToast?.(error?.message || "The photo editor is unavailable.");
    }
  }

  async function loadImage(file) {
    const dimensions = await imageDimensions(file);
    if (dimensions && (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 64000000)) throw new Error("Choose a photo up to 64 megapixels.");
    let source = file;
    // Keep the original upload intact; only downsample the interactive preview.
    if (dimensions && Math.max(dimensions.width, dimensions.height) > 2048 && typeof createImageBitmap === "function") {
      let bitmap;
      try {
        bitmap = await createImageBitmap(file, {imageOrientation:"from-image", resizeQuality:"high", ...(dimensions.width >= dimensions.height ? {resizeWidth:2048} : {resizeHeight:2048})});
        const ratio = Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
        const canvas = document.createElement("canvas"); canvas.width=Math.max(1,Math.round(bitmap.width*ratio)); canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
        canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);
        source = await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
        if (!source) throw new Error("Photo preview unavailable");
      } catch { throw new Error("This photo couldn’t be prepared. Try a smaller JPEG or PNG."); }
      finally { bitmap?.close(); }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(source);
      const image = new Image();
      image.onload = () => resolve({ image, url });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The selected image could not be opened.")); };
      image.src = url;
    });
  }

  async function openPhotoEditor(file, { editExisting = false, returnFocus = null, expectedPhotoRevision = user?.profilePhotoRevision, framing = null } = {}) {
    if (!/^image\/(?:png|jpe?g)$/i.test(file.type || "") || file.size > 5 * 1024 * 1024) {
      showToast?.("Choose a JPEG or PNG image no larger than 5 MB.");
      return;
    }
    if (!profilePanel?.isConnected || profilePanel.hidden || photoEditing || profileEditing || [...documentStates.values()].some(state => state.editing)) return;
    const photoPanel = profilePanel;
    const context = accountContext();
    let loaded;
    photoEditing = true; renderers.get('profileEditActions')?.();
    const launcher = profilePanel.querySelector('.v2-settings-photo');
    launcher.disabled = true; launcher.setAttribute('aria-busy','true');
    try { loaded = await loadImage(file); assertAccount(context); }
    catch (error) { if (loaded) URL.revokeObjectURL(loaded.url); photoEditing = false; if (!accountStopped) { renderers.get('profileEditActions')?.(); showToast?.(error.message); } return; }
    finally { launcher.disabled=false; launcher.removeAttribute('aria-busy'); }
    if (profilePanel !== photoPanel || !photoPanel.isConnected || photoPanel.hidden) {
      URL.revokeObjectURL(loaded.url); photoEditing = false; renderers.get('profileEditActions')?.(); return;
    }
    const photoWrap = profilePanel.querySelector('.v2-settings-photo-wrap');
    const photoButton = photoWrap.querySelector('.v2-settings-photo');
    const dialog = node('dialog', {className:'v2-settings-dialog v2-photo-crop-dialog', 'aria-label':'Edit profile photo'});
    document.body.append(dialog);
    const viewport = node("div", { className: "v2-settings-crop-viewport", tabindex: "0", "aria-label": "Profile photo crop area" });
    const preview = loaded.image;
    preview.alt = "Photo crop preview";
    preview.draggable = false;
    viewport.append(preview, node("span", {className:"v2-photo-crop-grid", "aria-hidden":"true"}));
    const zoom = input({ type: "range", min: "1", max: "2.5", value: "1", step: "any", hidden: true, "aria-label": "Photo zoom" });
    const cancel = action("Cancel", { className: "v2-profile-form-cancel", "aria-label":"Cancel profile photo edit" });
    const photoSaveLabel = editExisting ? "Done" : "Submit for approval";
    const save = action(photoSaveLabel, { className: "v2-profile-form-save", "aria-label":editExisting ? "Save profile photo" : "Submit photo for approval" });
    const photoStatus = node("p", { className: "v2-settings-inline-status", role: "status", "aria-live": "polite" });
    const savedPhoto = node("img", { alt: "Currently saved profile photo", hidden: true, width: "96", height: "96" });
    if (!editExisting && (user.pendingProfileImageKey || user.pendingProfileImage)) photoStatus.textContent = "This replaces your previous submission.";
    const zoomOut = action("−", { className: "v2-photo-zoom-button", "aria-label": "Zoom out" });
    const zoomIn = action("+", { className: "v2-photo-zoom-button", "aria-label": "Zoom in" });
    const reset = action("Reset", { className: "v2-photo-reset" });
    const instruction = node("p", { className: "v2-photo-crop-hint", id: "v2-photo-crop-hint" }, [
      node("span", {className:"v2-photo-hint-desktop",text:"Drag to move. Scroll to zoom."}),
      node("span", {className:"v2-photo-hint-touch",text:"Pinch to zoom. Drag to move."}),
    ]);
    viewport.setAttribute("aria-describedby", instruction.id);
    const zoomControls = node("div", { className: "v2-photo-zoom-controls", "aria-label": "Photo zoom controls" }, [zoomOut, zoom, zoomIn, reset]);
    dialog.append(
      node("header", {className:"v2-photo-crop-header"}, [node("h2", {text:"Edit photo"})]),
      node("div", {className:"v2-photo-crop-stage"}, [viewport]),
      node("div", {className:"v2-photo-crop-footer"}, [instruction, zoomControls]), photoStatus, savedPhoto,
      node("footer", {className:"v2-photo-crop-actions"}, [cancel, save]),
    );
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
        save.textContent = photoSaveLabel;
      } catch (error) {
        if (accountStopped) return;
        photoNeedsCheck = true;
        photoStatus.textContent = "Photo save status is unknown. Check the saved photo before trying again.";
        photoStatus.dataset.state = "error"; save.textContent = "Check saved photo";
      }
    }
    let offsetX = 0;
    let offsetY = 0;
    const pointers = new Map();
    let gesture = null;
    let cropSize = 0;
    const cropSizeNow = () => Math.min(viewport.clientWidth,viewport.clientHeight || viewport.clientWidth)*0.84 || 300;
    const baseDimensions = () => cropFrame({naturalWidth:preview.naturalWidth,naturalHeight:preview.naturalHeight,size:cropSizeNow(),zoom:Number(zoom.value || 1),x:offsetX,y:offsetY});
    let restorePending = framing;
    const renderCrop = () => {
      const nextSize = cropSizeNow();
      if (cropSize && nextSize !== cropSize) { offsetX *= nextSize / cropSize; offsetY *= nextSize / cropSize; }
      cropSize = nextSize;
      if (restorePending) {
        const restored=restoreCrop(restorePending,preview.naturalWidth,preview.naturalHeight,cropSizeNow());
        if(restored){zoom.value=String(restored.zoom);offsetX=restored.x;offsetY=restored.y;}
        restorePending=null;
      }
      const frame=baseDimensions(); offsetX=frame.x; offsetY=frame.y;
      viewport.style.setProperty('--photo-crop-size',`${frame.size}px`);
      preview.style.width = `${frame.width}px`;
      preview.style.height = `${frame.height}px`;
      // Use explicit pixel coordinates: WebKit rounds percentage transforms
      // differently at each viewport size, which can shift a detailed crop.
      preview.style.left = "0"; preview.style.top = "0";
      preview.style.transform = `translate(${(viewport.clientWidth-frame.width)/2+offsetX}px, ${(viewport.clientHeight-frame.height)/2+offsetY}px)`;
    };
    const setZoom = (value, anchorX = 0, anchorY = 0) => {
      const previous = Number(zoom.value);
      zoom.value = String(Math.min(2.5, Math.max(1, value)));
      const ratio = Number(zoom.value) / previous;
      offsetX = anchorX - (anchorX - offsetX) * ratio;
      offsetY = anchorY - (anchorY - offsetY) * ratio;
      renderCrop();
    };
    // Safari otherwise blurs a keyboard-revealed touch control on pointerdown,
    // hiding it before its click can complete.
    zoomControls.addEventListener("pointerdown", event => { if (event.target.closest("button")) event.preventDefault(); });
    zoom.addEventListener("input", renderCrop);
    viewport.addEventListener("wheel", event => {
      if (save.disabled) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      setZoom(Number(zoom.value) * Math.exp(-delta * 0.002), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    }, {passive:false});
    zoomOut.addEventListener("click", () => { if (!save.disabled) setZoom(Number(zoom.value) - 0.15); });
    zoomIn.addEventListener("click", () => { if (!save.disabled) setZoom(Number(zoom.value) + 0.15); });
    reset.addEventListener("click", () => { if (!save.disabled) { offsetX = offsetY = 0; zoom.value = "1"; renderCrop(); } });
    viewport.addEventListener("keydown", event => {
      if (save.disabled) return;
      if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); setZoom(Number(zoom.value) + (event.key === "-" ? -0.1 : 0.1)); return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); const step = event.shiftKey ? 1 : 5;
      offsetX += event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      offsetY += event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      renderCrop();
    });
    const measureGesture = () => {
      const points = [...pointers.values()].slice(0, 2);
      if (!points.length) return null;
      const rect = viewport.getBoundingClientRect();
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length - rect.left - rect.width / 2;
      const y = points.reduce((sum, point) => sum + point.y, 0) / points.length - rect.top - rect.height / 2;
      return { x, y, distance: points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0 };
    };
    viewport.addEventListener("pointerdown", event => {
      if (save.disabled || event.button > 0) return;
      event.preventDefault(); viewport.dataset.adjusting = "true"; pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      viewport.setPointerCapture(event.pointerId); gesture = measureGesture();
    });
    viewport.addEventListener("pointermove", event => {
      if (save.disabled || !pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const next = measureGesture();
      if (gesture.distance && next.distance) setZoom(Number(zoom.value) * next.distance / gesture.distance, gesture.x, gesture.y);
      offsetX += next.x - gesture.x; offsetY += next.y - gesture.y;
      renderCrop(); gesture = next;
    });
    const endPointer = event => { pointers.delete(event.pointerId); gesture = measureGesture(); if (!pointers.size) delete viewport.dataset.adjusting; };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) viewport.addEventListener(type, endPointer);
    const cropResize = new ResizeObserver(() => {
      if (!dialog.open) return;
      renderCrop(); if (pointers.size) gesture=measureGesture();
    });
    cropResize.observe(viewport);
    cancel.addEventListener("click", () => dialog.close("cancel"));
    save.addEventListener("click", async () => {
      save.disabled = true;
      if (photoNeedsCheck) { await reviewSavedPhoto(); save.disabled = false; return; }
      save.textContent = editExisting ? "Saving…" : "Submitting…";
      zoom.disabled = true; cancel.disabled = true; zoomIn.disabled = zoomOut.disabled = reset.disabled = true;
      
      let photoWriteStarted = false;
      try {
        assertAccount(context);
        renderCrop();
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
        body.append("crop", JSON.stringify(cropDescriptor(baseDimensions(),preview.naturalWidth,preview.naturalHeight)));
        body.append("original", file, file.name || (type === "image/png" ? "profile-original.png" : "profile-original.jpg"));
        if (editExisting) body.append("editExisting", "1");
        body.set("expectedPhotoRevision", expectedPhotoRevision);
        photoWriteStarted = true;
        const result = editExisting
          ? await writeAccount("/api/uploads/profile-photo/crop", "POST", {crop:cropDescriptor(baseDimensions(),preview.naturalWidth,preview.naturalHeight),expectedPhotoRevision}, context)
          : await writeAccount("/api/uploads/profile-photo", "POST", body, context);
        const fresh = await readAccountProfile(context);
        if (fresh.profilePhotoRevision !== result.profilePhotoRevision) throw new Error("The saved photo changed in another session.");
        user = fresh;
        renderers.get("photo")?.();
        updateReadiness();
        updateIdentity?.(user);
        invalidateHome?.();
        invalidateBrowse?.();
        dialog.close("saved");
        showToast?.(editExisting ? (result?.pending ? "Photo crop updated. Approval is still pending." : "Photo crop updated.") : String(result?.status || "").toLowerCase() === "pending_review" ? "Photo submitted! LPC will review it before your profile becomes visible to attorneys." : "Profile photo updated.");
      } catch (error) {
        if (!accountStopped && photoWriteStarted) await reviewSavedPhoto();
        else if (!accountStopped) {
          photoStatus.textContent = editExisting ? "This crop could not be prepared. Your saved photo has not changed." : "This image could not be prepared. Your photo has not been submitted. Choose another JPEG or PNG.";
          photoStatus.dataset.state = "error"; save.textContent = photoSaveLabel;
        }
      } finally {
        save.disabled = false; zoom.disabled = false; cancel.disabled = false; zoomIn.disabled = zoomOut.disabled = reset.disabled = false;
        
      }
    });
    dialog.addEventListener("cancel", event => { event.preventDefault(); if (!save.disabled) dialog.close("cancel"); });
    dialog.addEventListener("close", () => {
      cropResize.disconnect(); pointers.clear();
      URL.revokeObjectURL(loaded.url); dialog.remove();
      photoEditing = false; if (!accountStopped) renderers.get('profileEditActions')?.();
      const launcher = getPhotoReturnFocus?.() || returnFocus || photoButton;
      if (launcher instanceof HTMLElement && launcher.isConnected) launcher.focus();
    }, { once: true });
    dialog.showModal();
    requestAnimationFrame(renderCrop);
    viewport.focus();
  }

  function securityCard(title, copy = "", className = "") {
    return node("section", { className: `v2-settings-card v2-settings-security-card ${className}`.trim() }, [sectionHeader(title, copy)]);
  }

  function payoutCard(stripe) {
    const state = stripe?.readiness || {};
    const ready = state.ready === true;
    const accountUnavailable = stripe?.connectionIssue === "account_access_unavailable";
    const unavailable = !stripe || (state.evidenceState && state.evidenceState !== "verified");
    const card = securityCard("Stripe payouts", ready
      ? "Stripe reports your payout setup is ready. This does not confirm a payment or bank arrival."
      : accountUnavailable ? "LPC can’t access your linked Stripe account. Contact support to restore the connection."
      : unavailable ? "We couldn’t verify payout setup. Open Stripe to check your details."
        : "Complete Stripe setup before applying or receiving payments.", "v2-settings-payout-card");
    const badge = node("span", { className: "v2-settings-status-badge", "data-state": ready ? "ready" : unavailable ? "unknown" : "action", text: ready ? "Payout setup ready" : accountUnavailable ? "Stripe connection needs attention" : unavailable ? "Can’t check Stripe status" : "Action required" });
    const open = accountUnavailable ? routeLink("Contact support", "/help", "v2-settings-primary") : action(ready || state.accountPresent ? "Update Stripe details" : "Connect Stripe", { className: "v2-settings-primary" });
    if (!accountUnavailable) open.addEventListener("click", async () => {
      open.disabled = true;
      open.textContent = "Opening Stripe…";
      try { await startStripeOnboarding(); } catch (error) {
        open.disabled = false;
        open.textContent = ready || state.accountPresent ? "Update Stripe details" : "Connect Stripe";
        showToast?.(error?.message || "Unable to open Stripe.", { tone: "error" });
      }
    });
    const last4 = String(stripe?.bank_last4 || "").trim();
    const bankName = String(stripe?.bank_name || "").trim();
    const bank = !accountUnavailable && state.evidenceState === "verified" && /^\d{4}$/.test(last4)
      ? node("p", { className: "v2-settings-payout-bank", text: `${bankName || "Payout account"} •••• ${last4}` })
      : null;
    const heading = card.querySelector(".v2-settings-section-heading");
    const note = heading.querySelector("p");
    if (note) { note.remove(); note.className = "v2-settings-payout-note"; }
    heading.append(badge);
    const summary = bank ? node("div", { className: "v2-settings-payout-summary" }, [
      node("span", { className: "v2-settings-payout-label", text: "Payout account" }), bank,
    ]) : null;
    card.append(
      node("div", { className: "v2-settings-card-actions" }, [summary, open]),
      ...(note ? [note] : []),
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
    securityCategory = "signin";
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
    const navigation = node("nav", { className: "pv2-security-navigation", "aria-label": "Security sections" });
    const panels = node("div", { className: "pv2-security-panels" });
    const payouts = payoutCard(stripe);
    panels.append(signInSecurity, blockedSettings, payouts, closureSettings);
    const categories = [["signin", "Sign-in"], ["devices", "Devices"], ["blocked", "Blocked users"], ["payouts", "Payout account"], ["closure", "Account closure"]];
    const selectCategory = (key) => {
      securityCategory = key;
      signInSecurity.dataset.securityCategory = key;
      signInSecurity.hidden = !["signin", "devices"].includes(key);
      blockedSettings.hidden = key !== "blocked";
      payouts.hidden = key !== "payouts";
      closureSettings.hidden = key !== "closure";
      navigation.querySelectorAll("button").forEach(button => {
        if (button.dataset.securityCategory === key) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
    };
    for (const [key, label] of categories) {
      const button = action(label, { className: "pv2-security-nav-item", "data-security-category": key });
      button.addEventListener("click", () => selectCategory(key));
      navigation.append(button);
    }
    securityPanel.replaceChildren(
      ...(snapshot.failures ? [node("div", { className: "v2-settings-panel-toolbar" }, [node("p", { text: "Some account items are temporarily unavailable." })])] : []),
      node("div", { className: "pv2-security-layout" }, [navigation, panels]),
    );
    selectCategory(securityCategory);
    arrangeSettingsSections(securityPanel);
  }

  async function loadSecurity({ force = false } = {}) {
    if (!securityPanel || accountStopped) return;
    if (securityLoaded && !force) return;
    if (securityPromise) return securityPromise;
    const context = accountContext();
    securityPanel.setAttribute("aria-busy", "true");
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
      // Mount the filtered menu shell before waiting for payout/account reads.
      renderSecurityContent({ stripe: null, failures: 0 });
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
      // The mountain cover must wait for every mounted Security controller,
      // including panels that are initially hidden by the section menu.
      await Promise.allSettled([view.readiness, blockedSettings?.readiness, closureSettings?.readiness]);
      if (view !== signInSecurity || !securityPanel) return;
      const value = index => results[index].status === "fulfilled" ? results[index].value : null;
      renderSecurityContent({ stripe: value(0), failures: results.filter(entry => entry.status !== "fulfilled").length });
      if (results[0].status === "fulfilled") invalidateWork?.();
      securityLoaded = true;
    })().catch(() => {
      if (view !== signInSecurity || accountStopped) return;
      renderSecurityContent({ stripe: null, failures: 1 });
    }).finally(() => {
      if (securityPromise === pending) {
        securityPromise = null;
        if (view === signInSecurity) securityPanel?.setAttribute("aria-busy", "false");
      }
    });
    securityPromise = pending;
    return pending;
  }

  function switchControl({ label, copy = "", checked = false, disabled = false, name = "" }) {
    const control = input({ type: "checkbox", checked, disabled, "aria-label": name || label });
    const toggle = node("span", { className: "v2-settings-switch" }, [control, node("span", { "aria-hidden": "true" })]);
    return {
      control,
      row: node("label", { className: `v2-settings-preference-row${disabled ? " is-disabled" : ""}` }, [
        node("div", {}, [node("strong", { text: label }), copy ? node("p", { text: copy }) : null]),
        toggle,
      ]),
    };
  }

  let preferenceRecovery = null;

  function preferenceSnapshot(snapshot = user) {
    return { ...(snapshot.preferences || {}), accentColor: normalizeAccent(snapshot.preferences?.accentColor), state: snapshot.state || snapshot.location || "", email: snapshot.notificationPrefs?.email !== false };
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
        ...(Object.prototype.hasOwnProperty.call(preferences, "accentColor") ? { accentColor: normalizeAccent(preferences.accentColor) } : {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, "theme") ? { theme: preferences.theme } : {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, "fontSize") ? { fontSize: preferences.fontSize } : {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, "hideProfile") ? { hideProfile: preferences.hideProfile } : {}),
      },
    };
    updateIdentity?.(user);
  }

  function queuePreferenceSave(work, { success = "Saved", rollback = null, onStatus = setPreferenceStatus } = {}) {
    preferencePendingCount += 1;
    preferenceQueue = preferenceQueue.then(() => {
      onStatus("Saving…", "saving");
      return work();
    }).then((result) => {
      onStatus(success, "saved");
      return result;
    }).catch((error) => {
      if (!accountStopped) rollback?.(error);
      onStatus(error?.message || "We couldn’t confirm this setting. Check your saved settings.", "error");
      return null;
    });
    preferenceQueue = preferenceQueue.finally(() => { preferencePendingCount -= 1; });
    return preferenceQueue;
  }

  function notificationsPreferenceCard() {
    const prefs = user.notificationPrefs || {};
    const card = node("section", { className: "v2-settings-card v2-settings-card--notifications" }, [sectionHeader("Notifications")]);
    const onStatus = preferenceStatusFor(card);
    const inApp = switchControl({ label: "Notifications in LPC", copy: "Alerts in your LPC notification bell.", checked: prefs.inApp !== false });
    const inAppMessages = switchControl({ label: "Messages in LPC", checked: prefs.inAppMessages !== false, disabled: prefs.inApp === false });
    const inAppCase = switchControl({ label: "Matter updates in LPC", checked: prefs.inAppCase !== false, disabled: prefs.inApp === false });
    const email = switchControl({ label: "Email notifications", checked: prefs.email !== false });
    const messages = switchControl({ label: "New message alerts", copy: "Email me about new messages.", checked: prefs.emailMessages !== false, disabled: prefs.email === false });
    const matters = switchControl({ label: "Matter updates", copy: "Email me about Matter updates.", checked: prefs.emailCase !== false, disabled: prefs.email === false });

    const channelStates = [];
    const syncChildState = () => {
      channelStates.forEach(([master, status]) => {
        status.textContent = master.control.checked ? "Enabled" : "Disabled";
        status.dataset.enabled = String(master.control.checked);
      });
      for (const [master, children] of [[inApp, [inAppMessages, inAppCase]], [email, [messages, matters]]]) {
        children.forEach((item) => {
          item.control.disabled = !master.control.checked;
          item.row.classList.toggle("is-disabled", !master.control.checked);
        });
      }
    };
    const controls = [[inApp, "inApp"], [inAppMessages, "inAppMessages"], [inAppCase, "inAppCase"], [email, "email"], [messages, "emailMessages"], [matters, "emailCase"]];
    controls.forEach(([item, key]) => {
      item.control.addEventListener("change", () => {
        const next = item.control.checked;
        const previous = user.notificationPrefs?.[key] !== false;
        const context = accountContext();
        if (["email", "inApp"].includes(key)) syncChildState();
        queuePreferenceSave(async () => {
        const result = await savePreferencePatch({ [key]: next }, { [key]: previous }, { notification: true, context });
          user.notificationPrefs = { ...(user.notificationPrefs || {}), ...(result?.notificationPrefs || {}) };
          if (result?.updatedAt) user.updatedAt = result.updatedAt;
          if (key === "email") preferences.email = next;
          invalidateHome?.();
          return result;
        }, {
          success: "Saved", onStatus,
          rollback: (error) => { if (error.latest) item.control.checked = error.latest.notificationPrefs?.[key] !== false; syncChildState(); },
        });
      });
    });
    renderers.set("notificationControls", () => { controls.forEach(([item, key]) => { item.control.checked = user.notificationPrefs?.[key] !== false; }); syncChildState(); });
    // Linear's channel disclosures keep related native switches together and
    // preserve each control's existing accessible name and save/recovery logic.
    const channels = node("div", { className: "lpc-settings-notification-channels" });
    const symbols = {
      app: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-4 0h8"/>',
      email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
    };
    for (const [label, key, master, children] of [
      ["In LPC", "app", inApp, [inAppMessages, inAppCase]],
      ["Email", "email", email, [messages, matters]],
    ]) {
      master.row.querySelector("strong").textContent = "Allow notifications";
      for (const item of [master, ...children]) item.row.querySelector("p")?.remove();
      children[0].row.querySelector("strong").textContent = "Messages";
      children[1].row.querySelector("strong").textContent = "Matter updates";
      const icon = node("span", { className: "lpc-settings-channel-icon", "aria-hidden": "true" });
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${symbols[key]}</svg>`;
      const status = node("span", { className: "lpc-settings-channel-status" });
      channelStates.push([master, status]);
      const channel = node("details", { className: "lpc-settings-notification-channel", "data-notification-channel": key }, [
        node("summary", {}, [icon, node("strong", { text: label }), status, portalIcon("chevron", "lpc-settings-channel-chevron")]),
        node("div", { className: "lpc-settings-channel-controls", role: "group", "aria-label": `${label} notifications` }, [master.row, ...children.map(item => item.row)]),
      ]);
      channels.append(channel);
    }
    syncChildState();
    card.append(channels);
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
    const card = node("section", { className: "v2-settings-card v2-settings-card--visibility", "aria-label": "Profile visibility" }, [visibility.row]);
    const onStatus = preferenceStatusFor(card);
    const syncVisibilityExplanation = (approved) => {
      const reason = "Your profile remains hidden until your photo is approved.";
      visibility.row.title = approved ? "" : reason;
      visibility.control.title = approved ? "" : reason;
      const toggle = visibility.control.closest("label");
      toggle.title = approved ? "" : reason;
      toggle.tabIndex = approved ? -1 : 0;
      if (approved) toggle.removeAttribute("aria-label");
      else toggle.setAttribute("aria-label", `Hide profile. ${reason}`);
    };
    syncVisibilityExplanation(approvedPhoto);
    visibility.control.addEventListener("change", () => {
      const next = visibility.control.checked;
      const previous = preferences.hideProfile === true;
      const context = accountContext();
      queuePreferenceSave(async () => {
        const result = await savePreferencePatch({ hideProfile: next }, { hideProfile: previous }, { context });
        mergePreferences(result, { hideProfile: next });
        invalidateBrowse?.();
        return result;
      }, { success: "Saved", onStatus, rollback: (error) => { if (error.latest) visibility.control.checked = error.latest.preferences?.hideProfile === true; } });
    });
    renderers.set("visibilityControl", () => {
      const approved = String(user.profilePhotoStatus || "").toLowerCase() === "approved" && !user.pendingProfileImage && Boolean(user.profileImage || user.avatarURL);
      visibility.control.checked = preferences.hideProfile === true || !approved;
      visibility.control.disabled = !approved;
      syncVisibilityExplanation(approved);
      visibility.row.classList.toggle("is-disabled", !approved);
      const description = visibility.row.querySelector("div");
      let copy = description.querySelector("p");
      if (!approved && !copy) { copy = node("p"); description.append(copy); }
      if (copy) { copy.textContent = approved ? "" : "Your profile remains hidden until your profile photo is approved."; copy.hidden = approved; }
    });
    return card;
  }

  function primaryStateCard() {
    const state = bindProfileInput(select([["", "Choose…"], ...STATES], { value: profile.state, 'aria-label': 'Residence', required: true }), 'state', normalizedState);
    state.options[0].disabled = true;
    renderers.set('primaryStateControl', () => { state.value = profile.state; });
    return node('section', { className: 'v2-settings-card', 'data-profile-section': 'primary-state' }, [sectionHeader('Residence'), field('Residence', state)]);
  }

  function workspacePreferenceCard() {
    const theme = currentTheme(preferences.theme || user.preferences?.theme);
    const size = FONT_SIZES[preferences.fontSize] ? preferences.fontSize : "md";
    const card = node("section", { className: "v2-settings-card v2-settings-card--workspace" }, [sectionHeader("Appearance")]);
    const onStatus = preferenceStatusFor(card);
    const themeGroup = node("div", { className: "v2-settings-theme-options", role: "radiogroup", "aria-label": "Appearance" });
    [
      ["light", "Light"],
      ["dark", "Dark"],
      ["system", "Auto"],
    ].forEach(([value, label]) => {
      const button = node("button", { className: "v2-settings-theme", type: "button", role: "radio", "aria-checked": String(theme === value), "data-theme": value, tabindex: theme === value ? "0" : "-1", title: value === "system" ? "Light 7 a.m.–7 p.m.; dark overnight (local time)" : label }, [
        node("span", { className: `v2-settings-theme-swatch v2-settings-theme-swatch--${value}`, "aria-hidden": "true" }, [
          node("img", { src: `assets/images/lpc-appearance-${value === "system" ? "auto" : value}.svg`, alt: "", width: "144", height: "90" }),
        ]),
        node("span", {}, [node("strong", { text: label })]),
      ]);
      button.addEventListener("click", () => {
        const next = value;
        const previous = currentTheme(preferences.theme);
        const expectedTheme = preferences.theme || user.preferences?.theme || "light";
        const context = accountContext();
        if (next === previous) return;
        applyAppearance(next);
        themeGroup.querySelectorAll("[role=radio]").forEach((candidate) => { candidate.setAttribute("aria-checked", String(candidate.dataset.theme === next)); candidate.tabIndex = candidate.dataset.theme === next ? 0 : -1; });
        queuePreferenceSave(async () => {
          const result = await savePreferencePatch({ theme: next }, { theme: expectedTheme }, { context });
          mergePreferences(result, { theme: next });
          return result;
        }, {
          success: "Saved", onStatus,
          rollback: (error) => {
            if (!error.latest) return;
            const latest = currentTheme(error.latest.preferences?.theme);
            applyAppearance(latest);
            themeGroup.querySelectorAll("[role=radio]").forEach((candidate) => { candidate.setAttribute("aria-checked", String(candidate.dataset.theme === latest)); candidate.tabIndex = candidate.dataset.theme === latest ? 0 : -1; });
          },
        });
      });
      button.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const values = ["light", "dark", "system"];
        const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
        const next = event.key === "Home" ? values[0] : event.key === "End" ? values[2] : values[(values.indexOf(value) + direction + 3) % 3];
        themeGroup.querySelector(`[data-theme="${next}"]`)?.click();
        themeGroup.querySelector(`[data-theme="${next}"]`)?.focus();
      });
      themeGroup.append(button);
    });
    const readingSize = createReadingSizeControl(size, { onPreview: next => { document.documentElement.style.fontSize = FONT_SIZES[next]; } });
    const font = readingSize.control;
    font.addEventListener("change", () => {
      const next = FONT_SIZES[font.value] ? font.value : "md";
      const previous = FONT_SIZES[preferences.fontSize] ? preferences.fontSize : "md";
      const context = accountContext();
      document.documentElement.style.fontSize = FONT_SIZES[next];
      queuePreferenceSave(async () => {
        const result = await savePreferencePatch({ fontSize: next }, { fontSize: previous }, { context });
        mergePreferences(result, { fontSize: next });
        return result;
      }, { success: "Saved", onStatus, rollback: (error) => { if (error.latest) { font.value = error.latest.preferences?.fontSize || "md"; readingSize.sync(font.value); document.documentElement.style.fontSize = FONT_SIZES[font.value]; } } });
    });
    renderers.set("workspaceControls", () => {
      const latest = currentTheme(preferences.theme);
      applyAppearance(latest);
      themeGroup.querySelectorAll("[role=radio]").forEach(candidate => { candidate.setAttribute("aria-checked", String(candidate.dataset.theme === latest)); candidate.tabIndex = candidate.dataset.theme === latest ? 0 : -1; });
      font.value = preferences.fontSize || "md"; readingSize.sync(font.value); document.documentElement.style.fontSize = FONT_SIZES[font.value];
    });
    card.append(
      node("div", { className: "lpc-appearance-settings" }, [
        node("div", { className: "v2-settings-preference-block" }, [node("div", {className:"lpc-theme-row-label",text:"Theme"}), themeGroup]),
        readingSize.element,
      ]),
    );
    return card;
  }

  function renderPreferencesPanel() {
    const panel = node("section", { className: "v2-settings-panel", role: "tabpanel", id: "v2-settings-preferences", "aria-labelledby": "v2-settings-tab-preferences", hidden: true });
    mountSaveFeedback("preferences", [saveIndicator({ "data-preference-status": "" })]);
    const appearance = workspacePreferenceCard();
    const notifications = notificationsPreferenceCard();
    const visibility = visibilityPreferenceCard();
    visibility.prepend(sectionHeader('Profile visibility'));
    const navigation = node('nav', {className:'lpc-preferences-navigation','aria-label':'Preference sections'});
    const sections = [['appearance','Appearance',appearance],['notifications','Notifications',notifications],['visibility','Profile visibility',visibility]];
    for (const [key,label,card] of sections) {
      card.dataset.preferenceSection = key;
      card.hidden = key !== 'appearance';
      const button = action(label, {className:'lpc-preferences-nav-item',...(key==='appearance'?{'aria-current':'page'}:{})});
      button.addEventListener('click',()=>{
        for (const [id,,section] of sections) section.hidden = id !== key;
        navigation.querySelectorAll('button').forEach(item=>item.removeAttribute('aria-current'));
        button.setAttribute('aria-current','page');
      });
      navigation.append(button);
    }
    panel.append(node('div',{className:'lpc-preferences-layout'},[navigation,node('div',{className:'lpc-preferences-panels'},[appearance,notifications,visibility])]));
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
    const tabs = node("div", { className: "v2-settings-tabs", role: "tablist", "aria-label": "Settings" });
    [["profile", "Profile"], ["preferences", "Preferences"], ["security", "Security"]].forEach(([name, label]) => {
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
      node("h1", { text: "Settings" }),
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
    const pageTitle = root?.querySelector(".v2-settings-header h1");
    if (pageTitle) pageTitle.textContent = "Settings";
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
    if (safe === "security") root.readiness = loadSecurity();
    else { leaveSecurity(); root.readiness = Promise.resolve(); }
    return safe;
  }

  function tabForRoute(route) {
    const requested = String(route?.query?.get("tab") || "").toLowerCase();
    const section = String(route?.query?.get("section") || "").toLowerCase();
    if (section === "payments" || section === "blocked" || section === "sessions" || section === "password" || section === "verification" || section === "passkeys" || section === "closure") return "security";
    return ["profile", "security", "preferences"].includes(requested) ? requested : "profile";
  }

  function afterMount(route, attempt = 0, { suppressIntro = false } = {}) {
    if (accountStopped) return;
    const tabs = root?.querySelector('.v2-settings-tabs');
    if (tabs && attempt === 0) {
      tabLayoutObserver?.disconnect();
      const header = root.querySelector('.v2-settings-header');
      const syncOrientation = () => {
        if (accountStopped || !root?.contains(tabs) || !tabs.isConnected) return;
        tabs.setAttribute('aria-orientation', getComputedStyle(tabs).flexDirection === 'column' ? 'vertical' : 'horizontal');
        if (header) root.style.setProperty('--v2-profile-save-offset', `${Math.ceil(header.getBoundingClientRect().height)}px`);
      };
      syncOrientation();
      tabLayoutObserver = new ResizeObserver(syncOrientation);
      tabLayoutObserver.observe(tabs);
      if (header) tabLayoutObserver.observe(header);
    }
    if (!suppressIntro && tabForRoute(route) === "profile" && !document.querySelector("[data-v2-onboarding-dialog][open]")) {
      const mountedRoot=root;
      const showIntro=()=>{if(!accountStopped&&root===mountedRoot&&root?.isConnected&&!profilePanel?.hidden&&!document.querySelector("[data-v2-onboarding-dialog][open]"))resumeImporter().showFirstVisit(document.querySelector("[data-resume-autofill]"));};
      if(window.LPC_PORTAL_BOOT?.pending)void window.LPC_PORTAL_BOOT.finished.then(showIntro);
      else showIntro();
    }
    const section = String(route?.query?.get("section") || "").toLowerCase();
    if (!section) return;
    const profileSections = ["primary-state", "bio", "skills", "practice-areas", "state-experience", "résumé", "profile-photo"];
    // Saved profile fields are inline triggers; hidden editor-bank cards cannot
    // be scrolled into view. Open the corresponding visible field instead.
    if (tabForRoute(route) === "profile" && profileSections.includes(section)) {
      const direct = root?.querySelector(`[data-profile-direct-section="${section}"]`);
      if (direct?.getClientRects().length) {
        requestAnimationFrame(() => { if (direct.isConnected) direct.click(); });
        return;
      }
    }
    const selector = profileSections.includes(section) ? `[data-profile-section="${section}"]` : { payments: "#v2-settings-payments", blocked: "#v2-settings-blocked", sessions: "#pv2-security-sessions", password: "#pv2-security-password", verification: "#pv2-security-verification", passkeys: "#pv2-security-passkeys", closure: "#v2-settings-closure" }[section];
    if (!selector) return;
    const target = root?.querySelector(selector);
    if (!target && tabForRoute(route) === "security" && attempt < 30) {
      window.setTimeout(() => afterMount(route, attempt + 1, {suppressIntro}), 80);
      return;
    }
    requestAnimationFrame(() => { target?.scrollIntoView({ block: "start" }); if (target?.classList.contains("pv2-security-section")) target.querySelector("button:not(:disabled)")?.focus(); });
  }

  async function render({ route, isCurrent }) {
    try { await loadCore({ isCurrent }); }
    catch (error) { if (!accountStopped) throw error; }
    if (!isCurrent()) return null;
    if (accountStopped) return createAccountRecoveryView();
    if (!root) {
      await loadProtectedDraft();
      if (!isCurrent()) return null;
      if (accountStopped) return createAccountRecoveryView();
      buildRoot();
      for (const event of ["focusin", "input", "change", "click"]) root.addEventListener(event, () => { interactionRevision += 1; }, { capture: true });
    }
    const section = String(route?.query?.get('section') || '');
    const category = {payments:'payouts',blocked:'blocked',sessions:'devices',closure:'closure',password:'signin',verification:'signin',passkeys:'signin'}[section];
    if (category) securityCategory=category;
    activateTab(tabForRoute(route));
    if (category && securityLoaded) root.querySelector(`.pv2-security-nav-item[data-security-category="${category}"]`)?.click();
    return root;
  }

  async function renderPreview({ isCurrent }) {
    try { await loadCore({ isCurrent }); }
    catch (error) { if (!accountStopped) throw error; }
    if (!isCurrent()) return null;
    if (accountStopped) return createAccountRecoveryView();
    const savedUser = await readAccountProfile();
    if (!isCurrent()) return null;
    // The owner preview must use the saved public fields, not uncommitted form
    // values. Attorneys receive this same projection from /api/paralegals/:id.
    const candidate = projectCandidate(savedUser, ownerOf(savedUser), "authenticated");
    const savedProfile = normalizeProfile(savedUser);
    const hidden = savedUser.preferences?.hideProfile === true;
    const photoPending = String(savedUser.profilePhotoStatus || "").toLowerCase() !== "approved" || Boolean(savedUser.pendingProfileImage) || !Boolean(savedUser.profileImage || savedUser.avatarURL);
    const missing = readiness(savedUser, savedProfile);
    const documents = (candidate.documents || []).map(({ label, key }) => [label, key, { "Résumé": "resumeURL", "Certificate": "certificateURL", "Writing sample": "writingSampleURL" }[label]]).filter(([, , field]) => field);
    const savedChangesPending = profileSavedRevision !== profileRevision || Boolean(profileSavePromise) || Boolean(unresolvedProfileSave);
    const page = node("section", { className: "v2-settings-preview", "data-v2-profile-preview": "" }, [
      node("header", { className: "v2-settings-preview-header", "data-lpc-row-static": "" }, [
        node("div", { className: "v2-settings-preview-context" }, [
          node("h2", { text: "Attorney view" }),
          node("p", { text: "This is how attorneys see your profile. The attorney actions below are for preview only." }),
        ]),
        routeLink("Edit profile", "/settings?tab=profile", "v2-settings-preview-back v2-settings-preview-edit"),
      ]),
    ]);
    if (savedChangesPending) page.append(node("p", { className: "v2-settings-preview-notice", role: "status", text: "Your latest edits are still saving. This preview shows the last saved profile." }));
    if (hidden || photoPending || missing.length) {
      const photoNotice = "Your profile remains hidden until your photo is approved.";
      const incompleteNotice = "Your profile is incomplete. Finish the required items before attorneys can find it.";
      const noticeText = node("span", { text: photoPending ? photoNotice : hidden ? "Your profile is hidden from discovery. This is how its saved details will appear when visible." : incompleteNotice });
      const notice = node("div", { className: "v2-settings-preview-notice", role: "status" }, [noticeText]);
      if (hidden && !photoPending) {
        const unhide = action("Unhide profile", { className: "v2-settings-text-action" });
        unhide.style.marginInlineStart = "12px";
        unhide.addEventListener("click", async () => {
          if (unhide.disabled) return;
          unhide.disabled = true;
          const context = accountContext();
          await queuePreferenceSave(async () => {
            const latest = await readAccountProfile(context);
            assertAccount(context);
            const approved = String(latest.profilePhotoStatus || "").toLowerCase() === "approved" && !latest.pendingProfileImage && Boolean(latest.profileImage || latest.avatarURL);
            if (!approved) { noticeText.textContent = photoNotice; unhide.hidden = true; return; }
            const result = await savePreferencePatch({ hideProfile: false }, { hideProfile: latest.preferences?.hideProfile === true }, { context });
            mergePreferences(result, { hideProfile: false });
            invalidateBrowse?.();
            renderers.get("visibilityControl")?.();
            unhide.hidden = true;
            noticeText.textContent = readiness(latest, normalizeProfile(latest)).length ? incompleteNotice : "Your profile is no longer hidden.";
          }, { onStatus: (copy, state) => {
            if (state === "saving") unhide.textContent = "Unhiding…";
            if (state === "error") noticeText.textContent = copy;
          } });
          if (!accountStopped && isCurrent()) { unhide.disabled = false; unhide.textContent = "Unhide profile"; }
        });
        notice.append(unhide);
      }
      page.append(notice);
    }
    // Attorney-only operations are presentational here and cannot send an
    // invitation or save the owner as a candidate. Editing stays outside.
    const save = node("button", { type: "button", className: "lpc-saved-button lpc-save-star", disabled: true, "aria-label": "Save paralegal (preview only)" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");path.setAttribute("d", "M6 3h12v18l-6-4-6 4V3Z");svg.append(path);save.append(svg);
    const actions = node("div", { className: "av2-profile-actions lpc-candidate-preview-actions", "aria-label": "Attorney actions (preview only)" }, [
      node("section", { className: "lpc-save-paralegal" }, [node("div", { className: "lpc-saved-actions" }, [save])]),
      node("div", { className: "av2-profile-invite" }, [node("button", { type: "button", className: "lpc-candidate-preview-invite", disabled: true, text: "Invite to a Matter", "aria-label": "Invite to a Matter (preview only)" })]),
    ]);
    const profileDocuments = node("section", { className: "av2-profile-section av2-profile-documents", "aria-label": "Profile documents" }, documents.map(([label, key, field]) => node("div", { className: "av2-actions" }, [node("a", {
      className: "av2-profile-document-link", href: documentReadUrl(field, key, "view"), target: "_blank", rel: "noopener noreferrer", text: `View ${label.toLowerCase()}`,
    })])));
    const hiring = node("div", { className: "av2-profile-hiring" }, [node("span", { text: "Continue to hiring", "aria-label": "Continue to hiring (preview only)", className: "lpc-candidate-preview-hiring" })]);
    page.append(renderCandidateProfile(candidate, { actions, documents: profileDocuments, hiring }));
    // This is the saved attorney-facing preview; editing tools live in Settings.
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
    documentMenuController?.abort(); documentMenuController = null;
    tabLayoutObserver?.disconnect(); tabLayoutObserver = null;
    resumeImport?.destroy(); resumeImport = null;
    leaveSecurity(); delete securityAccountState.securityNotice; delete securityAccountState.blockedAction;
    Object.keys(closureAccountState).forEach(key => delete closureAccountState[key]);
    window.clearTimeout(profileSaveTimer); profileSaveTimer = null; clearDraft();
    accountGeneration += 1; accountStopped = true;
    accountRequests.forEach(controller => controller.abort()); accountRequests.clear();
    documentStates.clear(); documentWindows.forEach(popup => popup.close()); documentWindows.clear();
    unresolvedProfileSave = null; profileConflict = null; profileSavePromise = null; preferenceRecovery = null;
    profileUndo.length = profileRedo.length = 0; profileAutosaveBlocked = false; profileComposing = false; profileToolbarInteracting = false;
    profileSavedRevision = profileRevision; dirtyProfileFields.clear(); dirtyProfileBaselines.clear();
    document.querySelectorAll("dialog.v2-settings-dialog").forEach(dialog => dialog.close("account-changed"));
    user = null; profile = null; preferences = null; renderers.clear();
    // A stopped controller is never revived. Reentry starts a fresh document
    // and verifies its owner before reading or restoring any account data.
    root?.replaceWith(createAccountRecoveryView());
    root = null;
  }

  function hasPendingSettings() {
    return profileEditing || photoEditing || hasPendingDocuments() || profileSavePromise || profileSavedRevision !== profileRevision || primaryStateFeedback.state === "saving" || preferencePendingCount || preferenceRecovery || securityPromise || signInSecurity?.hasPending() || blockedSettings?.hasPending() || closureSettings?.hasPending() || closureSettings?.isReviewing() || closureAccountState.closure?.pending || document.querySelector("dialog.v2-settings-dialog[open]");
  }

  function resetView() {
    documentMenuController?.abort(); documentMenuController = null;
    resumeImport?.destroy(); resumeImport = null;
    leaveSecurity();
    tabLayoutObserver?.disconnect();
    tabLayoutObserver = null;
    root = null;
    dirtyProfileFields.clear(); dirtyProfileBaselines.clear();
    profileStatus = null;
    profileFeedback = { copy: "Changes saved", state: "saved" };
    primaryStateFeedback = { copy: "Changes saved", state: "saved" };
    profileSaveButton = null;
    profileEditing = false; profileCompositionScope = ""; photoEditing = false; profileEditingTitle = null; profileEditingIndex = null; profileEditingProperty = null; profileEditReturnLabel = null; profileEditBusy = false;
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
    openSetupResume: trigger => resumeImporter().open(trigger),
    async refreshSetupProfile() {
      if (photoEditing || resumeImport?.isOpen()) return user;
      const fresh = await readAccountProfile();
      user = fresh; profile = normalizeProfile(fresh); renderers.get('photo')?.();
      return fresh;
    },
    openSetupPhoto() { profilePanel?.querySelector('input[type="file"][accept*="image"]')?.click(); },
    hasUnsavedChanges: () => photoEditing || profileSavedRevision !== profileRevision || hasPendingDocuments() || closureSettings?.hasPending() || Boolean(closureAccountState.closure?.pending),
    getPendingClosure: () => closureAccountState.closure?.pending ? { ...closureAccountState.closure } : null,
    discardClosure() { delete closureAccountState.closure; clearClosureProof(); },
    clearDrafts: clearAccountDrafts,
    leave() { leaveSecurity(); resumeImport?.close(); document.querySelector("dialog.v2-photo-crop-dialog[open]")?.close("leave"); if (accountStopped) return; if (profileEditing) finishProfileEdit(); scheduleProfileAutosave(true); },
    invalidate() {
      if (hasPendingSettings()) return false;
      coreInvalidated = true;
      return true;
    },
  });
}
