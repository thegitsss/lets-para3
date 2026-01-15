import { secureFetch, persistSession, getStoredSession } from "./auth.js";
import { STRIPE_GATE_MESSAGE } from "./utils/stripe-connect.js";

document.addEventListener("DOMContentLoaded", () => {
  const navItems = {
    navProfile: "profileSection",
    navSecurity: "securitySection",
    navPreferences: "preferencesSection",
    navDelete: "deleteSection"
  };
  const topLevelSections = Object.values(navItems)
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const setActiveSection = (sectionId) => {
    topLevelSections.forEach((sec) => {
      sec.classList.remove("active");
      sec.classList.add("hidden");
      sec.setAttribute("aria-hidden", "true");
      sec.hidden = true;
      sec.style.setProperty("display", "none", "important");
    });
    const section = document.getElementById(sectionId);
    if (section) {
      section.classList.remove("hidden");
      section.classList.add("active");
      section.hidden = false;
      section.removeAttribute("aria-hidden");
      section.style.removeProperty("display");
      section.style.display = "block";
    }
  };

  Object.keys(navItems).forEach(navId => {
    const btn = document.getElementById(navId);
    const sectionId = navItems[navId];

    if (!btn) return;

    btn.addEventListener("click", () => {
      document.querySelectorAll(".settings-item").forEach(el => el.classList.remove("active"));
      btn.classList.add("active");
      setActiveSection(sectionId);
    });
  });

  const initialNav = document.querySelector(".settings-item.active");
  const initialSectionId = initialNav && navItems[initialNav.id]
    ? navItems[initialNav.id]
    : navItems.navProfile;
  setActiveSection(initialSectionId);

  const dashboardLink = document.getElementById("dashboardReturnLink");
  if (dashboardLink) {
    const session = getStoredSession();
    const role = String(session?.role || session?.user?.role || "").toLowerCase();
    if (role === "admin") {
      dashboardLink.href = "admin-dashboard.html";
    } else if (role === "paralegal") {
      dashboardLink.href = "dashboard-paralegal.html";
    } else {
      dashboardLink.href = "dashboard-attorney.html";
    }
  }

  const passwordBtn = document.getElementById("savePasswordBtn");
  if (passwordBtn) {
    passwordBtn.addEventListener("click", async () => {
      const newPass = document.getElementById("newPassword")?.value || "";
      const confirm = document.getElementById("confirmPassword")?.value || "";

      if (newPass !== confirm) {
        alert("Passwords do not match!");
        return;
      }

      const res = await fetch("/api/account/update-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: newPass })
      });

      const data = await res.json().catch(() => ({}));
      alert(data.msg || "Password updated!");
    });
  }

  const themeSelect = document.getElementById("themePreference");
  const themePreviewButtons = document.querySelectorAll("[data-theme-preview]");
  const emailToggle = document.getElementById("emailNotificationsToggle");
  const fontSizeSelect = document.getElementById("fontSizePreference");
  const hideProfileToggle = document.getElementById("paralegalHideProfile");
  statePreferenceSelect = document.getElementById("statePreference");

  const updateThemePreview = (value) => {
    if (!themePreviewButtons.length) return;
    themePreviewButtons.forEach((btn) => {
      const isActive = btn.dataset.themePreview === value;
      btn.setAttribute("aria-checked", isActive ? "true" : "false");
      btn.classList.toggle("is-active", isActive);
    });
  };

  async function persistThemePreference(themeValue, fontSizeValue) {
    try {
      const payload = {
        theme: themeValue || themeSelect?.value,
        fontSize: fontSizeValue || fontSizeSelect?.value,
        email: emailToggle ? !!emailToggle.checked : false,
        state: statePreferenceSelect ? statePreferenceSelect.value : undefined
      };
      await fetch("/api/account/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error("Failed to persist theme preference", err);
    }
  }

  const applyThemeSelection = (value) => {
    if (!value) return;
    if (themeSelect) {
      themeSelect.value = value;
    }
    updateThemePreview(value);
    if (typeof window.applyThemePreference === "function") {
      window.applyThemePreference(value);
    }
    if (currentUser) {
      currentUser.preferences = {
        ...(currentUser.preferences || {}),
        theme: value
      };
    }
    persistThemePreference(value, fontSizeSelect?.value);
  };

  const fontSizeMap = {
    xs: "14px",
    sm: "15px",
    md: "16px",
    lg: "17px",
    xl: "20px"
  };

  const applyFontSizeSelection = (value, options = {}) => {
    if (!value) return;
    if (fontSizeSelect) {
      fontSizeSelect.value = value;
    }
    if (typeof window.applyFontSizePreference === "function") {
      window.applyFontSizePreference(value);
    } else {
      const size = fontSizeMap[value] || fontSizeMap.md;
      document.documentElement.style.fontSize = size;
    }
    if (currentUser) {
      currentUser.preferences = {
        ...(currentUser.preferences || {}),
        fontSize: value
      };
    }
    if (!options.skipPersist) {
      persistThemePreference(themeSelect?.value, value);
    }
  };

  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      applyThemeSelection(themeSelect.value);
    });
  }

  if (fontSizeSelect) {
    fontSizeSelect.addEventListener("change", () => {
      applyFontSizeSelection(fontSizeSelect.value);
    });
  }

  themePreviewButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.themePreview;
      applyThemeSelection(value);
    });
  });

  if (themeSelect) {
    updateThemePreview(themeSelect.value);
  }

  const fullNameInput = document.getElementById("fullNameInput");
  if (fullNameInput) {
    fullNameInput.addEventListener("input", () => {
      syncNamePartsFromFullName();
    });
  }
  const yearsExperienceInput = document.getElementById("yearsExperienceInput");
  if (yearsExperienceInput) {
    yearsExperienceInput.addEventListener("input", () => {
      updateRoleLineFromExperience();
    });
  }

  async function loadPreferences() {
    try {
      const res = await fetch("/api/account/preferences", {
        credentials: "include"
      });
      if (!res.ok) return;
      const prefs = await res.json();
      if (emailToggle) emailToggle.checked = !!prefs.email;
      if (themeSelect) {
        const resolvedTheme = prefs.theme;
        if (resolvedTheme) {
          themeSelect.value = resolvedTheme;
          updateThemePreview(resolvedTheme);
          if (typeof window.applyThemePreference === "function") {
            window.applyThemePreference(resolvedTheme);
          }
          if (currentUser) {
            currentUser.preferences = {
              ...(currentUser.preferences || {}),
              theme: resolvedTheme
            };
          }
        }
      } else if (prefs.theme) {
        applyThemeSelection(prefs.theme);
      }
      if (fontSizeSelect) {
        const resolvedSize = prefs.fontSize || fontSizeSelect.value || "md";
        applyFontSizeSelection(resolvedSize, { skipPersist: true });
      }
      if (hideProfileToggle) hideProfileToggle.checked = !!prefs.hideProfile;
      const stateValue = prefs.state || currentUser?.location || currentUser?.state || "";
      if (statePreferenceSelect) {
        setStatePreferenceValue(stateValue);
      }
    } catch (err) {
      console.error("Failed to load preferences", err);
    }
  }
  loadPreferences();

  const prefBtn = document.getElementById("savePreferencesBtn");
  if (prefBtn) {
    prefBtn.addEventListener("click", async () => {
      const email = emailToggle ? emailToggle.checked : false;
      const theme = themeSelect ? themeSelect.value : "mountain";
      const state = statePreferenceSelect ? statePreferenceSelect.value : "";

      const res = await fetch("/api/account/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, theme, state })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        showToast(data.error || "Unable to save preferences.", "err");
        return;
      }

      if (theme && typeof window.applyThemePreference === "function") {
        window.applyThemePreference(theme);
      }
      if (currentUser) {
        currentUser.preferences = {
          ...(currentUser.preferences || {}),
          theme
        };
        currentUser.location = state || "";
        currentUser.state = state || "";
        persistSession({ user: mergeSessionPreferences(currentUser) });
      }
      hydrateStatePreference(currentUser || { state });
      showToast("Preferences saved", "ok");
    });
  }

  const deleteBtn = document.getElementById("deleteAccountBtn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Are you sure? This action cannot be undone.")) return;

      const res = await secureFetch("/api/account/delete", { method: "DELETE" });

      if (res.ok) {
        window.location.href = "/goodbye.html";
      } else {
        alert("Error deleting account.");
      }
    });
  }

  // --- BLOCKED USERS ---
  async function loadBlockedUsers() {
    const container = document.getElementById("blockedUsersList");
    if (!container) return;

    try {
      const res = await fetch("/api/users/me/blocked", { credentials: "include" });
      const data = await res.json();

      if (!Array.isArray(data) || !data.length) {
        container.innerHTML = "<p class='muted'>No blocked users.</p>";
        return;
      }

      container.innerHTML = data.map(
        (u) => `
        <div class="blocked-user-row">
          ${u.name}
          <button class="small-btn unblock-btn" data-id="${u._id}">Unblock</button>
        </div>
      `
      ).join("");

      container.querySelectorAll(".unblock-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await fetch("/api/users/unblock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ userId: btn.dataset.id })
          });
          loadBlockedUsers();
        });
      });
    } catch (err) {
      console.error("Failed to load blocked users", err);
      container.innerHTML = "<p class='muted'>Unable to load blocked users.</p>";
    }
  }
  loadBlockedUsers();

  // --- STRIPE CONNECT ---
  const connectStripeBtn = document.getElementById("connectStripeBtn");
  const stripeStatus = document.getElementById("stripeStatus");
  const cachedRole = String(getCachedUser()?.role || "").toLowerCase();
  const isParalegal = cachedRole === "paralegal";

  const updateStripeStatus = (data = {}) => {
    const connected = !!data.details_submitted && !!data.payouts_enabled;
    const bankName = String(data.bank_name || "").trim();
    const bankLast4 = String(data.bank_last4 || "").trim();
    if (stripeStatus) {
      if (connected) {
        const bankBits = [];
        if (bankName) bankBits.push(bankName);
        if (bankLast4) bankBits.push(`**** ${bankLast4}`);
        stripeStatus.textContent = bankBits.length
          ? `Stripe connected for payouts (${bankBits.join(" ")})`
          : "Stripe connected for payouts.";
      } else {
        stripeStatus.textContent = "Secure payouts powered by Stripe. Payments activate shortly.";
      }
    }
    if (connectStripeBtn) {
      connectStripeBtn.textContent = connected ? "Update Stripe Details" : "Connect Stripe Account →";
      connectStripeBtn.disabled = !connected;
      if (!connected) {
        connectStripeBtn.setAttribute("aria-disabled", "true");
      } else {
        connectStripeBtn.removeAttribute("aria-disabled");
      }
      connectStripeBtn.removeAttribute("title");
    }
  };

  async function refreshStripeStatus() {
    if (!isParalegal) return;
    if (!connectStripeBtn && !stripeStatus) return;
    if (stripeStatus) stripeStatus.textContent = "Checking Stripe status…";
    try {
      const res = await secureFetch("/api/payments/connect/status");
      if (!res.ok) throw new Error("Unable to fetch Stripe status");
      const data = await res.json();
      updateStripeStatus(data);
    } catch (err) {
      if (stripeStatus) stripeStatus.textContent = "Stripe status unavailable.";
      if (connectStripeBtn) {
        connectStripeBtn.disabled = true;
        connectStripeBtn.setAttribute("aria-disabled", "true");
        connectStripeBtn.removeAttribute("title");
      }
    }
  }

  if (connectStripeBtn) {
    connectStripeBtn.addEventListener("click", async () => {
      if (!isParalegal) return;
      if (connectStripeBtn.disabled) return;
      connectStripeBtn.disabled = true;
      connectStripeBtn.textContent = "Connecting…";
      try {
        const createRes = await secureFetch("/api/payments/connect/create-account", { method: "POST" });
        if (!createRes.ok) throw new Error("Unable to prepare Stripe account");
        const { accountId } = await createRes.json();
        const linkRes = await secureFetch("/api/payments/connect/onboard-link", {
          method: "POST",
          body: { accountId },
        });
        if (!linkRes.ok) throw new Error("Unable to start Stripe onboarding");
        const { url } = await linkRes.json();
        if (!url) throw new Error("Invalid Stripe onboarding link");
        window.location.href = url;
      } catch (err) {
        console.error("Failed to start Stripe connect flow", err);
        alert(err?.message || "Unable to connect Stripe right now.");
        refreshStripeStatus();
      }
    });
    refreshStripeStatus();
    if (!isParalegal) {
      connectStripeBtn.disabled = true;
      connectStripeBtn.setAttribute("aria-disabled", "true");
    }
  } else if (!isParalegal && stripeStatus) {
    stripeStatus.textContent = "";
  }
});

const PREFILL_CACHE_KEY = "lpc_edit_profile_prefill";

const paralegalSettingsSection = document.getElementById("paralegalSettings");
const attorneySettingsSection = document.getElementById("attorneySettings");

function resolveSessionUser() {
  if (typeof window.getStoredUser === "function") {
    try {
      return window.getStoredUser();
    } catch {
      return null;
    }
  }
  return null;
}

function ensureUserStatus(user = {}) {
  if (!user) return user;
  if (user.status) return user;
  const snapshot = resolveSessionUser();
  if (snapshot?.status) {
    user.status = snapshot.status;
  }
  return user;
}

function resolveAccountStatus(user = {}) {
  if (user?.status) return String(user.status).toLowerCase();
  const snapshot = resolveSessionUser();
  if (snapshot?.status) return String(snapshot.status).toLowerCase();
  return "";
}

function hasSettingsAccess(user = {}) {
  const role = String(user.role || "").toLowerCase();
  if (role === "admin") return true;
  return resolveAccountStatus(user) === "approved";
}

function showPendingSettingsNotice() {
  const title = document.getElementById("accountSettingsTitle");
  if (title) title.textContent = "Account pending approval";
  const subtitle = document.getElementById("accountSettingsSubtitle");
  if (subtitle) {
    subtitle.textContent = "Once an administrator approves your account, you can edit your LPC profile.";
  }
  const content = document.getElementById("settingsContent");
  if (content) {
    content.innerHTML = `
      <section class="settings-panel active">
        <h2>Awaiting approval</h2>
        <p>Your application is under review. You'll receive an email as soon as an administrator approves your access.</p>
        <p class="muted">Need help? Contact support and reference your signup email.</p>
      </section>
    `;
  }
}

paralegalSettingsSection?.classList.add("hidden");
attorneySettingsSection?.classList.add("hidden");

document.addEventListener("DOMContentLoaded", async () => {
  const prefill = consumeEditPrefillUser();
  const cachedUser = prefill || getCachedUser();
  if (cachedUser) {
    bootstrapProfileSettings(cachedUser);
  }
  await window.checkSession();
  await loadSettings();
});

let settingsState = {
  profileImage: "",
  resumeFile: null,
  pendingResumeKey: "",
  pendingCertificateKey: "",
  pendingWritingSampleKey: "",
  removeResume: false,
  removeCertificate: false,
  removeWritingSample: false,
  experienceDatesTouched: false,
  bio: "",
  education: [],
  awards: [],
  highlightedSkills: [],
  linkedInURL: "",
  notificationPrefs: { email: true, emailMessages: true, emailCase: true, sms: false },
  digestFrequency: "off",
  practiceDescription: ""
};

let currentUser = null;
let statePreferenceSelect = null;
let attorneyPrefsBound = false;
let attorneySaveBound = false;
let paralegalPrefsBound = false;
let paralegalEditBound = false;
let paralegalVisibilityBound = false;
let activeParalegalSection = null;

const FIELD_OF_LAW_OPTIONS = [
  "Administrative Law",
  "Admiralty & Maritime Law",
  "Antitrust Law",
  "Appellate Law",
  "Banking Law",
  "Bankruptcy Law",
  "Business / Corporate Law",
  "Civil Rights Law",
  "Class Action Law",
  "Commercial Law",
  "Communications Law",
  "Construction Law",
  "Consumer Protection Law",
  "Contract Law",
  "Criminal Defense Law",
  "Education Law",
  "Elder Law",
  "Election Law",
  "Employment & Labor Law",
  "Energy Law",
  "Entertainment Law",
  "Environmental Law",
  "Estate Planning & Probate",
  "Family Law",
  "Franchise Law",
  "Government Contracts Law",
  "Health Care Law",
  "Immigration Law",
  "Insurance Law",
  "Intellectual Property (IP) Law",
  "International Law",
  "Land Use & Zoning Law",
  "Litigation",
  "Media Law",
  "Medical Malpractice",
  "Military Law",
  "Municipal Law",
  "Personal Injury Law",
  "Product Liability Law",
  "Real Estate Law",
  "Securities Law",
  "Social Security / Disability Law",
  "Sports Law",
  "Tax Law",
  "Technology Law",
  "Telecommunications Law",
  "Torts",
  "Transportation Law",
  "Trusts & Estates",
  "White Collar Crime",
  "Workers’ Compensation"
];

const LANGUAGE_PROFICIENCY_OPTIONS = [
  { value: "Native", label: "Native" },
  { value: "Fluent", label: "Fluent" },
  { value: "Professional", label: "Professional" },
  { value: "Conversational", label: "Conversational" },
  { value: "Basic", label: "Basic" }
];

const EDUCATION_MONTH_OPTIONS = [
  { value: "", label: "Month (optional)" },
  { value: "Jan", label: "January" },
  { value: "Feb", label: "February" },
  { value: "Mar", label: "March" },
  { value: "Apr", label: "April" },
  { value: "May", label: "May" },
  { value: "Jun", label: "June" },
  { value: "Jul", label: "July" },
  { value: "Aug", label: "August" },
  { value: "Sep", label: "September" },
  { value: "Oct", label: "October" },
  { value: "Nov", label: "November" },
  { value: "Dec", label: "December" }
];

function normalizeStateValue(raw = "") {
  return String(raw || "")
    .trim()
    .toUpperCase();
}

function setStatePreferenceValue(rawValue = "") {
  if (!statePreferenceSelect) return;
  const normalized = normalizeStateValue(rawValue);
  const hasOption = Array.from(statePreferenceSelect.options || []).some(
    (opt) => opt.value === normalized
  );
  statePreferenceSelect.value = normalized && hasOption ? normalized : "";
}

function hydrateStatePreference(user = {}) {
  const candidate = user.state || user.location || "";
  setStatePreferenceValue(candidate);
}

const languagesEditor = document.getElementById("languagesEditor");
const addLanguageBtn = document.getElementById("addLanguageBtn");
const educationEditor = document.getElementById("educationEditor");
const addEducationBtn = document.getElementById("addEducationBtn");

if (addLanguageBtn && languagesEditor) {
  addLanguageBtn.addEventListener("click", () => addLanguageRow());
}
if (addEducationBtn && educationEditor) {
  addEducationBtn.addEventListener("click", () => addEducationRow(normalizeEducationEntry()));
}

function buildInitials(name = "", fallback = "A") {
  const trimmed = String(name || "").trim();
  if (!trimmed) return fallback;
  const letters = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
  return letters || fallback;
}

function getAttorneyInitials(user = {}) {
  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.name || "";
  return buildInitials(fullName, "A");
}

function consumeEditPrefillUser() {
  try {
    const raw = localStorage.getItem(PREFILL_CACHE_KEY);
    if (!raw) return null;
    localStorage.removeItem(PREFILL_CACHE_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function seedSettingsState(user = {}) {
  settingsState.bio = user.bio || "";
  settingsState.education = user.education || [];
  settingsState.awards = user.awards || [];
  settingsState.highlightedSkills = user.highlightedSkills || user.skills || [];
  settingsState.linkedInURL = user.linkedInURL || "";
  settingsState.notificationPrefs = {
    email: true,
    emailMessages: true,
    emailCase: true,
    sms: false,
    ...(user.notificationPrefs || {})
  };
  settingsState.experienceDatesTouched = false;
  settingsState.practiceDescription = user.practiceDescription || user.bio || "";
  const freq = typeof user.digestFrequency === "string" ? user.digestFrequency : "off";
  settingsState.digestFrequency = ["off", "daily", "weekly"].includes(freq) ? freq : "off";
}

function bootstrapProfileSettings(user) {
  enforceUnifiedRoleStyling(user);
  currentUser = user;
  const role = (user.role || "").toLowerCase();
  if (role === "attorney") {
    initAttorneySettings(user);
    return;
  }
  initParalegalSettings(user);
}

function initAttorneySettings(user = {}) {
  seedSettingsState(user);
  showAttorneySettings();
  hydrateAttorneyProfileForm(user);
  bindAttorneyPracticeEditor();
  bindAttorneySaveButton();
  bindAttorneyNotificationToggles();
  syncCluster(user);
}

function initParalegalSettings(user = {}) {
  showParalegalSettings();
  hydrateProfileForm(user);
  seedSettingsState(user);
  initParalegalSectionEditing();
  hydrateParalegalNotificationPrefs(user);
  bindParalegalNotificationToggles();
  hydrateParalegalVisibilityPref(user);
  bindParalegalVisibilityToggle();
  renderLanguageEditor(user.languages || []);
  try { loadCertificate(user); } catch {}
  try { loadResume(user); } catch {}
  try { loadWritingSample(user); } catch {}
  try { loadBio(user); } catch {}
  try { loadEducation(user); } catch {}
  try { loadAwards(user); } catch {}
  try { loadSkills(user); } catch {}
  try { loadLinkedIn(user); } catch {}
  try { loadNotifications(user); } catch {}
  syncCluster(user);
}

function showParalegalSettings() {
  paralegalSettingsSection?.classList.remove("hidden");
  attorneySettingsSection?.classList.add("hidden");
}

function showAttorneySettings() {
  attorneySettingsSection?.classList.remove("hidden");
  paralegalSettingsSection?.classList.add("hidden");
}

function setFullNameInputs(user = {}) {
  const firstName = user.firstName || "";
  const lastName = user.lastName || "";
  const firstNameInput = document.getElementById("firstNameInput");
  const lastNameInput = document.getElementById("lastNameInput");
  const fullNameInput = document.getElementById("fullNameInput");
  if (firstNameInput) firstNameInput.value = firstName;
  if (lastNameInput) lastNameInput.value = lastName;
  if (fullNameInput) {
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    fullNameInput.value = fullName;
  }
}

function syncNamePartsFromFullName() {
  const fullNameInput = document.getElementById("fullNameInput");
  if (!fullNameInput) return;
  const value = fullNameInput.value.trim();
  let firstName = "";
  let lastName = "";
  if (value) {
    const parts = value.split(/\s+/);
    firstName = parts.shift() || "";
    lastName = parts.join(" ");
  }
  const firstNameInput = document.getElementById("firstNameInput");
  const lastNameInput = document.getElementById("lastNameInput");
  if (firstNameInput) firstNameInput.value = firstName;
  if (lastNameInput) lastNameInput.value = lastName;
}

function updateRoleLineFromExperience() {
  const roleLine = document.getElementById("roleLine");
  if (!roleLine) return;
  const yearsInput = document.getElementById("yearsExperienceInput");
  const raw = yearsInput ? Number(yearsInput.value) : null;
  if (raw && !Number.isNaN(raw)) {
    const label = raw === 1 ? "year" : "years";
    roleLine.textContent = `${raw} ${label} experience`;
    return;
  }
  roleLine.textContent = "Experience details pending";
}

const EXPERIENCE_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EXPERIENCE_MONTH_MAP = EXPERIENCE_MONTH_LABELS.reduce((acc, label, index) => {
  const key = label.toLowerCase();
  acc[key] = String(index + 1).padStart(2, "0");
  return acc;
}, {});

function formatExperienceMonth(value) {
  if (!value) return "";
  const [year, month] = String(value).split("-");
  const monthIndex = Number(month) - 1;
  if (!year || Number.isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) return "";
  return `${EXPERIENCE_MONTH_LABELS[monthIndex]} ${year}`;
}

function formatExperienceDateRange(startValue, endValue) {
  const startLabel = formatExperienceMonth(startValue);
  const endLabel = formatExperienceMonth(endValue);
  if (startLabel && endLabel) return `${startLabel} - ${endLabel}`;
  if (startLabel) return `${startLabel} - Present`;
  return endLabel ? `Through ${endLabel}` : "";
}

function parseExperienceYearsLabel(value = "") {
  const cleaned = String(value || "").trim().replace(/[–—]/g, "-");
  if (!cleaned) return { start: "", end: "" };
  const monthToken = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const rangeRe = new RegExp(`^${monthToken}\\s+(\\d{4})\\s*-\\s*${monthToken}\\s+(\\d{4})$`, "i");
  const presentRe = new RegExp(`^${monthToken}\\s+(\\d{4})\\s*-\\s*Present$`, "i");
  const throughRe = new RegExp(`^Through\\s+${monthToken}\\s+(\\d{4})$`, "i");
  let match = cleaned.match(rangeRe);
  if (match) {
    const startMonth = EXPERIENCE_MONTH_MAP[match[1].toLowerCase()] || "";
    const endMonth = EXPERIENCE_MONTH_MAP[match[3].toLowerCase()] || "";
    return {
      start: startMonth ? `${match[2]}-${startMonth}` : "",
      end: endMonth ? `${match[4]}-${endMonth}` : "",
    };
  }
  match = cleaned.match(presentRe);
  if (match) {
    const startMonth = EXPERIENCE_MONTH_MAP[match[1].toLowerCase()] || "";
    return {
      start: startMonth ? `${match[2]}-${startMonth}` : "",
      end: "",
    };
  }
  match = cleaned.match(throughRe);
  if (match) {
    const endMonth = EXPERIENCE_MONTH_MAP[match[1].toLowerCase()] || "";
    return {
      start: "",
      end: endMonth ? `${match[2]}-${endMonth}` : "",
    };
  }
  return { start: "", end: "" };
}

function applyExperienceDatesToTextarea() {
  const experienceInput = document.getElementById("experienceInput");
  const startInput = document.getElementById("experienceStartDate");
  const endInput = document.getElementById("experienceEndDate");
  if (!experienceInput || !startInput || !endInput) return;
  const rangeLabel = formatExperienceDateRange(startInput.value, endInput.value);
  const blocks = experienceInput.value.split(/\n\s*\n/);
  if (!blocks.length) return;
  const firstBlock = blocks[0] || "";
  if (!firstBlock.trim()) return;
  const lines = firstBlock.split("\n");
  const header = lines[0] || "";
  const title = header.split("—")[0].trim();
  if (!title && !rangeLabel) return;
  lines[0] = rangeLabel ? (title ? `${title} — ${rangeLabel}` : rangeLabel) : title;
  blocks[0] = lines.join("\n").trim();
  experienceInput.value = blocks.join("\n\n");
}

function hydrateExperienceDateInputs(entries = []) {
  const startInput = document.getElementById("experienceStartDate");
  const endInput = document.getElementById("experienceEndDate");
  if (!startInput || !endInput) return;
  startInput.value = "";
  endInput.value = "";
  if (!Array.isArray(entries) || !entries.length) return;
  const yearsLabel = entries[0]?.years || "";
  const parsed = parseExperienceYearsLabel(yearsLabel);
  if (parsed.start) startInput.value = parsed.start;
  if (parsed.end) endInput.value = parsed.end;
}

function bindExperienceDateInputs() {
  const startInput = document.getElementById("experienceStartDate");
  const endInput = document.getElementById("experienceEndDate");
  if (!startInput || !endInput) return;
  if (startInput.dataset.bound === "true" || endInput.dataset.bound === "true") return;
  const markTouched = () => {
    settingsState.experienceDatesTouched = true;
    applyExperienceDatesToTextarea();
  };
  startInput.addEventListener("change", markTouched);
  endInput.addEventListener("change", markTouched);
  startInput.dataset.bound = "true";
  endInput.dataset.bound = "true";
}

function setSectionDisplayText(element, value, fallback) {
  if (!element) return;
  const text = String(value || "").trim();
  if (text) {
    element.textContent = text;
    element.classList.remove("is-placeholder");
  } else {
    element.textContent = fallback;
    element.classList.add("is-placeholder");
  }
}

function parseCommaList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatEducationEntry(entry = {}) {
  const pieces = [];
  if (entry.degree) pieces.push(entry.degree);
  if (entry.school) pieces.push(entry.school);
  const startParts = [entry.startMonth, entry.startYear].filter(Boolean).join(" ");
  const endParts = [entry.endMonth, entry.endYear].filter(Boolean).join(" ");
  let range = "";
  if (startParts && endParts) {
    range = `${startParts} - ${endParts}`;
  } else if (startParts) {
    range = startParts;
  } else if (endParts) {
    range = endParts;
  }
  if (range) pieces.push(range);
  return pieces.filter(Boolean).join(" - ");
}

function refreshParalegalSectionDisplays() {
  const root = document.getElementById("paralegalSettings");
  if (!root) return;

  const bioDisplay = document.getElementById("bioDisplay");
  const bioInput = document.getElementById("bioInput");
  setSectionDisplayText(bioDisplay, bioInput?.value || "", "No bio provided.");

  const experienceDisplay = document.getElementById("experienceDisplay");
  const experienceInput = document.getElementById("experienceInput");
  setSectionDisplayText(
    experienceDisplay,
    experienceInput?.value || "",
    "No experience added yet."
  );

  const skillsDisplay = document.getElementById("skillsDisplay");
  const skillsInput = document.getElementById("skillsInput");
  const practiceInput = document.getElementById("practiceAreasInput");
  const skills = parseCommaList(skillsInput?.value || "");
  const focus = parseCommaList(practiceInput?.value || "");
  if (skillsDisplay) {
    const lines = [];
    if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);
    if (focus.length) lines.push(`Focus Areas: ${focus.join(", ")}`);
    setSectionDisplayText(
      skillsDisplay,
      lines.join("\n"),
      "No skills or focus areas listed."
    );
  }

  const educationDisplay = document.getElementById("educationDisplay");
  if (educationDisplay) {
    const entries = collectEducationFromEditor();
    const lines = entries.map((entry) => formatEducationEntry(entry)).filter(Boolean);
    setSectionDisplayText(
      educationDisplay,
      lines.join("\n"),
      "No education entries yet."
    );
  }

  const languagesDisplay = document.getElementById("languagesDisplay");
  if (languagesDisplay) {
    const entries = collectLanguagesFromEditor();
    const lines = entries
      .map((entry) => {
        const name = entry?.name ? entry.name.trim() : "";
        if (!name) return "";
        const proficiency = entry?.proficiency ? entry.proficiency.trim() : "";
        return proficiency ? `${name} (${proficiency})` : name;
      })
      .filter(Boolean);
    setSectionDisplayText(
      languagesDisplay,
      lines.join("\n"),
      "No languages listed."
    );
  }
}

function setActiveParalegalSection(sectionKey) {
  const root = document.getElementById("paralegalSettings");
  if (!root) return;
  const sections = root.querySelectorAll("[data-edit-section]");
  sections.forEach((section) => {
    const isActive = section.dataset.editSection === sectionKey;
    section.classList.toggle("is-editing", isActive);
    const toggle = section.querySelector(".section-edit-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  activeParalegalSection = sectionKey || null;
  refreshParalegalSectionDisplays();
}

function initParalegalSectionEditing() {
  const root = document.getElementById("paralegalSettings");
  if (!root) return;
  const toggles = root.querySelectorAll(".section-edit-toggle");
  if (!toggles.length) return;

  if (!paralegalEditBound) {
    toggles.forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const targetKey = toggle.dataset.editToggle;
        if (!targetKey) return;
        const nextKey = activeParalegalSection === targetKey ? null : targetKey;
        setActiveParalegalSection(nextKey);
      });
    });
    paralegalEditBound = true;
  }

  if (!activeParalegalSection) {
    setActiveParalegalSection(null);
  } else {
    setActiveParalegalSection(activeParalegalSection);
  }
}

function hydrateAttorneyProfileForm(user = {}) {
  const first = document.getElementById("attorneyFirstName");
  if (first) first.value = user.firstName || "";
  const last = document.getElementById("attorneyLastName");
  if (last) last.value = user.lastName || "";
  const emailInput = document.getElementById("attorneyEmail");
  if (emailInput) emailInput.value = user.email || "";
  const linkedInInput = document.getElementById("attorneyLinkedIn");
  if (linkedInInput) linkedInInput.value = user.linkedInURL || "";
  const firmNameInput = document.getElementById("attorneyFirmName");
  if (firmNameInput) firmNameInput.value = user.lawFirm || user.firmName || "";
  const firmWebsiteInput = document.getElementById("attorneyFirmWebsite");
  if (firmWebsiteInput) firmWebsiteInput.value = user.firmWebsite || "";
  const practiceInput = document.getElementById("attorneyPracticeDescription");
  const practiceValue = user.practiceDescription || user.bio || "";
  if (practiceInput) practiceInput.value = practiceValue;
  settingsState.practiceDescription = practiceValue;
  renderAttorneyPracticeAreas(user.practiceAreas || []);
  const publicationsInput = document.getElementById("attorneyPublications");
  if (publicationsInput) publicationsInput.value = Array.isArray(user.publications) ? user.publications.join("\n") : "";
  updateAttorneyPracticeCount();
  hydrateAttorneyNotificationPrefs(user);
  updateAttorneyAvatarPreview(user);
}

function loadAvatarPreview({ preview, frame, initials, url, fallbackText = "" } = {}) {
  if (!preview) {
    if (initials && fallbackText) initials.textContent = fallbackText;
    return;
  }

  if (!url) {
    preview.hidden = true;
    preview.classList.remove("is-loaded");
    preview.removeAttribute("src");
    frame?.classList.remove("has-photo");
    if (initials) {
      initials.style.display = "flex";
      if (fallbackText) initials.textContent = fallbackText;
    }
    return;
  }

  preview.hidden = false;
  preview.classList.remove("is-loaded");
  frame?.classList.remove("has-photo");

  const markLoaded = () => {
    preview.classList.add("is-loaded");
    frame?.classList.add("has-photo");
    if (initials) initials.style.display = "none";
  };

  const handleError = () => {
    preview.hidden = true;
    preview.classList.remove("is-loaded");
    frame?.classList.remove("has-photo");
    if (initials) {
      initials.style.display = "flex";
      if (fallbackText) initials.textContent = fallbackText;
    }
  };

  preview.addEventListener("load", markLoaded, { once: true });
  preview.addEventListener("error", handleError, { once: true });
  preview.src = url;
  if (preview.complete && preview.naturalWidth > 0) {
    markLoaded();
  }
}

function updateAttorneyAvatarPreview(user = {}) {
  const preview = document.getElementById("attorneyAvatarPreview");
  const initials = document.getElementById("attorneyAvatarInitials");
  const frame = document.getElementById("attorneyAvatarFrame");
  const avatarUrl = user.profileImage || user.avatarURL || settingsState.profileImage || "";
  loadAvatarPreview({
    preview,
    frame,
    initials,
    url: avatarUrl,
    fallbackText: getAttorneyInitials(user),
  });
}

function bindAttorneySaveButton() {
  if (attorneySaveBound) return;
  const saveBtn = document.getElementById("saveAttorneyProfile");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", handleAttorneyProfileSave);
  attorneySaveBound = true;
}

function bindAttorneyPracticeEditor() {
  const practiceInput = document.getElementById("attorneyPracticeDescription");
  if (!practiceInput) return;
  practiceInput.addEventListener("input", () => {
    settingsState.practiceDescription = practiceInput.value;
    updateAttorneyPracticeCount();
  });
  updateAttorneyPracticeCount();
}

function renderAttorneyPracticeAreas(selected = []) {
  const panel = document.getElementById("attorneyPracticeDropdown");
  const toggle = document.getElementById("attorneyPracticeDropdownToggle");
  const summary = document.getElementById("attorneyPracticeSummary");
  if (!panel || !toggle || !summary) return;
  panel.innerHTML = "";

  const searchWrap = document.createElement("div");
  searchWrap.className = "dropdown-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search…";
  searchWrap.appendChild(searchInput);
  panel.appendChild(searchWrap);

  const selectedSet = new Set(
    (Array.isArray(selected) ? selected : [selected])
      .filter(Boolean)
      .map((v) => String(v).trim())
  );

  const optionNodes = [];
  const syncAllOptionClasses = () => {
    optionNodes.forEach((opt) => {
      const cb = opt.querySelector("input[type=\"checkbox\"]");
      if (cb) opt.classList.toggle("selected", cb.checked);
    });
  };

  const buildOption = (label, isSelectAll = false) => {
    const option = document.createElement("div");
    option.className = `dropdown-option${isSelectAll ? " dropdown-option--select-all" : ""}`;
    option.role = "option";
    option.tabIndex = 0;
    option.dataset.label = label.toLowerCase();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = label;
    checkbox.checked = isSelectAll ? selectedSet.size === FIELD_OF_LAW_OPTIONS.length : selectedSet.has(label);

    const text = document.createElement("span");
    text.textContent = label;

    option.appendChild(checkbox);
    option.appendChild(text);
    panel.appendChild(option);
    if (!isSelectAll) optionNodes.push(option);

    const findAllCheckboxes = () =>
      optionNodes.map((opt) => opt.querySelector("input[type=\"checkbox\"]")).filter(Boolean);

    const setAll = (checked) => {
      findAllCheckboxes().forEach((cb) => {
        cb.checked = checked;
        const opt = cb.closest(".dropdown-option");
        if (opt) opt.classList.toggle("selected", checked);
      });
      updatePracticeDropdownLabel();
    };

    const toggleCheckbox = () => {
      checkbox.checked = !checkbox.checked;
      if (isSelectAll) {
        setAll(checkbox.checked);
      } else {
        syncSelectedClass();
        updatePracticeDropdownLabel();
        syncAllOptionClasses();
      }
    };

    const syncSelectedClass = () => {
      if (!isSelectAll) {
        option.classList.toggle("selected", checkbox.checked);
      }
    };

    checkbox.addEventListener("change", () => {
      if (isSelectAll) {
        setAll(checkbox.checked);
      } else {
        syncSelectedClass();
        updatePracticeDropdownLabel();
        syncAllOptionClasses();
      }
    });

    option.addEventListener("click", (e) => {
      if (e.target === checkbox) return;
      toggleCheckbox();
    });
    option.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCheckbox();
      }
    });
    syncSelectedClass();
    syncAllOptionClasses();
    return option;
  };

  buildOption("Select all", true);

  FIELD_OF_LAW_OPTIONS.forEach((label) => {
    buildOption(label, false);
  });

  const findOptionCheckbox = (value) => {
    return panel.querySelector(`.dropdown-option input[type="checkbox"][value="${CSS.escape(value)}"]`);
  };

  const updatePracticeDropdownLabel = () => {
    const selected = collectAttorneyPracticeAreas();
    summary.innerHTML = "";
    if (!selected.length) {
      const span = document.createElement("span");
      span.className = "placeholder";
      span.textContent = "Select fields";
      summary.appendChild(span);
      return;
    }
    const chips = selected.slice(0, 3);
    chips.forEach((value) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = value;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.setAttribute("aria-label", `Remove ${value}`);
      remove.textContent = "×";
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        const cb = findOptionCheckbox(value);
        if (cb) {
          cb.checked = false;
          const opt = cb.closest(".dropdown-option");
          if (opt) opt.classList.remove("selected");
          updatePracticeDropdownLabel();
          syncAllOptionClasses();
        }
      });
      chip.appendChild(remove);
      summary.appendChild(chip);
    });
    if (selected.length > chips.length) {
      const more = document.createElement("span");
      more.className = "chip";
      more.textContent = `+${selected.length - chips.length} more`;
      summary.appendChild(more);
    }
  };

  const filterOptions = () => {
    const q = (searchInput.value || "").toLowerCase().trim();
    optionNodes.forEach((opt) => {
      const match = !q || opt.dataset.label.includes(q);
      opt.style.display = match ? "flex" : "none";
    });
  };

  searchInput.addEventListener("input", filterOptions);
  filterOptions();
  updatePracticeDropdownLabel();

  if (!toggle.dataset.bound) {
    toggle.addEventListener("click", () => {
      panel.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!panel.contains(e.target) && !toggle.contains(e.target)) {
        panel.classList.remove("open");
      }
    });
    toggle.dataset.bound = "true";
  }
}

function collectAttorneyPracticeAreas() {
  const panel = document.getElementById("attorneyPracticeDropdown");
  if (!panel) return [];
  return Array.from(panel.querySelectorAll(".dropdown-option input[type=\"checkbox\"]"))
    .filter((input) => input.value !== "Select all" && input.checked)
    .map((input) => input.value)
    .filter(Boolean);
}

function bindAttorneyNotificationToggles() {
  if (attorneyPrefsBound) return;
  [
    { id: "attorneyEmailNotifications", key: "email" },
    { id: "attorneyMessageAlerts", key: "emailMessages" },
    { id: "attorneyCaseUpdates", key: "emailCase" }
  ].forEach(({ id, key }) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("change", async () => {
      const checked = input.checked;
      try {
        await saveNotificationPref(key, checked);
        settingsState.notificationPrefs[key] = checked;
        showToast("Notification preference updated", "ok");
      } catch (err) {
        console.error("Unable to update notification preference", err);
        input.checked = !checked;
        showToast("Unable to update preference right now.", "err");
      }
    });
  });
  attorneyPrefsBound = true;
}

function bindParalegalNotificationToggles() {
  if (paralegalPrefsBound) return;
  [
    { id: "paralegalMessageAlerts", key: "emailMessages" },
    { id: "paralegalCaseUpdates", key: "emailCase" }
  ].forEach(({ id, key }) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("change", async () => {
      const checked = input.checked;
      try {
        await saveNotificationPref(key, checked);
        settingsState.notificationPrefs[key] = checked;
        showToast("Notification preference updated", "ok");
      } catch (err) {
        console.error("Unable to update notification preference", err);
        input.checked = !checked;
        showToast("Unable to update preference right now.", "err");
      }
    });
  });
  paralegalPrefsBound = true;
}

function bindParalegalVisibilityToggle() {
  if (paralegalVisibilityBound) return;
  const input = document.getElementById("paralegalHideProfile");
  if (!input) return;
  input.addEventListener("change", async () => {
    const checked = input.checked;
    try {
      const prefs = await saveProfileVisibility(checked);
      if (currentUser) {
        currentUser.preferences = {
          ...(currentUser.preferences || {}),
          hideProfile: prefs?.hideProfile ?? checked
        };
        persistSession({ user: currentUser });
        window.updateSessionUser?.(currentUser);
      }
      showToast(checked ? "Profile hidden" : "Profile visible", "ok");
    } catch (err) {
      console.error("Unable to update profile visibility", err);
      input.checked = !checked;
      showToast("Unable to update profile visibility right now.", "err");
    }
  });
  paralegalVisibilityBound = true;
}

function hydrateAttorneyNotificationPrefs(user = {}) {
  const prefs = user.notificationPrefs || {};
  const emailToggle = document.getElementById("attorneyEmailNotifications");
  if (emailToggle) emailToggle.checked = prefs.email !== false;
  const messageToggle = document.getElementById("attorneyMessageAlerts");
  if (messageToggle) messageToggle.checked = prefs.emailMessages !== false;
  const caseToggle = document.getElementById("attorneyCaseUpdates");
  if (caseToggle) caseToggle.checked = prefs.emailCase !== false;
  settingsState.notificationPrefs = {
    ...settingsState.notificationPrefs,
    email: prefs.email !== false,
    emailMessages: prefs.emailMessages !== false,
    emailCase: prefs.emailCase !== false
  };
}

function hydrateParalegalNotificationPrefs(user = {}) {
  const prefs = user.notificationPrefs || {};
  const messageToggle = document.getElementById("paralegalMessageAlerts");
  if (messageToggle) messageToggle.checked = prefs.emailMessages !== false;
  const caseToggle = document.getElementById("paralegalCaseUpdates");
  if (caseToggle) caseToggle.checked = prefs.emailCase !== false;
  settingsState.notificationPrefs = {
    ...settingsState.notificationPrefs,
    email: prefs.email !== false,
    emailMessages: prefs.emailMessages !== false,
    emailCase: prefs.emailCase !== false
  };
}

function hydrateParalegalVisibilityPref(user = {}) {
  const toggle = document.getElementById("paralegalHideProfile");
  if (!toggle) return;
  const hidden = user?.preferences && typeof user.preferences === "object"
    ? user.preferences.hideProfile
    : false;
  toggle.checked = !!hidden;
}

function collectAttorneyPayload() {
  const first = document.getElementById("attorneyFirstName")?.value.trim() || "";
  const last = document.getElementById("attorneyLastName")?.value.trim() || "";
  const email = document.getElementById("attorneyEmail")?.value.trim() || "";
  const linkedIn = document.getElementById("attorneyLinkedIn")?.value.trim() || "";
  const lawFirm = document.getElementById("attorneyFirmName")?.value.trim() || "";
  const firmWebsite = document.getElementById("attorneyFirmWebsite")?.value.trim() || "";
  const practiceDescription = document.getElementById("attorneyPracticeDescription")?.value.trim() || "";
  const emailToggle = document.getElementById("attorneyEmailNotifications");
  const practiceAreas = collectAttorneyPracticeAreas();
  const publicationsRaw = document.getElementById("attorneyPublications")?.value || "";
  const publications = publicationsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const payload = {
    firstName: first,
    lastName: last,
    email,
    linkedInURL: linkedIn || null,
    lawFirm,
    practiceAreas,
    publications,
    practiceDescription,
    bio: practiceDescription,
    notificationPrefs: {
      email: emailToggle ? emailToggle.checked : settingsState.notificationPrefs.email !== false
    }
  };
  settingsState.practiceDescription = practiceDescription;
  if (firmWebsite) {
    payload.firmWebsite = firmWebsite;
  }
  if (settingsState.profileImage) {
    payload.profileImage = settingsState.profileImage;
  }
  return payload;
}

function updateAttorneyPracticeCount() {
  const practiceInput = document.getElementById("attorneyPracticeDescription");
  const counter = document.getElementById("attorneyPracticeCount");
  if (!practiceInput || !counter) return;
  const length = practiceInput.value?.length || 0;
  counter.textContent = `${length} / 4000 characters`;
}
async function handleAttorneyProfileSave() {
  const saveBtn =
    document.getElementById("saveAttorneyProfile") || document.getElementById("attorneyProfileSaveBtn");
  const originalLabel = saveBtn?.textContent || "";
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
  }
  try {
    const payload = collectAttorneyPayload();
    const res = await secureFetch("/api/users/me", {
      method: "PATCH",
      body: payload
    });
    const updatedUser = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(updatedUser?.error || "Unable to save profile");
    }
    currentUser = mergeSessionPreferences(updatedUser);
    persistSession({ user: currentUser });
    window.updateSessionUser?.(currentUser);
    settingsState.profileImage = updatedUser.profileImage || settingsState.profileImage;
    settingsState.practiceDescription = updatedUser.practiceDescription || updatedUser.bio || "";
    renderAttorneyPracticeAreas(updatedUser.practiceAreas || []);
    settingsState.notificationPrefs = {
      ...settingsState.notificationPrefs,
      email: updatedUser.notificationPrefs?.email !== false,
      emailMessages: updatedUser.notificationPrefs?.emailMessages !== false,
      emailCase: updatedUser.notificationPrefs?.emailCase !== false
    };
    hydrateAttorneyProfileForm(updatedUser);
    showToast("Profile updated!", "ok");
  } catch (err) {
    console.error("Failed to save attorney profile", err);
    showToast("Unable to save profile right now.", "err");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel || "Save profile";
    }
  }
}

async function saveNotificationPref(key, value) {
  const res = await secureFetch("/api/users/me/notification-prefs", {
    method: "PATCH",
    body: { [key]: !!value }
  });
  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    throw new Error(errPayload?.error || "Preference update failed");
  }
}

async function saveProfileVisibility(value) {
  const res = await secureFetch("/api/account/preferences", {
    method: "POST",
    body: { hideProfile: !!value }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Preference update failed");
  }
  return data?.preferences || {};
}

function normalizeLanguageEntry(entry) {
  if (!entry) return { name: "", proficiency: "" };
  if (typeof entry === "string") return { name: entry, proficiency: "" };
  return {
    name: entry.name || entry.language || "",
    proficiency: entry.proficiency || entry.level || ""
  };
}

function normalizeEducationEntry(entry) {
  if (!entry) {
    return {
      school: "",
      startMonth: "",
      startYear: "",
      endMonth: "",
      endYear: "",
      degree: ""
    };
  }
  if (typeof entry === "string") {
    return {
      school: entry,
      startMonth: "",
      startYear: "",
      endMonth: "",
      endYear: "",
      degree: ""
    };
  }
  return {
    school: entry.school || entry.institution || "",
    startMonth: entry.startMonth || entry.beginMonth || "",
    startYear: entry.startYear || entry.beginYear || "",
    endMonth: entry.endMonth || entry.finishMonth || "",
    endYear: entry.endYear || entry.finishYear || "",
    degree: entry.degree || ""
  };
}

function addLanguageRow(entry = {}) {
  if (!languagesEditor) return;
  const row = document.createElement("div");
  row.className = "language-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Language (e.g., Spanish)";
  nameInput.className = "language-name";
  nameInput.value = entry.name || entry.language || "";
  row.appendChild(nameInput);

  const select = document.createElement("select");
  select.className = "language-level";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select proficiency";
  select.appendChild(placeholder);
  LANGUAGE_PROFICIENCY_OPTIONS.forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    select.appendChild(option);
  });
  select.value = entry.proficiency || entry.level || "";
  row.appendChild(select);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-language";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => row.remove());
  row.appendChild(removeBtn);

  languagesEditor.appendChild(row);
}

function createEducationMonthSelect(value, placeholderLabel) {
  const select = document.createElement("select");
  select.className = "education-month";
  EDUCATION_MONTH_OPTIONS.forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label || placeholderLabel;
    select.appendChild(option);
  });
  select.value = value || "";
  return select;
}

function addEducationRow(entry = {}) {
  if (!educationEditor) return;
  const row = document.createElement("div");
  row.className = "education-row";
  row.dataset.degree = entry.degree || "";

  const schoolInput = document.createElement("input");
  schoolInput.type = "text";
  schoolInput.placeholder = "School";
  schoolInput.className = "education-school";
  schoolInput.value = entry.school || "";
  row.appendChild(schoolInput);

  const startMonthSelect = createEducationMonthSelect(entry.startMonth, "Begin month (optional)");
  startMonthSelect.classList.add("education-start-month");
  row.appendChild(startMonthSelect);

  const startYearInput = document.createElement("input");
  startYearInput.type = "number";
  startYearInput.placeholder = "Begin year";
  startYearInput.className = "education-year education-start-year";
  startYearInput.value = entry.startYear || "";
  row.appendChild(startYearInput);

  const endMonthSelect = createEducationMonthSelect(entry.endMonth, "End month (optional)");
  endMonthSelect.classList.add("education-end-month");
  row.appendChild(endMonthSelect);

  const endYearInput = document.createElement("input");
  endYearInput.type = "number";
  endYearInput.placeholder = "End year";
  endYearInput.className = "education-year education-end-year";
  endYearInput.value = entry.endYear || "";
  row.appendChild(endYearInput);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-education";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => row.remove());
  row.appendChild(removeBtn);

  educationEditor.appendChild(row);
}

function renderLanguageEditor(languages = []) {
  if (!languagesEditor) return;
  languagesEditor.innerHTML = "";
  const entries =
    Array.isArray(languages) && languages.length
      ? languages.map((entry) => normalizeLanguageEntry(entry))
      : [normalizeLanguageEntry()];
  entries.forEach((entry) => addLanguageRow(entry));
}

function renderEducationEditor(education = []) {
  if (!educationEditor) return;
  educationEditor.innerHTML = "";
  const entries =
    Array.isArray(education) && education.length
      ? education.map((entry) => normalizeEducationEntry(entry))
      : [normalizeEducationEntry()];
  entries.forEach((entry) => addEducationRow(entry));
  settingsState.education = entries;
}

function collectLanguagesFromEditor() {
  if (!languagesEditor) return [];
  return Array.from(languagesEditor.querySelectorAll(".language-row"))
    .map((row) => {
      const name = row.querySelector(".language-name")?.value.trim();
      const proficiency = row.querySelector(".language-level")?.value || "";
      if (!name) return null;
      return { name, proficiency };
    })
    .filter(Boolean);
}

function collectEducationFromEditor() {
  if (!educationEditor) return settingsState.education || [];
  return Array.from(educationEditor.querySelectorAll(".education-row"))
    .map((row) => {
      const school = row.querySelector(".education-school")?.value.trim() || "";
      const startMonth = row.querySelector(".education-start-month")?.value || "";
      const startYear = row.querySelector(".education-start-year")?.value || "";
      const endMonth = row.querySelector(".education-end-month")?.value || "";
      const endYear = row.querySelector(".education-end-year")?.value || "";
      const degree = row.dataset.degree || "";
      if (!school && !startYear && !endYear && !startMonth && !endMonth) {
        return null;
      }
      const entry = {
        school,
        startMonth,
        startYear,
        endMonth,
        endYear
      };
      if (degree) entry.degree = degree;
      return entry;
    })
    .filter(Boolean);
}

function getCachedUser() {
  if (typeof window.getStoredUser === "function") {
    const stored = window.getStoredUser();
    if (stored) return stored;
  }
  try {
    const raw = localStorage.getItem("lpc_user");
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function mergeSessionPreferences(user = {}) {
  if (!user || typeof user !== "object") return user;
  const prefs = user.preferences && typeof user.preferences === "object" ? user.preferences : {};
  const sessionTheme = typeof window.getThemePreference === "function" ? window.getThemePreference() : null;
  const sessionFontSize = typeof window.getFontSizePreference === "function" ? window.getFontSizePreference() : null;
  const theme = prefs.theme || sessionTheme;
  const fontSize = prefs.fontSize || sessionFontSize;
  if (!theme && !fontSize) return user;
  return {
    ...user,
    preferences: {
      ...prefs,
      ...(theme ? { theme } : {}),
      ...(fontSize ? { fontSize } : {})
    }
  };
}

function showToast(message, type = "info") {
  if (!message) return;
  if (window.toastUtils?.show) {
    window.toastUtils.show(message, { type });
  } else {
    const banner = document.getElementById("toastBanner");
    if (banner) {
      banner.textContent = message;
      banner.dataset.toastType = type;
      banner.classList.add("show");
      setTimeout(() => banner.classList.remove("show"), 2500);
    } else {
      console.log(`[toast:${type}] ${message}`);
    }
  }
}

function showForceVisible() {
  document.querySelectorAll("[data-force-visible]").forEach((el) => {
    el.style.display = "block";
    el.hidden = false;
  });
}

function applyUnifiedRoleStyling(user = {}) {
  showForceVisible();
  const role = (user.role || "").trim().toLowerCase();
  const isParalegal = role === "paralegal";
  const eyebrow = document.querySelector(".unified-header .eyebrow");
  const title = document.querySelector(".unified-header h1");

  if (eyebrow) eyebrow.textContent = "Account";
  if (title) {
    title.textContent = role === "paralegal" ? "Account Settings" : "Account Settings";
  }
  document.body.classList.toggle("paralegal-flat", isParalegal);
  document.body.classList.toggle("attorney-classic", role === "attorney");
  if (eyebrow) {
    eyebrow.style.display = role === "attorney" ? "none" : "";
  }

  document.querySelectorAll("[data-paralegal-only]").forEach((el) => {
    if (el.dataset.forceVisible !== undefined) {
      el.style.display = "";
      el.hidden = false;
      return;
    }
    el.style.display = isParalegal ? "" : "none";
  });

  document.querySelectorAll("[data-attorney-only]").forEach((el) => {
    el.style.display = role === "attorney" ? "" : "none";
  });

  if (role === "attorney") {
    showAttorneySettings();
  } else {
    showParalegalSettings();
  }
}

function enforceUnifiedRoleStyling(user = {}) {
  applyUnifiedRoleStyling(user);
  requestAnimationFrame(() => applyUnifiedRoleStyling(user));
}

function applyAvatar(user) {
  if (!user?.profileImage) return;
  const cacheBusted = `${user.profileImage}${user.profileImage.includes("?") ? "&" : "?"}t=${Date.now()}`;

  const header = document.getElementById("headerAvatar");
  if (header) header.src = cacheBusted;

  const preview = document.getElementById("avatarPreview");
  const attorneyPreview = document.getElementById("attorneyAvatarPreview");
  loadAvatarPreview({
    preview,
    frame: document.getElementById("avatarFrame"),
    initials: document.getElementById("avatarInitials"),
    url: cacheBusted,
    fallbackText: document.getElementById("avatarInitials")?.textContent || "",
  });
  loadAvatarPreview({
    preview: attorneyPreview,
    frame: document.getElementById("attorneyAvatarFrame"),
    initials: document.getElementById("attorneyAvatarInitials"),
    url: cacheBusted,
    fallbackText: document.getElementById("attorneyAvatarInitials")?.textContent || "",
  });

  const cluster = document.getElementById("clusterAvatar");
  if (cluster) cluster.src = cacheBusted;

  document.querySelectorAll(".nav-profile-photo, .globalProfileImage").forEach((el) => {
    el.src = cacheBusted;
  });

}

function renderFallback(sectionId, title) {
  const section = document.getElementById(sectionId);
  if (section) section.innerHTML = `<h3>${title}</h3><p>Unable to load.</p>`;
}

function syncCluster(user = {}) {
  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.name || "Paralegal";
  const roleLabel = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : "Paralegal";
  const avatar = user.profileImage || user.avatarURL || settingsState.profileImage || "https://via.placeholder.com/64x64.png?text=PL";
  const avatarEl = document.getElementById("clusterAvatar");
  if (avatarEl) avatarEl.src = avatar;
  document.querySelectorAll(".nav-profile-photo").forEach((el) => {
    el.src = avatar;
  });
  const nameEl = document.getElementById("clusterName");
  if (nameEl) nameEl.textContent = fullName;
  const roleEl = document.getElementById("clusterRole");
  if (roleEl) roleEl.textContent = roleLabel;
  window.hydrateParalegalCluster?.(user);
}

async function loadSettings() {
  showForceVisible();
  let user = {};
  try {
    const res = await secureFetch("/api/users/me");
    user = await res.json();
    if ((!user?.role || !user.role.trim()) && typeof window.refreshSession === "function") {
      try {
        const session = await window.refreshSession();
        const sessionUser = session?.user || session;
        if (sessionUser?.role) {
          user.role = sessionUser.role;
        }
      } catch (_) {}
    }
    ensureUserStatus(user);
    currentUser = mergeSessionPreferences(user);
    window.currentUser = currentUser;
    persistSession({ user: currentUser });
    hydrateStatePreference(user);

    if (!hasSettingsAccess(user)) {
      showPendingSettingsNotice();
      return;
    }
    const titleEl = document.getElementById("accountSettingsTitle");
    const subtitleEl = document.getElementById("accountSettingsSubtitle");

    if (currentUser?.role === "paralegal") {
      if (titleEl) titleEl.textContent = "Paralegal Account Settings";
      if (subtitleEl) subtitleEl.textContent = "Keep your LPC profile up-to-date.";
    }

    if (currentUser?.role === "attorney") {
      if (titleEl) titleEl.textContent = "Account Settings";
      if (subtitleEl) subtitleEl.textContent = "Keep your LPC profile accurate, stay secure, and control how we notify you.";
    }
    enforceUnifiedRoleStyling(user);
    applyAvatar(user);
    bootstrapProfileSettings(user);

    const role = (currentUser?.role || "").toLowerCase();

    if (role === "attorney") {
      // Attorney: ONLY attorney UI should show.
      showAttorneySettings();
      return; // IMPORTANT → stops all paralegal hydration
    }

    // Paralegal: ONLY paralegal UI should show.
    showParalegalSettings();
    hydrateProfileForm(user);

    setFullNameInputs(user);
    const emailInput = document.getElementById("emailInput");
    if (emailInput) emailInput.value = user.email || "";
    const phoneInput = document.getElementById("phoneInput");
    if (phoneInput) phoneInput.value = user.phoneNumber || user.phone || "";
    const lawFirmInput = document.getElementById("lawFirmInput");
    if (lawFirmInput) lawFirmInput.value = user.lawFirm || "";
    if (user.role === "paralegal") {
      const linkedInInput = document.getElementById("linkedInInput");
      if (linkedInInput) linkedInInput.value = user.linkedInURL || "";
      const yearsExperienceInput = document.getElementById("yearsExperienceInput");
      if (yearsExperienceInput) yearsExperienceInput.value = user.yearsExperience ?? "";
      const practiceAreasInput = document.getElementById("practiceAreasInput");
      if (practiceAreasInput) practiceAreasInput.value = (user.practiceAreas || []).join(", ");
      const skillsInput = document.getElementById("skillsInput");
      const skillValues = user.highlightedSkills || user.skills || [];
      if (skillsInput) skillsInput.value = skillValues.join(", ");
      const experienceInput = document.getElementById("experienceInput");
      if (experienceInput) {
        experienceInput.value = (user.experience || [])
          .map((e) => `${e.title || ""} — ${e.years || ""}\n${e.description || ""}`.trim())
          .filter(Boolean)
          .join("\n\n");
        const experiences = Array.isArray(user.experience) ? user.experience : [];
        hydrateExperienceDateInputs(experiences);
        bindExperienceDateInputs();
      }
      renderEducationEditor(user.education || []);
      renderLanguageEditor(user.languages || []);
      updateRoleLineFromExperience();
      refreshParalegalSectionDisplays();
    }
  } catch (err) {
    renderFallback("settingsCertificate", "Certificate");
    renderFallback("settingsResume", "Résumé");
    renderFallback("settingsWritingSample", "Writing Sample");
    renderFallback("settingsBio", "Bio");
    renderFallback("settingsEducation", "Education");
    renderFallback("settingsAwards", "Awards");
    renderFallback("settingsSkills", "Skills");
    renderFallback("settingsLinkedIn", "LinkedIn");
    renderFallback("settingsNotifications", "Notifications");
    return;
  }

  // Store existing data
  seedSettingsState(user);
  settingsState.profileImage = user.profileImage || user.avatarURL || "";

  // Build UI
  try { await loadCertificate(user); } catch { renderFallback("settingsCertificate", "Certificate"); }
  try { await loadResume(user); } catch { renderFallback("settingsResume", "Résumé"); }
  try { await loadWritingSample(user); } catch { renderFallback("settingsWritingSample", "Writing Sample"); }
  try { await loadBio(user); } catch { renderFallback("settingsBio", "Bio"); }
  try { await loadEducation(user); } catch { renderFallback("settingsEducation", "Education"); }
  try { await loadAwards(user); } catch { renderFallback("settingsAwards", "Awards"); }
  try { await loadSkills(user); } catch { renderFallback("settingsSkills", "Skills"); }
  try { await loadLinkedIn(user); } catch { renderFallback("settingsLinkedIn", "LinkedIn"); }
  try { await loadNotifications(user); } catch { renderFallback("settingsNotifications", "Notifications"); }
  syncCluster(user);

}

function hydrateProfileForm(user = {}) {
  setFullNameInputs(user);
  const emailInput = document.getElementById("emailInput");
  if (emailInput) emailInput.value = user.email || "";
  const phoneInput = document.getElementById("phoneInput");
  if (phoneInput) phoneInput.value = user.phoneNumber || "";
  const lawFirmInput = document.getElementById("lawFirmInput");
  if (lawFirmInput) lawFirmInput.value = user.lawFirm || "";
  const bioInput = document.getElementById("bioInput");
  if (bioInput) bioInput.value = user.bio || "";
  const role = (user.role || "").toLowerCase();
  if (role === "paralegal") {
    const linkedInInput = document.getElementById("linkedInInput");
    if (linkedInInput) linkedInInput.value = user.linkedInURL || "";
    const yearsExperienceInput = document.getElementById("yearsExperienceInput");
    if (yearsExperienceInput) yearsExperienceInput.value = user.yearsExperience ?? "";
    const practiceAreasInput = document.getElementById("practiceAreasInput");
    const practiceValues = Array.isArray(user.practiceAreas) ? user.practiceAreas : [];
    if (practiceAreasInput) practiceAreasInput.value = practiceValues.join(", ");
    const skillsInput = document.getElementById("skillsInput");
    const skillsSource =
      Array.isArray(user.highlightedSkills) && user.highlightedSkills.length
        ? user.highlightedSkills
        : Array.isArray(user.skills)
        ? user.skills
        : [];
    if (skillsInput) skillsInput.value = skillsSource.join(", ");
    const experienceInput = document.getElementById("experienceInput");
    if (experienceInput) {
      const experiences = Array.isArray(user.experience) ? user.experience : [];
      experienceInput.value = experiences
        .map((entry = {}) => {
          const header = [entry.title, entry.years].filter(Boolean).join(" — ");
          const details = entry.description ? `\n${entry.description}` : "";
          return `${header}${details}`.trim();
        })
        .filter(Boolean)
        .join("\n\n");
      hydrateExperienceDateInputs(experiences);
      bindExperienceDateInputs();
    }
    renderEducationEditor(user.education || []);
    renderLanguageEditor(user.languages || []);
    updateRoleLineFromExperience();
    refreshParalegalSectionDisplays();
  }
}


// ================= RESUME =================

function loadCertificate(user) {
  const section = document.getElementById("settingsCertificate");
  if (!section) return;
  settingsState.removeCertificate = false;
  const hasCertificate = Boolean(user.certificateURL || settingsState.pendingCertificateKey);
  const statusText = hasCertificate ? "Certificate on file" : "No file uploaded";
  section.innerHTML = `
    <div class="paralegal-doc-row">
      <div class="paralegal-doc-meta">
        <h3>Upload Certificate (PDF)</h3>
        <p>Share verified certifications or licenses with attorneys.</p>
        <p class="doc-status" id="certificateStatus">${statusText}</p>
      </div>
      <div class="paralegal-doc-actions">
        <div class="file-input-row">
          <label for="certificateInput" class="file-trigger">Choose File</label>
          <span id="certificateFileName" class="file-name">${statusText}</span>
        </div>
        <input id="certificateInput" type="file" accept="application/pdf" class="file-input-hidden">
        <button id="uploadCertificateBtn" class="file-trigger upload-action-btn" type="button">Upload Certificate</button>
        <button id="removeCertificateBtn" class="file-trigger remove-action-btn" type="button" ${hasCertificate ? "" : "disabled"}>Remove</button>
      </div>
    </div>
  `;

  const certInput = document.getElementById("certificateInput");
  const certFileName = document.getElementById("certificateFileName");
  if (certInput) {
    certInput.addEventListener("change", (event) => {
      const file = event.target.files?.[0] || null;
      if (certFileName) {
        certFileName.textContent = file ? file.name : "No file chosen";
      }
    });
  }

  document.getElementById("uploadCertificateBtn")?.addEventListener("click", async () => {
    const file = certInput?.files?.[0];
    if (!file) {
      alert("Please choose a PDF certificate first.");
      return;
    }
    if (file.type !== "application/pdf") {
      alert("Certificate must be a PDF.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert("Certificate must be 10 MB or smaller.");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);

    const res = await secureFetch("/api/uploads/paralegal-certificate", {
      method: "POST",
      body: fd
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(payload.msg || "Certificate upload failed.");
      return;
    }

    alert("Certificate uploaded! Click Save to publish the update.");

    const certHidden = document.getElementById("certificateKeyInput") || (() => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.id = "certificateKeyInput";
      input.name = "certificateKey";
      section.appendChild(input);
      return input;
    })();
    const latestKey = payload.url || payload.key || "";
    certHidden.value = latestKey;
    settingsState.pendingCertificateKey = latestKey;
    settingsState.removeCertificate = false;
    if (certInput) certInput.value = "";
    if (certFileName) certFileName.textContent = "Uploaded!";
    const status = document.getElementById("certificateStatus");
    if (status) status.textContent = "Certificate on file";
    const removeBtn = document.getElementById("removeCertificateBtn");
    if (removeBtn) removeBtn.disabled = false;
  });

  document.getElementById("removeCertificateBtn")?.addEventListener("click", () => {
    const confirmed = window.confirm("Remove certificate? This will update after you save.");
    if (!confirmed) return;
    settingsState.pendingCertificateKey = "";
    settingsState.removeCertificate = true;
    const certHidden = document.getElementById("certificateKeyInput");
    if (certHidden) certHidden.value = "";
    if (certInput) certInput.value = "";
    if (certFileName) certFileName.textContent = "No file chosen";
    const status = document.getElementById("certificateStatus");
    if (status) status.textContent = "Removed. Click Save to publish the update.";
    const removeBtn = document.getElementById("removeCertificateBtn");
    if (removeBtn) removeBtn.disabled = true;
  });
}

function loadResume(user) {
  const section = document.getElementById("settingsResume");
  if (!section) return;
  settingsState.removeResume = false;
  const hasResume = Boolean(user.resumeURL || settingsState.pendingResumeKey);
  const statusText = hasResume ? "Résumé on file" : "No file uploaded";
  section.innerHTML = `
    <div class="paralegal-doc-row">
      <div class="paralegal-doc-meta">
        <h3>Upload Résumé (PDF)</h3>
        <p>Upload a polished résumé so attorneys can verify your expertise.</p>
        <p class="doc-status" id="resumeStatus">${statusText}</p>
      </div>
      <div class="paralegal-doc-actions">
        <div class="file-input-row">
          <label for="resumeInput" class="file-trigger">Choose File</label>
          <span id="resumeFileName" class="file-name">${statusText}</span>
        </div>
        <input id="resumeInput" type="file" accept="application/pdf" class="file-input-hidden">
        <button id="uploadResumeBtn" class="file-trigger upload-action-btn" type="button">Upload Résumé</button>
        <button id="removeResumeBtn" class="file-trigger remove-action-btn" type="button" ${hasResume ? "" : "disabled"}>Remove</button>
      </div>
    </div>
  `;

  const resumeInput = document.getElementById("resumeInput");
  const resumeFileName = document.getElementById("resumeFileName");
  if (resumeInput) {
    resumeInput.addEventListener("change", (event) => {
      const file = event.target.files?.[0] || null;
      if (resumeFileName) {
        resumeFileName.textContent = file ? file.name : "No file chosen";
      }
    });
  }

  document.getElementById("uploadResumeBtn")?.addEventListener("click", async () => {
    const file = resumeInput?.files?.[0];
    if (!file) {
      alert("Please choose a PDF résumé first.");
      return;
    }

  const fd = new FormData();
  fd.append("file", file);

  const res = await secureFetch("/api/uploads/paralegal-resume", {
    method: "POST",
    body: fd
  });

    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(payload.msg || "Resume upload failed.");
      return;
    }

    alert("Résumé uploaded! Click Save to publish the update.");

    // Populate hidden field so Save captures the new key
    const resumeHidden = document.getElementById("resumeKeyInput") || (() => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.id = "resumeKeyInput";
      input.name = "resumeKey";
      section.appendChild(input);
      return input;
    })();
    const latestKey = payload.url || payload.key || "";
    resumeHidden.value = latestKey;
    settingsState.pendingResumeKey = latestKey;
    settingsState.removeResume = false;
    if (resumeInput) resumeInput.value = "";
    if (resumeFileName) resumeFileName.textContent = "Uploaded!";
    const status = document.getElementById("resumeStatus");
    if (status) status.textContent = "Résumé on file";
    const removeBtn = document.getElementById("removeResumeBtn");
    if (removeBtn) removeBtn.disabled = false;
  });

  document.getElementById("removeResumeBtn")?.addEventListener("click", () => {
    const confirmed = window.confirm("Remove résumé? This will update after you save.");
    if (!confirmed) return;
    settingsState.pendingResumeKey = "";
    settingsState.removeResume = true;
    const resumeHidden = document.getElementById("resumeKeyInput");
    if (resumeHidden) resumeHidden.value = "";
    if (resumeInput) resumeInput.value = "";
    if (resumeFileName) resumeFileName.textContent = "No file chosen";
    const status = document.getElementById("resumeStatus");
    if (status) status.textContent = "Removed. Click Save to publish the update.";
    const removeBtn = document.getElementById("removeResumeBtn");
    if (removeBtn) removeBtn.disabled = true;
  });
}

function loadWritingSample(user) {
  const section = document.getElementById("settingsWritingSample");
  if (!section) return;
  settingsState.removeWritingSample = false;
  const hasSample = Boolean(user.writingSampleURL || settingsState.pendingWritingSampleKey);
  const statusText = hasSample ? "Writing sample on file" : "No file uploaded";
  section.innerHTML = `
    <div class="paralegal-doc-row">
      <div class="paralegal-doc-meta">
        <h3>Upload Writing Sample (PDF)</h3>
        <p>Attach a representative writing sample for attorneys to review.</p>
        <p class="doc-status" id="writingSampleStatus">${statusText}</p>
      </div>
      <div class="paralegal-doc-actions">
        <div class="file-input-row">
          <label for="writingSampleInput" class="file-trigger">Choose File</label>
          <span id="writingSampleFileName" class="file-name">${statusText}</span>
        </div>
        <input id="writingSampleInput" type="file" accept="application/pdf" class="file-input-hidden">
        <button id="uploadWritingSampleBtn" class="file-trigger upload-action-btn" type="button">Upload Writing Sample</button>
        <button id="removeWritingSampleBtn" class="file-trigger remove-action-btn" type="button" ${hasSample ? "" : "disabled"}>Remove</button>
      </div>
    </div>
  `;

  const sampleInput = document.getElementById("writingSampleInput");
  const sampleFileName = document.getElementById("writingSampleFileName");
  if (sampleInput) {
    sampleInput.addEventListener("change", (event) => {
      const file = event.target.files?.[0] || null;
      if (sampleFileName) {
        sampleFileName.textContent = file ? file.name : "No file chosen";
      }
    });
  }

  document.getElementById("uploadWritingSampleBtn")?.addEventListener("click", async () => {
    const file = sampleInput?.files?.[0];
    if (!file) {
      alert("Please choose a PDF writing sample first.");
      return;
    }
    if (file.type !== "application/pdf") {
      alert("Writing sample must be a PDF.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert("Writing sample must be 10 MB or smaller.");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);

    const res = await secureFetch("/api/uploads/paralegal-writing-sample", {
      method: "POST",
      body: fd
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(payload.msg || "Writing sample upload failed.");
      return;
    }

    alert("Writing sample uploaded! Click Save to publish the update.");

    const hidden = document.getElementById("writingSampleKeyInput") || (() => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.id = "writingSampleKeyInput";
      input.name = "writingSampleKey";
      section.appendChild(input);
      return input;
    })();
    const latestKey = payload.url || payload.key || "";
    hidden.value = latestKey;
    settingsState.pendingWritingSampleKey = latestKey;
    settingsState.removeWritingSample = false;
    if (sampleInput) sampleInput.value = "";
    if (sampleFileName) sampleFileName.textContent = "Uploaded!";
    const status = document.getElementById("writingSampleStatus");
    if (status) status.textContent = "Writing sample on file";
    const removeBtn = document.getElementById("removeWritingSampleBtn");
    if (removeBtn) removeBtn.disabled = false;
  });

  document.getElementById("removeWritingSampleBtn")?.addEventListener("click", () => {
    const confirmed = window.confirm("Remove writing sample? This will update after you save.");
    if (!confirmed) return;
    settingsState.pendingWritingSampleKey = "";
    settingsState.removeWritingSample = true;
    const sampleHidden = document.getElementById("writingSampleKeyInput");
    if (sampleHidden) sampleHidden.value = "";
    if (sampleInput) sampleInput.value = "";
    if (sampleFileName) sampleFileName.textContent = "No file chosen";
    const status = document.getElementById("writingSampleStatus");
    if (status) status.textContent = "Removed. Click Save to publish the update.";
    const removeBtn = document.getElementById("removeWritingSampleBtn");
    if (removeBtn) removeBtn.disabled = true;
  });
}



// ================= BIO =================

function loadBio(user) {
  const section = document.getElementById("settingsBio");
  if (!section) return;
  section.innerHTML = `
    <h3>Bio</h3>
    <textarea id="bioInput" style="width:100%;">${user.bio || ""}</textarea>
  `;
  const bioInput = document.getElementById("bioInput");
  if (bioInput) {
    bioInput.addEventListener("input", (evt) => {
      settingsState.bio = evt.target.value;
    });
  }
}


// ================= EDUCATION =================

function loadEducation(user) {
  const section = document.getElementById("settingsEducation");
  if (!section) return;
  const items = user.education || [];

  section.innerHTML = `
    <h3>Education</h3>
    <div id="eduList"></div>
    <button id="addEduBtn">Add Education Entry</button>
  `;

  const list = document.getElementById("eduList");
  if (!list) return;

  function renderEdu() {
    list.innerHTML = "";
    settingsState.education.forEach((ed, idx) => {
      list.innerHTML += `
        <div class="edu-entry">
          <input placeholder="Degree" value="${ed.degree || ""}" data-idx="${idx}" data-field="degree">
          <input placeholder="Institution" value="${ed.institution || ""}" data-idx="${idx}" data-field="institution">
          <input placeholder="Year" value="${ed.year || ""}" data-idx="${idx}" data-field="year">
          <input placeholder="Certification" value="${ed.certification || ""}" data-idx="${idx}" data-field="certification">
        </div>
      `;
    });

    list.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", (evt) => {
        const idx = evt.target.dataset.idx;
        const field = evt.target.dataset.field;
        settingsState.education[idx][field] = evt.target.value;
      });
    });
  }

  settingsState.education = items;
  renderEdu();

  const addBtn = document.getElementById("addEduBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      settingsState.education.push({ degree:"", institution:"", year:"", certification:"" });
      renderEdu();
    });
  }
}


// ================= AWARDS =================

function loadAwards(user) {
  const section = document.getElementById("settingsAwards");
  if (!section) return;
  const items = user.awards || [];

  section.innerHTML = `
    <h3>Awards</h3>
    <div id="awardList"></div>
    <button id="addAwardBtn">Add Award</button>
  `;

  const list = document.getElementById("awardList");
  if (!list) return;

  function renderAwards() {
    list.innerHTML = "";
    settingsState.awards.forEach((a, idx) => {
      list.innerHTML += `
        <div class="award-entry">
          <input placeholder="Award title" value="${a}" data-idx="${idx}">
        </div>
      `;
    });

    list.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", (evt) => {
        const idx = evt.target.dataset.idx;
        settingsState.awards[idx] = evt.target.value;
      });
    });
  }

  settingsState.awards = items;
  renderAwards();

  const addBtn = document.getElementById("addAwardBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      settingsState.awards.push("");
      renderAwards();
    });
  }
}


// ================= SKILLS =================

function loadSkills(user) {
  const section = document.getElementById("settingsSkills");
  if (!section) return;
  const items = user.highlightedSkills || user.skills || [];

  section.innerHTML = `
    <h3>Highlighted Skills (Top 3–5)</h3>
    <div id="skillsList"></div>
    <button id="addSkillBtn">Add Skill</button>
  `;

  const list = document.getElementById("skillsList");
  if (!list) return;

  function renderSkills() {
    list.innerHTML = "";
    settingsState.highlightedSkills.forEach((s, idx) => {
      list.innerHTML += `
        <div class="skill-entry">
          <input placeholder="Skill" value="${s}" data-idx="${idx}">
        </div>
      `;
    });

    list.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", (evt) => {
        const idx = evt.target.dataset.idx;
        settingsState.highlightedSkills[idx] = evt.target.value;
      });
    });
  }

  settingsState.highlightedSkills = items;
  renderSkills();

  const addBtn = document.getElementById("addSkillBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (settingsState.highlightedSkills.length < 5) {
        settingsState.highlightedSkills.push("");
        renderSkills();
      }
    });
  }
}


// ================= LINKEDIN =================

function loadLinkedIn(user) {
  const section = document.getElementById("settingsLinkedIn");
  if (!section) return;
  section.innerHTML = `
    <h3>LinkedIn Profile</h3>
    <input id="linkedInURLInput" type="url" style="width:100%;" value="${user.linkedInURL || ""}">
  `;
  const linkedInInput = document.getElementById("linkedInURLInput");
  if (linkedInInput) {
    linkedInInput.addEventListener("input", (evt) => {
      settingsState.linkedInURL = evt.target.value;
    });
  }
}


// ================= NOTIFICATION PREFS =================

function loadNotifications(user) {
  const section = document.getElementById("settingsNotifications");
  if (!section) return;
  const prefs = {
    email: true,
    sms: false,
    ...(user.notificationPrefs || {})
  };

  section.innerHTML = `
    <h3>Notification Preferences</h3>
    <label class="pref-row">
      <input type="checkbox" id="prefEmailNotify"> Email notifications
    </label><br>
    <label class="pref-row">
      <input type="checkbox" id="prefSmsNotify"> SMS notifications
      <small style="margin-left: 0.5rem; opacity: 0.75;">Requires a verified phone number.</small>
    </label>
    <div class="pref-row" style="flex-wrap: wrap; gap: 10px;">
      <div style="flex: 1; min-width: 220px;">
        <strong>Digest emails</strong>
        <p style="margin:4px 0 0; font-size: 0.9rem; color: var(--muted);">Receive a summary of messages, invites, and updates.</p>
      </div>
      <select id="digestFrequencySelect" style="padding:6px 10px;border-radius:12px;border:1px solid var(--line);font-size:0.95rem;min-width:160px;">
        <option value="off">Off</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
      </select>
    </div>
  `;

  const emailToggle = document.getElementById("prefEmailNotify");
  const smsToggle = document.getElementById("prefSmsNotify");
  const digestSelect = document.getElementById("digestFrequencySelect");

  if (emailToggle) {
    emailToggle.checked = prefs.email !== false;
    emailToggle.addEventListener("change", (e) => {
      settingsState.notificationPrefs.email = e.target.checked;
    });
  }
  if (smsToggle) {
    smsToggle.checked = !!prefs.sms;
    smsToggle.addEventListener("change", (e) => {
      settingsState.notificationPrefs.sms = e.target.checked;
    });
  }
  if (digestSelect) {
    digestSelect.value = settingsState.digestFrequency;
    digestSelect.addEventListener("change", (e) => {
      const value = e.target.value;
      settingsState.digestFrequency = ["off", "daily", "weekly"].includes(value) ? value : "off";
    });
  }

  settingsState.notificationPrefs = { ...prefs };
}


// ================= SAVE SETTINGS =================

async function saveSettings() {
  syncNamePartsFromFullName();
  const firstNameInput = document.getElementById("firstNameInput");
  const lastNameInput = document.getElementById("lastNameInput");
  const emailInput = document.getElementById("emailInput");
  const phoneInput = document.getElementById("phoneInput");
  const lawFirmInput = document.getElementById("lawFirmInput");
  const bioInput = document.getElementById("bioInput");
  const linkedInInput = document.getElementById("linkedInInput");
  const yearsExperienceInput = document.getElementById("yearsExperienceInput");
  const practiceAreasInput = document.getElementById("practiceAreasInput");
  const skillsInput = document.getElementById("skillsInput");
  const experienceInput = document.getElementById("experienceInput");
  const resumeKeyInput = document.getElementById("resumeKeyInput");
  const certificateKeyInput = document.getElementById("certificateKeyInput");
  const writingSampleKeyInput = document.getElementById("writingSampleKeyInput");
  const body = {
    firstName: firstNameInput ? firstNameInput.value.trim() : "",
    lastName: lastNameInput ? lastNameInput.value.trim() : "",
    email: emailInput?.value || "",
    phoneNumber: phoneInput?.value || "",
    lawFirm: lawFirmInput?.value || "",
    bio: bioInput?.value ?? settingsState.bio,
    education: settingsState.education,
    awards: settingsState.awards,
    highlightedSkills: settingsState.highlightedSkills,
    linkedInURL: settingsState.linkedInURL,
    notificationPrefs: settingsState.notificationPrefs,
    digestFrequency: settingsState.digestFrequency
  };

  body.linkedInURL = linkedInInput?.value.trim() || null;
  body.yearsExperience = yearsExperienceInput ? Number(yearsExperienceInput.value) || null : null;
  body.practiceAreas = practiceAreasInput
    ? practiceAreasInput.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  body.highlightedSkills = skillsInput
    ? skillsInput.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  body.skills = body.highlightedSkills;
  body.experience = experienceInput
    ? experienceInput.value
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
          const [header, ...rest] = block.split("\n");
          const [titlePart = "", yearsPart = ""] = (header || "").split("—").map((s) => s.trim());
          const description = rest.join("\n").trim();
          return {
            title: titlePart || header || "",
            years: yearsPart,
            description
          };
        })
        .filter((entry) => entry.title || entry.description)
        .filter((entry) => entry.title || entry.description)
    : [];
  const experienceStartInput = document.getElementById("experienceStartDate");
  const experienceEndInput = document.getElementById("experienceEndDate");
  if (settingsState.experienceDatesTouched && Array.isArray(body.experience) && body.experience.length) {
    const rangeLabel = formatExperienceDateRange(
      experienceStartInput?.value || "",
      experienceEndInput?.value || ""
    );
    body.experience[0].years = rangeLabel || "";
  }
  body.education = collectEducationFromEditor();
  const resumeKeyValue = resumeKeyInput?.value || settingsState.pendingResumeKey || "";
  if (settingsState.removeResume) {
    body.resumeURL = "";
  } else if (resumeKeyValue) {
    body.resumeURL = resumeKeyValue;
  }
  const certificateKeyValue = certificateKeyInput?.value || settingsState.pendingCertificateKey || "";
  if (settingsState.removeCertificate) {
    body.certificateURL = "";
  } else if (certificateKeyValue) {
    body.certificateURL = certificateKeyValue;
  }
  const writingSampleInput = document.getElementById("writingSampleKeyInput");
  const writingSampleValue = writingSampleInput?.value || settingsState.pendingWritingSampleKey || "";
  if (settingsState.removeWritingSample) {
    body.writingSampleURL = "";
  } else if (writingSampleValue) {
    body.writingSampleURL = writingSampleValue;
  }

  if (languagesEditor) {
    body.languages = collectLanguagesFromEditor();
  }

  const res = await secureFetch("/api/users/me", {
    method: "PATCH",
    body
  });

  if (!res.ok) {
    showToast("Could not save settings.", "err");
    return;
  }

  const updatedUser = await secureFetch("/api/users/me").then((r) => r.json());
  const mergedUser = mergeSessionPreferences(updatedUser);
  localStorage.setItem("lpc_user", JSON.stringify(mergedUser));
  currentUser = mergedUser;
  settingsState.bio = updatedUser.bio || "";
  settingsState.education = updatedUser.education || [];
  settingsState.awards = updatedUser.awards || [];
  settingsState.highlightedSkills = updatedUser.highlightedSkills || updatedUser.skills || [];
  settingsState.linkedInURL = updatedUser.linkedInURL || "";
  settingsState.notificationPrefs = {
    email: true,
    sms: false,
    ...(updatedUser.notificationPrefs || {})
  };
  const newFreq = typeof updatedUser.digestFrequency === "string" ? updatedUser.digestFrequency : "off";
  settingsState.digestFrequency = ["off", "daily", "weekly"].includes(newFreq) ? newFreq : "off";
  settingsState.profileImage = updatedUser.profileImage || settingsState.profileImage;
  settingsState.pendingResumeKey = "";
  settingsState.pendingCertificateKey = "";
  settingsState.pendingWritingSampleKey = "";
  settingsState.experienceDatesTouched = false;
  settingsState.removeResume = false;
  settingsState.removeCertificate = false;
  settingsState.removeWritingSample = false;
  if (resumeKeyInput) resumeKeyInput.value = "";
  if (certificateKeyInput) certificateKeyInput.value = "";
  if (writingSampleKeyInput) writingSampleKeyInput.value = "";
  if (writingSampleInput) writingSampleInput.value = "";

  persistSession({ user: mergedUser });
  window.updateSessionUser?.(mergedUser);

  applyAvatar?.(updatedUser);
  hydrateProfileForm(updatedUser);
  renderLanguageEditor(updatedUser.languages || []);
  bootstrapProfileSettings(updatedUser);
  syncCluster?.(updatedUser);
  window.hydrateParalegalCluster?.(updatedUser);
  try {
    window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: updatedUser }));
  } catch (_) {}
  try {
    localStorage.removeItem(PREFILL_CACHE_KEY);
  } catch {}
  showToast("Settings saved!", "ok");
}

// -----------------------------
// PROFILE PHOTO UPLOAD FLOW
// -----------------------------

const avatarUploadConfigs = [
  { frameId: "avatarFrame", inputId: "avatarInput", previewId: "avatarPreview", initialsId: "avatarInitials" },
  {
    frameId: "attorneyAvatarFrame",
    inputId: "attorneyAvatarInput",
    previewId: "attorneyAvatarPreview",
    initialsId: "attorneyAvatarInitials"
  }
];

function initAvatarUploaders() {
  avatarUploadConfigs.forEach((config) => {
    const frame = document.getElementById(config.frameId);
    const input = document.getElementById(config.inputId);
    if (!frame || !input) return;

    frame.style.cursor = "pointer";
    frame.addEventListener("click", () => input.click());
    frame.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        input.click();
      }
    });

    input.addEventListener("change", () => handleAvatarUpload(config));
  });
}

async function handleAvatarUpload(config) {
  const input = document.getElementById(config.inputId);
  const preview = document.getElementById(config.previewId);
  const initials = document.getElementById(config.initialsId);
  const frame = document.getElementById(config.frameId);
  if (!input || !frame || !preview) return;

  const file = input.files?.[0];
  if (!file) return;

  const localUrl = URL.createObjectURL(file);
  updateAvatarPreview(preview, frame, initials, localUrl);

  try {
    const uploadedUrl = await uploadProfilePhotoFile(file);
    if (uploadedUrl) {
      const updatedUser = mergeSessionPreferences({ ...(currentUser || {}), profileImage: uploadedUrl });
      currentUser = updatedUser;
      settingsState.profileImage = uploadedUrl;
      persistSession({ user: updatedUser });
      window.updateSessionUser?.(updatedUser);
      applyAvatar(updatedUser);
      showToast("Profile photo updated!", "ok");
    }
  } catch (err) {
    console.error("Unable to upload profile photo", err);
    showToast("Unable to upload photo. Please try again.", "err");
  } finally {
    URL.revokeObjectURL(localUrl);
    input.value = "";
  }
}

function updateAvatarPreview(preview, frame, initials, src) {
  if (preview) {
    preview.src = src;
    preview.hidden = false;
    preview.style.objectPosition = "center center";
  }
  if (frame) frame.classList.add("has-photo");
  if (initials) initials.style.display = "none";
}

async function uploadProfilePhotoFile(file) {
  const formData = new FormData();
  formData.append("file", file, file.name || "avatar.png");

  const res = await fetch("/api/uploads/profile-photo", {
    method: "POST",
    body: formData,
    credentials: "include"
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Upload failed");
  }
  return payload?.url || payload?.profileImage || payload?.avatarURL || "";
}

document.addEventListener("DOMContentLoaded", initAvatarUploaders);

function saveProfile() {
  saveSettings();
}

const profileSaveBtn = document.getElementById("profileSaveBtn");
if (profileSaveBtn) {
  profileSaveBtn.addEventListener("click", saveProfile);
}

const profileForm = document.getElementById("profileForm");
if (profileForm) {
  profileForm.addEventListener("submit", (e) => e.preventDefault());
}

function handleProfilePreviewNavigation() {
  const cached = currentUser || getCachedUser() || {};

  const role = (cached.role || "").toLowerCase();
  const id = cached._id || cached.id;

  if (!id) {
    alert("Missing user id.");
    return;
  }

  // Favor the attorney view when the attorney settings panel is visible or when the role is missing.
  const isAttorneyPanelVisible = !document.getElementById("attorneySettings")?.classList.contains("hidden");
  if (role === "attorney" || (!role && isAttorneyPanelVisible)) {
    window.location.href = `profile-attorney.html?id=${id}`;
  } else {
    window.location.href = `profile-paralegal.html?paralegalId=${id}`;
  }
}

[document.getElementById("previewProfileBtn"), document.getElementById("attorneyPreviewProfileBtn")]
  .filter(Boolean)
  .forEach((btn) => btn.addEventListener("click", handleProfilePreviewNavigation));
window.logoutUser = function (e) {
  if (e) e.preventDefault();

  // Clear client auth
  localStorage.clear();
  sessionStorage.clear();

  // Backend logout (if applicable)
  fetch("/api/auth/logout", { credentials: "include" })
    .finally(() => {
      window.location.href = "/login.html";
    });
};
