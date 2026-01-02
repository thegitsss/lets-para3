import { secureFetch, persistSession } from "./auth.js";

document.addEventListener("DOMContentLoaded", () => {
  const navItems = {
    navProfile: "profileSection",
    navSecurity: "securitySection",
    navPreferences: "preferencesSection",
    navDelete: "deleteSection"
  };

  Object.keys(navItems).forEach(navId => {
    const btn = document.getElementById(navId);
    const sectionId = navItems[navId];

    if (!btn) return;

    btn.addEventListener("click", () => {
      document.querySelectorAll(".settings-item").forEach(el => el.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".settings-section").forEach(sec => sec.classList.remove("active"));
      const section = document.getElementById(sectionId);
      section?.classList.add("active");
    });
  });

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
  statePreferenceSelect = document.getElementById("statePreference");

  const updateThemePreview = (value) => {
    if (!themePreviewButtons.length) return;
    themePreviewButtons.forEach((btn) => {
      const isActive = btn.dataset.themePreview === value;
      btn.setAttribute("aria-checked", isActive ? "true" : "false");
      btn.classList.toggle("is-active", isActive);
    });
  };

  async function persistThemePreference(themeValue) {
    try {
      const payload = {
        theme: themeValue,
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
    persistThemePreference(value);
  };

  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      applyThemeSelection(themeSelect.value);
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

  async function loadPreferences() {
    try {
      const res = await fetch("/api/account/preferences", {
        credentials: "include"
      });
      if (!res.ok) return;
      const prefs = await res.json();
      if (emailToggle) emailToggle.checked = !!prefs.email;
      if (themeSelect) {
        const resolvedTheme =
          prefs.theme ||
          (typeof window.getThemePreference === "function"
            ? window.getThemePreference()
            : "mountain");
        themeSelect.value = resolvedTheme;
        updateThemePreview(resolvedTheme);
        if (typeof window.applyThemePreference === "function") {
          window.applyThemePreference(resolvedTheme);
        }
      } else if (prefs.theme) {
        applyThemeSelection(prefs.theme);
      }
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
        currentUser.location = state || "";
        currentUser.state = state || "";
        persistSession({ user: currentUser });
      }
      hydrateStatePreference(currentUser || { state });
      showToast("Preferences saved", "ok");
    });
  }

  const deleteBtn = document.getElementById("deleteAccountBtn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Are you sure? This action cannot be undone.")) return;

      const res = await fetch("/api/account/delete", {
        method: "DELETE",
        credentials: "include"
      });

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
  if (connectStripeBtn) {
    connectStripeBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/stripe/connect", {
          method: "POST",
          credentials: "include"
        });
        const data = await res.json();
        if (data?.url) {
          window.location.href = data.url;
        }
      } catch (err) {
        console.error("Failed to start Stripe connect flow", err);
        alert("Unable to connect Stripe right now.");
      }
    });
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

if (addLanguageBtn && languagesEditor) {
  addLanguageBtn.addEventListener("click", () => addLanguageRow());
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
  hydrateParalegalNotificationPrefs(user);
  bindParalegalNotificationToggles();
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

function updateAttorneyAvatarPreview(user = {}) {
  const preview = document.getElementById("attorneyAvatarPreview");
  const initials = document.getElementById("attorneyAvatarInitials");
  const frame = document.getElementById("attorneyAvatarFrame");
  const avatarUrl = user.profileImage || user.avatarURL || settingsState.profileImage || "";
  if (preview) {
    if (avatarUrl) {
      preview.src = avatarUrl;
      preview.hidden = false;
      frame?.classList.add("has-photo");
      if (initials) initials.style.display = "none";
    } else {
      preview.hidden = true;
      frame?.classList.remove("has-photo");
      if (initials) {
        initials.style.display = "flex";
        initials.textContent = getAttorneyInitials(user);
      }
    }
  } else if (initials) {
    initials.textContent = getAttorneyInitials(user);
  }
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
    currentUser = updatedUser;
    persistSession({ user: updatedUser });
    window.updateSessionUser?.(updatedUser);
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

function normalizeLanguageEntry(entry) {
  if (!entry) return { name: "", proficiency: "" };
  if (typeof entry === "string") return { name: entry, proficiency: "" };
  return {
    name: entry.name || entry.language || "",
    proficiency: entry.proficiency || entry.level || ""
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

function renderLanguageEditor(languages = []) {
  if (!languagesEditor) return;
  languagesEditor.innerHTML = "";
  const entries =
    Array.isArray(languages) && languages.length
      ? languages.map((entry) => normalizeLanguageEntry(entry))
      : [normalizeLanguageEntry()];
  entries.forEach((entry) => addLanguageRow(entry));
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
  const eyebrow = document.querySelector(".unified-header .eyebrow");
  const title = document.querySelector(".unified-header h1");

  if (eyebrow) eyebrow.textContent = "Account";
  if (title) {
    title.textContent = role === "paralegal" ? "Account Settings" : "Account Settings";
  }

  document.querySelectorAll("[data-paralegal-only]").forEach((el) => {
    if (el.dataset.forceVisible !== undefined) {
      el.style.display = "";
      el.hidden = false;
      return;
    }
    el.style.display = role === "paralegal" ? "" : "none";
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
  if (preview) {
    preview.src = cacheBusted;
    preview.style.objectPosition = "center center";
  }
  const attorneyPreview = document.getElementById("attorneyAvatarPreview");
  if (attorneyPreview) {
    attorneyPreview.src = cacheBusted;
    attorneyPreview.hidden = false;
  }

  const cluster = document.getElementById("clusterAvatar");
  if (cluster) cluster.src = cacheBusted;

  document.querySelectorAll(".nav-profile-photo, .globalProfileImage").forEach((el) => {
    el.src = cacheBusted;
  });

  const frame = document.getElementById("avatarFrame");
  const initials = document.getElementById("avatarInitials");
  if (frame) frame.classList.add("has-photo");
  if (initials) initials.style.display = "none";
  const attorneyFrame = document.getElementById("attorneyAvatarFrame");
  const attorneyInitials = document.getElementById("attorneyAvatarInitials");
  if (attorneyFrame) attorneyFrame.classList.add("has-photo");
  if (attorneyInitials) attorneyInitials.style.display = "none";
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
    currentUser = user;
    window.currentUser = user;
    persistSession({ user });
    hydrateStatePreference(user);

    if (!hasSettingsAccess(user)) {
      showPendingSettingsNotice();
      return;
    }
    const titleEl = document.getElementById("accountSettingsTitle");
    const subtitleEl = document.getElementById("accountSettingsSubtitle");

    if (currentUser?.role === "paralegal") {
      if (titleEl) titleEl.textContent = "Paralegal Account Settings";
      if (subtitleEl) subtitleEl.textContent = "Keep your LPC profile accurate, stay secure, and manage your public paralegal profile.";
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

    const firstNameInput = document.getElementById("firstNameInput");
    if (firstNameInput) firstNameInput.value = user.firstName || "";
    const lastNameInput = document.getElementById("lastNameInput");
    if (lastNameInput) lastNameInput.value = user.lastName || "";
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
      }
      const educationInput = document.getElementById("educationInput");
      if (educationInput) {
        educationInput.value = (user.education || [])
          .map((e) => `${e.degree || ""} — ${e.school || ""}`.trim())
          .filter(Boolean)
          .join("\n");
      }
      renderLanguageEditor(user.languages || []);
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
  const firstNameInput = document.getElementById("firstNameInput");
  if (firstNameInput) firstNameInput.value = user.firstName || "";
  const lastNameInput = document.getElementById("lastNameInput");
  if (lastNameInput) lastNameInput.value = user.lastName || "";
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
    }
    const educationInput = document.getElementById("educationInput");
    if (educationInput) {
      const schools = Array.isArray(user.education) ? user.education : [];
      educationInput.value = schools
        .map((entry = {}) => {
          const line = [entry.degree, entry.school].filter(Boolean).join(" — ");
          return line || "";
        })
        .filter(Boolean)
        .join("\n");
    }
    renderLanguageEditor(user.languages || []);
  }
}


// ================= RESUME =================

function loadCertificate(user) {
  const section = document.getElementById("settingsCertificate");
  if (!section) return;
  section.innerHTML = `
    <div class="upload-card">
      <h3>Upload Certificate (PDF)</h3>
      <p>Share verified certifications or licenses with attorneys.</p>
      <div class="file-input-row">
        <label for="certificateInput" class="file-trigger">Choose File</label>
        <span id="certificateFileName" class="file-name">${user.certificateURL ? "Certificate on file" : "No file chosen"}</span>
      </div>
      <input id="certificateInput" type="file" accept="application/pdf" class="file-input-hidden">
      <button id="uploadCertificateBtn" class="file-trigger upload-action-btn" type="button">Upload Certificate</button>
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
    if (certInput) certInput.value = "";
    if (certFileName) certFileName.textContent = "Uploaded!";
  });
}

function loadResume(user) {
  const section = document.getElementById("settingsResume");
  if (!section) return;
  section.innerHTML = `
    <div class="upload-card">
      <h3>Upload Résumé (PDF)</h3>
      <p>Upload a polished résumé so attorneys can verify your expertise.</p>
      <div class="file-input-row">
        <label for="resumeInput" class="file-trigger">Choose File</label>
        <span id="resumeFileName" class="file-name">${user.resumeURL ? "Résumé on file" : "No file chosen"}</span>
      </div>
      <input id="resumeInput" type="file" accept="application/pdf" class="file-input-hidden">
      <button id="uploadResumeBtn" class="file-trigger upload-action-btn" type="button">Upload Résumé</button>
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
    if (resumeInput) resumeInput.value = "";
    if (resumeFileName) resumeFileName.textContent = "Uploaded!";
  });
}

function loadWritingSample(user) {
  const section = document.getElementById("settingsWritingSample");
  if (!section) return;
  section.innerHTML = `
    <div class="upload-card">
      <h3>Upload Writing Sample (PDF)</h3>
      <p>Attach a representative writing sample for attorneys to review.</p>
      <div class="file-input-row">
        <label for="writingSampleInput" class="file-trigger">Choose File</label>
        <span id="writingSampleFileName" class="file-name">${user.writingSampleURL ? "Writing sample on file" : "No file chosen"}</span>
      </div>
      <input id="writingSampleInput" type="file" accept="application/pdf" class="file-input-hidden">
      <button id="uploadWritingSampleBtn" class="file-trigger upload-action-btn" type="button">Upload Writing Sample</button>
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
    if (sampleInput) sampleInput.value = "";
    if (sampleFileName) sampleFileName.textContent = "Uploaded!";
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
  const educationInput = document.getElementById("educationInput");
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
  body.education = educationInput
    ? educationInput.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [degreePart = "", schoolPart = ""] = line.split("—").map((s) => s.trim());
          return { degree: degreePart || line, school: schoolPart };
        })
        .filter((entry) => entry.degree || entry.school)
    : [];
  const resumeKeyValue = resumeKeyInput?.value || settingsState.pendingResumeKey || "";
  if (resumeKeyValue) {
    body.resumeURL = resumeKeyValue;
  }
  const certificateKeyValue = certificateKeyInput?.value || settingsState.pendingCertificateKey || "";
  if (certificateKeyValue) {
    body.certificateURL = certificateKeyValue;
  }
  const writingSampleInput = document.getElementById("writingSampleKeyInput");
  const writingSampleValue = writingSampleInput?.value || settingsState.pendingWritingSampleKey || "";
  if (writingSampleValue) {
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
  localStorage.setItem("lpc_user", JSON.stringify(updatedUser));
  currentUser = updatedUser;
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
  if (resumeKeyInput) resumeKeyInput.value = "";
  if (certificateKeyInput) certificateKeyInput.value = "";
  if (writingSampleKeyInput) writingSampleKeyInput.value = "";
  if (writingSampleInput) writingSampleInput.value = "";

  persistSession({ user: updatedUser });
  window.updateSessionUser?.(updatedUser);

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
      const updatedUser = { ...(currentUser || {}), profileImage: uploadedUrl };
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
