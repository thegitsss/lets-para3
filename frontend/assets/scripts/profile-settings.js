import { secureFetch, persistSession, getStoredSession } from "./auth.js";
import { STRIPE_GATE_MESSAGE } from "./utils/stripe-connect.js";

const DEFAULT_AVATAR_DATA = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220' viewBox='0 0 220 220'>
    <rect width='220' height='220' rx='110' fill='#f1f5f9'/>
    <circle cx='110' cy='90' r='46' fill='#cbd5e1'/>
    <path d='M40 188c10-40 45-68 70-68s60 28 70 68' fill='none' stroke='#cbd5e1' stroke-width='18' stroke-linecap='round'/>
  </svg>`
)}`;

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

  const helpBtn = document.getElementById("navHelp");
  if (helpBtn) {
    helpBtn.addEventListener("click", () => {
      window.location.href = "help.html";
    });
  }

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
      const currentPass = document.getElementById("currentPassword")?.value || "";
      const newPass = document.getElementById("newPassword")?.value || "";
      const confirm = document.getElementById("confirmPassword")?.value || "";

      if (!currentPass) {
        alert("Enter your current password.");
        return;
      }
      if (newPass !== confirm) {
        alert("Passwords do not match!");
        return;
      }
      if (String(newPass).length < 8) {
        alert("Password must be at least 8 characters.");
        return;
      }

      const res = await secureFetch("/api/account/update-password", {
        method: "POST",
        body: { currentPassword: currentPass, newPassword: newPass }
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data?.error || "Unable to update password.");
        return;
      }
      alert("Password updated!");
      const currentInput = document.getElementById("currentPassword");
      const newInput = document.getElementById("newPassword");
      const confirmInput = document.getElementById("confirmPassword");
      if (currentInput) currentInput.value = "";
      if (newInput) newInput.value = "";
      if (confirmInput) confirmInput.value = "";
    });
  }

  document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const inputId = btn.getAttribute("data-toggle-password");
      if (!inputId) return;
      const input = document.getElementById(inputId);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
    });
  });

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
  const bestForList = document.getElementById("bestForDisplay");
  if (bestForList) {
    bestForList.addEventListener("keydown", handleBestForListKeydown);
    bestForList.addEventListener("input", handleBestForListInput);
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

  const deleteButtons = document.querySelectorAll("[data-delete-account]");
  if (deleteButtons.length) {
    deleteButtons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        const confirmed = window.confirm(
          "Delete your account and all data? This is permanent and cannot be undone."
        );
        if (!confirmed) return;

        const res = await secureFetch("/api/account/delete", { method: "DELETE" });

        if (res.ok) {
          window.location.href = "/goodbye.html";
        } else {
          alert("Error deleting account.");
        }
      });
    });
  }

  // --- TWO-STEP VERIFICATION ---
  const twoFactorToggles = Array.from(document.querySelectorAll(".two-factor-toggle"));
  let twoFactorUpdating = false;

  const twoFactorLabels = {
    authenticator: "Authenticator app",
    sms: "Phone number",
    email: "Email",
  };

  const setTwoFactorUI = ({ enabled = false, method = "email" } = {}) => {
    const availableMethods = new Set(
      twoFactorToggles.filter((toggle) => !toggle.disabled).map((toggle) => toggle.dataset.twoFactorMethod)
    );
    const normalizedMethod = availableMethods.has(method) ? method : "email";
    const activeMethod = enabled ? normalizedMethod : "";
    twoFactorToggles.forEach((toggle) => {
      toggle.checked = enabled && toggle.dataset.twoFactorMethod === activeMethod;
    });
  };

  async function loadTwoFactorStatus() {
    if (!twoFactorToggles.length) return;
    try {
      const res = await secureFetch("/api/account/2fa");
      if (!res.ok) throw new Error("Unable to load 2FA status");
      const data = await res.json();
      if (data?.disabled) {
        twoFactorToggles.forEach((toggle) => {
          toggle.checked = false;
          toggle.disabled = true;
          toggle.setAttribute("aria-disabled", "true");
        });
        return;
      }
      setTwoFactorUI({
        enabled: !!data?.enabled,
        method: data?.method || "email",
      });
    } catch (err) {
    }
  }

  const updateTwoFactor = async (enabled, method) => {
    const res = await secureFetch("/api/account/2fa-toggle", {
      method: "POST",
      body: { enabled, method },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload?.error || "Unable to update 2-step verification.");
    }
  };

  if (twoFactorToggles.length) {
    twoFactorToggles.forEach((toggle) => {
      toggle.addEventListener("change", async () => {
        if (twoFactorUpdating) return;
        const method = toggle.dataset.twoFactorMethod || "email";
        const enabled = toggle.checked;
        if (enabled) {
          twoFactorToggles.forEach((other) => {
            if (other !== toggle) other.checked = false;
          });
        }
        const anyEnabled = twoFactorToggles.some((item) => item.checked);
        const activeToggle = twoFactorToggles.find((item) => item.checked);
        const activeMethod = activeToggle?.dataset.twoFactorMethod || method;
        const finalEnabled = enabled ? true : anyEnabled;

        twoFactorUpdating = true;
        try {
          await updateTwoFactor(finalEnabled, activeMethod);
          await loadTwoFactorStatus();
        } catch (err) {
          alert(err?.message || "Unable to update 2-step verification.");
          await loadTwoFactorStatus();
        } finally {
          twoFactorUpdating = false;
        }
      });
    });
  }

  loadTwoFactorStatus();

  // --- SESSION HISTORY ---
  const sessionHistoryList = document.getElementById("sessionHistoryList");

  const guessDeviceLabel = (ua = "") => {
    const lower = ua.toLowerCase();
    let browser = "Browser";
    if (lower.includes("edg")) browser = "Edge";
    else if (lower.includes("chrome")) browser = "Chrome";
    else if (lower.includes("safari") && !lower.includes("chrome")) browser = "Safari";
    else if (lower.includes("firefox")) browser = "Firefox";

    let os = "Device";
    if (lower.includes("mac os")) os = "macOS";
    else if (lower.includes("windows")) os = "Windows";
    else if (lower.includes("iphone") || lower.includes("ipad")) os = "iOS";
    else if (lower.includes("android")) os = "Android";
    else if (lower.includes("linux")) os = "Linux";

    return `${browser} on ${os}`;
  };

  const formatRelativeTime = (dateValue) => {
    const date = dateValue ? new Date(dateValue) : null;
    if (!date || Number.isNaN(date.getTime())) return "Unknown time";
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 2) return "Just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    return date.toLocaleDateString();
  };

  const renderSessionHistory = (sessions = []) => {
    if (!sessionHistoryList) return;
    if (!sessions.length) {
      sessionHistoryList.innerHTML = "<p class=\"muted\">No recent sessions.</p>";
      return;
    }
    const currentUa = navigator.userAgent || "";
    let activeIndex = sessions.findIndex((item) => item.ua && item.ua === currentUa);
    if (activeIndex === -1) activeIndex = 0;

    sessionHistoryList.innerHTML = sessions
      .map((item, index) => {
        const isActive = index === activeIndex;
        const deviceLabel = guessDeviceLabel(item.ua);
        const locationLabel = item.ip ? `IP ${item.ip}` : "Location unavailable";
        const statusLabel = isActive ? "Active" : formatRelativeTime(item.createdAt);
        const actionDisabled = !isActive;
        return `
          <div class="session-row">
            <div class="session-device">
              <div class="session-device-icon">${deviceLabel[0] || "D"}</div>
              <div>
                <div>${deviceLabel}</div>
                <div class="session-meta">${locationLabel}</div>
              </div>
            </div>
            <div class="session-status">${statusLabel}</div>
            <button class="session-action" type="button" data-session-action="logout" ${actionDisabled ? "disabled" : ""} aria-label="Sign out of this session">
              <svg viewBox="0 0 20 20">
                <path fill="currentColor" d="M6.5 3.5h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7v-1.6h6.4v-7.8H6.5V3.5zm3.4 2.8 3.1 3.1-3.1 3.1-1.1-1.1 1.2-1.2H2.5V8.6h7.1L8.4 7.4l1.1-1.1z"/>
              </svg>
            </button>
          </div>
        `;
      })
      .join("");

    sessionHistoryList.querySelectorAll("[data-session-action=\"logout\"]").forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", async () => {
        const confirmed = window.confirm("Sign out of this device?");
        if (!confirmed) return;
        try {
          await secureFetch("/api/auth/logout", { method: "POST" });
        } catch {}
        try {
          window.clearStoredSession?.();
          localStorage.removeItem("lpc_user");
        } catch {}
        window.location.href = "login.html";
      });
    });
  };

  async function loadSessionHistory() {
    if (!sessionHistoryList) return;
    try {
      const res = await secureFetch("/api/account/sessions");
      if (!res.ok) throw new Error("Unable to load sessions");
      const data = await res.json().catch(() => ({}));
      renderSessionHistory(Array.isArray(data?.sessions) ? data.sessions : []);
    } catch (err) {
      sessionHistoryList.innerHTML = "<p class=\"muted\">Unable to load sessions.</p>";
    }
  }

  loadSessionHistory();

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
  profileImageOriginal: "",
  pendingProfileImage: "",
  pendingProfileImageOriginal: "",
  profilePhotoStatus: "",
  stagedProfilePhotoFile: null,
  stagedProfilePhotoUrl: "",
  stagedProfilePhotoOriginalFile: null,
  stagedProfilePhotoOriginalUrl: "",
  resumeFile: null,
  pendingResumeKey: "",
  pendingCertificateKey: "",
  pendingWritingSampleKey: "",
  removeResume: false,
  removeCertificate: false,
  removeWritingSample: false,
  bio: "",
  education: [],
  awards: [],
  highlightedSkills: [],
  stateExperience: [],
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
let paralegalRequiredBound = false;
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

const STATE_CODE_TO_NAME = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "Washington, D.C.",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
const STATE_NAME_TO_CODE = Object.entries(STATE_CODE_TO_NAME).reduce((acc, [code, name]) => {
  acc[String(name || "").toLowerCase().replace(/[^a-z]/g, "")] = code;
  return acc;
}, {});

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
const educationModalOverlay = document.getElementById("educationModalOverlay");
const educationModal = document.getElementById("educationModal");
const educationModalList = document.getElementById("educationModalList");
const educationModalAdd = document.getElementById("educationModalAdd");
const educationModalSave = document.getElementById("educationModalSave");
const educationModalCancel = document.getElementById("educationModalCancel");
const educationModalClose = document.getElementById("educationModalClose");
let educationModalBound = false;
let educationModalOpen = false;

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
  settingsState.stateExperience = user.stateExperience || [];
  settingsState.linkedInURL = user.linkedInURL || "";
  settingsState.profileImage = user.profileImage || user.avatarURL || "";
  settingsState.profileImageOriginal = user.profileImageOriginal || "";
  settingsState.pendingProfileImage = user.pendingProfileImage || "";
  settingsState.pendingProfileImageOriginal = user.pendingProfileImageOriginal || "";
  settingsState.profilePhotoStatus = resolveProfilePhotoStatus(user);
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

function resolveProfilePhotoStatus(user = {}) {
  const role = String(user.role || currentUser?.role || "").trim().toLowerCase();
  const hasApproved = Boolean(user.profileImage || user.avatarURL || settingsState.profileImage);
  if (role === "attorney") {
    return hasApproved ? "approved" : "unsubmitted";
  }
  if (user.pendingProfileImage || settingsState.pendingProfileImage || settingsState.stagedProfilePhotoUrl) {
    return "pending_review";
  }
  const raw = String(user.profilePhotoStatus || settingsState.profilePhotoStatus || "").trim();
  if (raw) return raw;
  return hasApproved ? "approved" : "unsubmitted";
}

function resolvePendingProfileImage(user = {}) {
  return user.pendingProfileImage || settingsState.pendingProfileImage || "";
}

function resolvePendingProfileImageOriginal(user = {}) {
  return user.pendingProfileImageOriginal || settingsState.pendingProfileImageOriginal || "";
}

function resolveProfileImageOriginal(user = {}) {
  return user.profileImageOriginal || settingsState.profileImageOriginal || "";
}

function getOriginalPhotoSource(user = {}, { allowPending = false } = {}) {
  if (settingsState.stagedProfilePhotoOriginalFile) {
    return { type: "file", value: settingsState.stagedProfilePhotoOriginalFile };
  }
  if (settingsState.stagedProfilePhotoOriginalUrl) {
    return { type: "url", value: settingsState.stagedProfilePhotoOriginalUrl };
  }
  const pendingOriginal = resolvePendingProfileImageOriginal(user);
  if (allowPending && pendingOriginal) {
    return { type: "url", value: pendingOriginal };
  }
  const approvedOriginal = resolveProfileImageOriginal(user);
  if (approvedOriginal) {
    return { type: "url", value: approvedOriginal };
  }
  return null;
}

function getDisplayProfileImage(user = {}, { allowPending = false } = {}) {
  const approved = user.profileImage || user.avatarURL || settingsState.profileImage || "";
  const role = String(user.role || currentUser?.role || "").trim().toLowerCase();
  const hasPending = Boolean(resolvePendingProfileImage(user) || settingsState.stagedProfilePhotoUrl);
  if (allowPending && (role === "paralegal" || hasPending)) {
    if (settingsState.stagedProfilePhotoUrl) {
      return settingsState.stagedProfilePhotoUrl;
    }
    const pending = resolvePendingProfileImage(user);
    if (pending) return pending;
  }
  return approved;
}

function updatePhotoReviewStatus(user = {}) {
  const statusEl = document.getElementById("photoReviewStatus");
  if (!statusEl) return;
  const role = String(currentUser?.role || user?.role || "").trim().toLowerCase();
  if (role === "attorney") {
    statusEl.classList.remove("is-rejected");
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    return;
  }
  if (settingsState.stagedProfilePhotoFile) {
    statusEl.classList.remove("is-rejected");
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    return;
  }
  const status = resolveProfilePhotoStatus(user);
  statusEl.classList.remove("is-rejected");
  let message = "";
  if (status === "pending_review") {
    message = "Pending";
  } else if (status === "rejected") {
    message = "Your photo needs a quick update. Please upload a new one that meets our guidelines.";
    statusEl.classList.add("is-rejected");
  }
  statusEl.textContent = message;
  statusEl.classList.toggle("hidden", !message);
}

function isParalegalPhotoApproved(user = {}) {
  const status = String(user.profilePhotoStatus || "").trim();
  const hasPending = Boolean(user.pendingProfileImage || settingsState.pendingProfileImage);
  return status === "approved" && !hasPending;
}

function getParalegalRequiredFieldStatus() {
  const bioInput = document.getElementById("bioInput");
  const bioValue = bioInput?.value ?? settingsState.bio;
  const bioOk = Boolean(String(bioValue || "").trim());

  const skillsInput = document.getElementById("skillsInput");
  const practiceInput = document.getElementById("practiceAreasInput");
  const skills = parseCommaList(skillsInput?.value || "");
  const focus = parseCommaList(practiceInput?.value || "");
  const skillsFocusOk = skills.length > 0 && focus.length > 0;

  const resumeKeyInput = document.getElementById("resumeKeyInput");
  const resumeValue =
    resumeKeyInput?.value || settingsState.pendingResumeKey || currentUser?.resumeURL || "";
  const resumeOk = !settingsState.removeResume && Boolean(String(resumeValue || "").trim());

  const pendingPhoto = settingsState.pendingProfileImage || currentUser?.pendingProfileImage || "";
  const approvedPhoto = settingsState.profileImage || currentUser?.profileImage || currentUser?.avatarURL || "";
  const photoOk = Boolean(settingsState.stagedProfilePhotoFile || pendingPhoto || approvedPhoto);

  return {
    bioOk,
    skillsFocusOk,
    resumeOk,
    photoOk,
  };
}

function updateRequiredFieldMarkers() {
  if (!currentUser || String(currentUser.role || "").toLowerCase() !== "paralegal") {
    return { ok: true };
  }
  const status = getParalegalRequiredFieldStatus();
  const bioLabel = document.querySelector("#bioSection .card-header-label");
  if (bioLabel) bioLabel.classList.toggle("required-missing", !status.bioOk);
  const skillsLabel = document.querySelector("#skillsCard .card-header-label");
  if (skillsLabel) skillsLabel.classList.toggle("required-missing", !status.skillsFocusOk);
  const stateLabel = document.querySelector("#stateExperienceCard .card-header-label");
  if (stateLabel) stateLabel.classList.remove("required-missing");
  const resumeHeader = document.querySelector("#settingsResume h3");
  if (resumeHeader) resumeHeader.classList.toggle("required-missing", !status.resumeOk);
  const avatarFrame = document.getElementById("avatarFrame");
  if (avatarFrame) avatarFrame.classList.toggle("required-missing", !status.photoOk);

  const missing = [];
  if (!status.bioOk) missing.push("Bio");
  if (!status.skillsFocusOk) missing.push("Skills & Focus Areas");
  if (!status.resumeOk) missing.push("Resume");
  if (!status.photoOk) missing.push("Profile photo");

  return {
    ...status,
    ok: status.bioOk && status.skillsFocusOk && status.resumeOk && status.photoOk,
    missing,
  };
}

function bindParalegalRequiredFieldWatchers() {
  if (paralegalRequiredBound) return;
  paralegalRequiredBound = true;
  const bioInput = document.getElementById("bioInput");
  if (bioInput) bioInput.addEventListener("input", updateRequiredFieldMarkers);
  const skillsInput = document.getElementById("skillsInput");
  if (skillsInput) skillsInput.addEventListener("input", updateRequiredFieldMarkers);
  const practiceInput = document.getElementById("practiceAreasInput");
  if (practiceInput) practiceInput.addEventListener("input", updateRequiredFieldMarkers);
  const stateInput = document.getElementById("stateExperienceInput");
  if (stateInput) stateInput.addEventListener("input", updateRequiredFieldMarkers);
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
  updatePhotoReviewStatus(user);
  initParalegalSectionEditing();
  bindEducationModal();
  hydrateParalegalNotificationPrefs(user);
  bindParalegalNotificationToggles();
  hydrateParalegalVisibilityPref(user);
  bindParalegalVisibilityToggle();
  bindParalegalRequiredFieldWatchers();
  updateRequiredFieldMarkers();
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
  setTimeout(() => initParalegalProfileTour(user), 300);
}

let profileTourInitialized = false;

function getStoredUserSnapshot() {
  try {
    const raw = localStorage.getItem("lpc_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getProfileTourKey(user) {
  const id = String(user?.id || user?._id || "").trim();
  return id ? `lpc_paralegal_profile_tour_${id}` : "";
}

function hasCompletedProfileTour(user) {
  const key = getProfileTourKey(user);
  if (!key) return false;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markProfileTourCompleted(user) {
  const key = getProfileTourKey(user);
  if (!key) return;
  try {
    localStorage.setItem(key, "1");
    const raw = localStorage.getItem("lpc_user");
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && typeof stored === "object") {
        stored.isFirstLogin = false;
        localStorage.setItem("lpc_user", JSON.stringify(stored));
      }
    }
  } catch {}
}

function initParalegalProfileTour(user = {}) {
  if (profileTourInitialized) return;
  profileTourInitialized = true;
  if (String(user?.role || "").toLowerCase() !== "paralegal") return;

  const overlay = document.getElementById("profileTourOverlay");
  const tooltip = document.getElementById("profileTourTooltip");
  const titleEl = document.getElementById("profileTourTitle");
  const textEl = document.getElementById("profileTourText");
  const closeBtn = document.getElementById("profileTourCloseBtn");
  const backBtn = document.getElementById("profileTourBackBtn");
  const nextBtn = document.getElementById("profileTourNextBtn");
  if (!overlay || !tooltip || !titleEl || !textEl || !closeBtn || !backBtn || !nextBtn) return;

  const stored = getStoredUserSnapshot();
  const effectiveUser = user || stored || {};
  const role = String(effectiveUser?.role || "").toLowerCase();
  const status = String(effectiveUser?.status || "").toLowerCase();
  const storedFlag = stored?.isFirstLogin;
  const userFlag = effectiveUser?.isFirstLogin;
  const isFirstLogin = typeof storedFlag === "boolean" ? storedFlag : Boolean(userFlag);

  const params = new URLSearchParams(window.location.search);
  const forceTour = params.get("tour") === "1";
  const shouldShow =
    forceTour ||
    (role === "paralegal" &&
      (!status || status === "approved") &&
      isFirstLogin &&
      !hasCompletedProfileTour(effectiveUser));
  if (!shouldShow) return;
  if (!forceTour) {
    markProfileTourCompleted(effectiveUser);
  }

  const steps = [
    {
      id: "educationCard",
      title: "Education",
      text: "List where you attended school and any legal training or certifications.",
    },
    {
      id: "bioSection",
      title: "Bio",
      text: "Share a short overview of your background, specialties, and the types of matters you support.",
    },
    {
      id: "languagesRow",
      title: "Languages",
      text: "List the languages you know and select your experience level.",
    },
    {
      id: "profileSaveBtn",
      title: "Save changes",
      text: "Save your updates so your profile stays current.",
    },
    {
      id: "previewProfileBtn",
      title: "View profile",
      text: "Preview the profile attorneys will see. We are in pre-launch, so attorneys are not onboarded yet. You will be emailed when onboarding begins.",
    },
  ];

  let activeIndex = 0;

  const clearTour = () => {
    overlay.classList.remove("is-active", "spotlight");
    overlay.setAttribute("aria-hidden", "true");
    tooltip.classList.remove("is-active", "arrow-left", "arrow-right");
    markProfileTourCompleted(user);
    if (forceTour) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  };

  const positionTooltip = (target) => {
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let left = rect.right + 16;
    let arrowClass = "arrow-left";
    if (left + tipRect.width > window.innerWidth - 16) {
      left = rect.left - tipRect.width - 16;
      arrowClass = "arrow-right";
    }
    const top = Math.max(
      12,
      Math.min(window.innerHeight - tipRect.height - 12, rect.top + rect.height / 2 - tipRect.height / 2)
    );
    tooltip.style.left = `${Math.max(12, left)}px`;
    tooltip.style.top = `${top}px`;
    tooltip.classList.remove("arrow-left", "arrow-right");
    tooltip.classList.add(arrowClass);
    const arrowTop = Math.max(16, Math.min(tipRect.height - 20, rect.top + rect.height / 2 - top - 8));
    tooltip.style.setProperty("--arrow-top", `${arrowTop}px`);
  };

  const positionSpotlight = (target) => {
    const rect = target.getBoundingClientRect();
    const padding = 10;
    overlay.style.setProperty("--spot-x", `${rect.left - padding}px`);
    overlay.style.setProperty("--spot-y", `${rect.top - padding}px`);
    overlay.style.setProperty("--spot-w", `${rect.width + padding * 2}px`);
    overlay.style.setProperty("--spot-h", `${rect.height + padding * 2}px`);
  };

  const showStep = (index) => {
    const step = steps[index];
    if (!step) {
      clearTour();
      return;
    }
    const target = document.getElementById(step.id);
    if (!target) {
      showStep(index + 1);
      return;
    }
    activeIndex = index;
    titleEl.textContent = step.title;
    textEl.textContent = step.text;
    backBtn.style.visibility = index === 0 ? "hidden" : "visible";
    backBtn.disabled = index === 0;
    nextBtn.textContent = index === steps.length - 1 ? "Finish" : "Next";
    overlay.classList.add("is-active", "spotlight");
    overlay.setAttribute("aria-hidden", "false");
    tooltip.classList.add("is-active");
    requestAnimationFrame(() => {
      positionSpotlight(target);
      positionTooltip(target);
    });
  };

  closeBtn.addEventListener("click", clearTour);
  backBtn.addEventListener("click", () => showStep(activeIndex - 1));
  nextBtn.addEventListener("click", () => {
    if (activeIndex >= steps.length - 1) {
      clearTour();
    } else {
      showStep(activeIndex + 1);
    }
  });

  window.addEventListener("resize", () => showStep(activeIndex));

  showStep(0);
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

const BEST_FOR_SUGGESTIONS = [
  "Ongoing litigation support",
  "Family law matters",
  "Document drafting and research",
  "Client-facing case management"
];

const EXPERIENCE_TITLE = "Paralegal";

function normalizeExperienceEntry(entry = {}) {
  const rawFirm = String(entry.description || entry.firm || entry.title || "").trim();
  const firm = rawFirm.replace(/^(paralegal|legal assistant)\s+at\s+/i, "").trim();
  const dates = String(entry.years || entry.dates || "").trim();
  return { firm, dates };
}

function createExperienceRow(entry = {}) {
  const { firm, dates } = normalizeExperienceEntry(entry);
  const row = document.createElement("div");
  row.className = "experience-row";

  const firmLabel = document.createElement("label");
  const firmText = document.createElement("span");
  firmText.textContent = "Law firm";
  const firmInput = document.createElement("input");
  firmInput.type = "text";
  firmInput.className = "experience-firm-input";
  firmInput.placeholder = "Smith & Co.";
  firmInput.value = firm;
  firmLabel.appendChild(firmText);
  firmLabel.appendChild(firmInput);

  const datesLabel = document.createElement("label");
  const datesText = document.createElement("span");
  datesText.textContent = "Dates";
  const datesInput = document.createElement("input");
  datesInput.type = "text";
  datesInput.className = "experience-dates-input";
  datesInput.placeholder = "2020–2024";
  datesInput.value = dates;
  datesLabel.appendChild(datesText);
  datesLabel.appendChild(datesInput);

  row.appendChild(firmLabel);
  row.appendChild(datesLabel);
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "experience-remove-btn";
  removeBtn.textContent = "–";
  removeBtn.setAttribute("aria-label", "Remove experience");
  removeBtn.addEventListener("click", () => {
    const container = row.parentElement;
    row.remove();
    if (container && !container.querySelector(".experience-row")) {
      container.appendChild(createExperienceRow());
    }
    updateExperienceRemoveButtons(container);
  });
  row.appendChild(removeBtn);
  return row;
}

function renderExperienceRows(entries = []) {
  const container = document.getElementById("experienceRows");
  if (!container) return;
  container.innerHTML = "";
  const list = Array.isArray(entries) && entries.length ? entries : [{}];
  list.forEach((entry) => {
    container.appendChild(createExperienceRow(entry));
  });
  updateExperienceRemoveButtons(container);
}

function bindExperienceAddButton() {
  const container = document.getElementById("experienceRows");
  const addBtn = document.getElementById("addExperienceRow");
  if (!container || !addBtn) return;
  if (addBtn.dataset.bound === "true") return;
  addBtn.addEventListener("click", () => {
    container.appendChild(createExperienceRow());
    updateExperienceRemoveButtons(container);
  });
  addBtn.dataset.bound = "true";
}

function updateExperienceRemoveButtons(container) {
  if (!container) return;
  const rows = [...container.querySelectorAll(".experience-row")];
  const canRemove = rows.length > 1;
  rows.forEach((row) => {
    const btn = row.querySelector(".experience-remove-btn");
    if (!btn) return;
    btn.disabled = !canRemove;
  });
}

function collectExperienceRows() {
  const container = document.getElementById("experienceRows");
  if (!container) return [];
  const rows = [...container.querySelectorAll(".experience-row")];
  return rows
    .map((row) => {
      const firm = row.querySelector(".experience-firm-input")?.value.trim() || "";
      const dates = row.querySelector(".experience-dates-input")?.value.trim() || "";
      if (!firm && !dates) return null;
      return { firm, dates };
    })
    .filter(Boolean);
}

function formatExperienceDisplayLine(entry = {}) {
  const firm = String(entry.firm || "").trim();
  const dates = String(entry.dates || "").trim();
  if (!firm && !dates) return "";
  const base = firm ? `${EXPERIENCE_TITLE} · ${firm}` : EXPERIENCE_TITLE;
  return dates ? `${base} (${dates})` : base;
}

function buildExperienceEntriesForSave(entries = []) {
  return entries
    .map((entry) => ({
      title: EXPERIENCE_TITLE,
      description: entry.firm || "",
      years: entry.dates || ""
    }))
    .filter((entry) => entry.description || entry.years);
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

function setSectionDisplayList(element, items = [], fallbackItems = []) {
  if (!element) return;
  const cleanItems = Array.isArray(items) ? items.filter(Boolean) : [];
  const useItems = cleanItems.length ? cleanItems : fallbackItems;
  element.innerHTML = "";
  useItems.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    element.appendChild(li);
  });
  element.classList.toggle("is-placeholder", !cleanItems.length);
}

function parseCommaList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStateName(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function normalizeStateCode(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (STATE_CODE_TO_NAME[upper]) return upper;
  const normalized = normalizeStateName(raw);
  if (normalized === "districtofcolumbia" || normalized === "washingtondc") {
    return "DC";
  }
  return STATE_NAME_TO_CODE[normalized] || "";
}

function renderStateExperienceChips(values = []) {
  const container = document.getElementById("stateExperienceChips");
  if (!container) return;
  const codes = Array.isArray(values)
    ? values.map((value) => normalizeStateCode(value)).filter(Boolean)
    : [];
  const unique = Array.from(new Set(codes));
  container.innerHTML = "";
  unique.forEach((code) => {
    const chip = document.createElement("span");
    chip.className = "state-chip";
    chip.dataset.stateCode = code;
    chip.textContent = STATE_CODE_TO_NAME[code] || code;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.setAttribute("aria-label", `Remove ${chip.textContent}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const updated = readStateExperienceInput().filter((value) => value !== code);
      renderStateExperienceChips(updated);
      refreshParalegalSectionDisplays();
    });
    chip.appendChild(remove);
    container.appendChild(chip);
  });
}

function readStateExperienceInput() {
  const container = document.getElementById("stateExperienceChips");
  if (container) {
    return Array.from(container.querySelectorAll("[data-state-code]"))
      .map((el) => String(el.dataset.stateCode || "").trim())
      .filter(Boolean);
  }
  const input = document.getElementById("stateExperienceInput");
  if (!input) return [];
  return parseCommaList(input.value)
    .map((value) => normalizeStateCode(value))
    .filter(Boolean);
}

function readStateExperienceLabels() {
  return readStateExperienceInput().map((code) => STATE_CODE_TO_NAME[code] || code);
}

function applyStateExperienceInput(values = []) {
  const entries = Array.isArray(values)
    ? values
    : String(values || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const normalized = entries.map((entry) => normalizeStateCode(entry)).filter(Boolean);
  renderStateExperienceChips(normalized);
  const input = document.getElementById("stateExperienceInput");
  if (input) input.value = "";
}

function bindStateExperienceInput() {
  const input = document.getElementById("stateExperienceInput");
  if (!input || input.dataset.bound === "true") return;
  input.dataset.bound = "true";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const rawValue = input.value.trim();
    if (!rawValue) return;
    const entries = rawValue
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const existing = new Set(readStateExperienceInput());
    let invalid = 0;
    entries.forEach((entry) => {
      const code = normalizeStateCode(entry);
      if (!code) {
        invalid += 1;
        return;
      }
      existing.add(code);
    });
    renderStateExperienceChips(Array.from(existing));
    input.value = "";
    refreshParalegalSectionDisplays();
    if (invalid) {
      showToast("Use a valid two-letter state abbreviation (e.g., VA).", "err");
    }
  });
}

function sanitizeBestForEntry(value) {
  return String(value || "").replace(/^\s*[•*-]\s*/, "").trim();
}

function collectBestForEntries() {
  const list = document.getElementById("bestForDisplay");
  if (!list) return [];
  if (list.dataset.mode === "placeholder") return [];
  return Array.from(list.querySelectorAll("li"))
    .map((item) => sanitizeBestForEntry(item.textContent))
    .filter(Boolean);
}

function createBestForListItem(text = "") {
  const li = document.createElement("li");
  li.textContent = text;
  li.contentEditable = "true";
  li.spellcheck = false;
  li.tabIndex = 0;
  return li;
}

function renderBestForList(entries = [], { editable = false } = {}) {
  const list = document.getElementById("bestForDisplay");
  if (!list) return;
  const hasEntries = Array.isArray(entries) && entries.length > 0;
  list.innerHTML = "";

  if (editable) {
    const editItems = hasEntries ? entries : [""];
    editItems.forEach((item) => list.appendChild(createBestForListItem(item)));
    list.dataset.mode = "edit";
    list.classList.remove("is-placeholder");
    return;
  }

  const items = hasEntries ? entries : BEST_FOR_SUGGESTIONS;
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });
  list.dataset.mode = hasEntries ? "data" : "placeholder";
  list.classList.toggle("is-placeholder", !hasEntries);
}

function focusBestForItem(item, toEnd = false) {
  if (!item) return;
  item.focus();
  const range = document.createRange();
  range.selectNodeContents(item);
  range.collapse(!toEnd);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function handleBestForListKeydown(event) {
  const section = document.getElementById("bestForSection");
  if (!section?.classList.contains("is-editing")) return;
  const target = event.target;
  const element = target && target.nodeType === 3 ? target.parentElement : target;
  if (!element || typeof element.closest !== "function") return;
  const item = element.closest("li");
  if (!item) return;

  if (event.key === "Enter") {
    event.preventDefault();
    const nextItem = createBestForListItem("");
    item.insertAdjacentElement("afterend", nextItem);
    focusBestForItem(nextItem);
    return;
  }

  if (event.key === "Backspace") {
    const text = sanitizeBestForEntry(item.textContent);
    if (!text) {
      const items = item.parentElement?.querySelectorAll("li") || [];
      if (items.length > 1) {
        event.preventDefault();
        const focusTarget = item.previousElementSibling || item.nextElementSibling;
        item.remove();
        focusBestForItem(focusTarget, true);
        return;
      }
      event.preventDefault();
      item.textContent = "";
      focusBestForItem(item);
    }
  }

  if (event.key === "Delete") {
    const text = sanitizeBestForEntry(item.textContent);
    if (!text) {
      const items = item.parentElement?.querySelectorAll("li") || [];
      if (items.length > 1) {
        event.preventDefault();
        const focusTarget = item.nextElementSibling || item.previousElementSibling;
        item.remove();
        focusBestForItem(focusTarget, false);
        return;
      }
    }
  }
}

function handleBestForListInput() {
  const list = document.getElementById("bestForDisplay");
  if (!list || list.dataset.mode !== "edit") return;
  const items = list.querySelectorAll("li");
  if (!items.length) {
    list.appendChild(createBestForListItem(""));
  }
  const hasText = collectBestForEntries().length > 0;
  list.classList.toggle("is-typing", hasText);
}

function updateBestForEditingState() {
  const section = document.getElementById("bestForSection");
  if (!section) return;
  if (section.classList.contains("is-editing")) {
    const entries = collectBestForEntries();
    renderBestForList(entries, { editable: true });
    const list = document.getElementById("bestForDisplay");
    if (list) list.classList.toggle("is-typing", entries.length > 0);
    const items = document.getElementById("bestForDisplay")?.querySelectorAll("li");
    const lastItem = items && items.length ? items[items.length - 1] : null;
    focusBestForItem(lastItem, true);
  } else {
    renderBestForList(collectBestForEntries(), { editable: false });
  }
}

function formatEducationEntry(entry = {}) {
  const pieces = [];
  const titleBits = [entry.degree, entry.fieldOfStudy].filter(Boolean);
  if (titleBits.length) pieces.push(titleBits.join(", "));
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
  const experienceRows = collectExperienceRows();
  const experienceLines = experienceRows
    .map((entry) => formatExperienceDisplayLine(entry))
    .filter(Boolean);
  setSectionDisplayText(
    experienceDisplay,
    experienceLines.join("\n"),
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

  const stateExperienceDisplay = document.getElementById("stateExperienceDisplay");
  if (stateExperienceDisplay) {
    const states = readStateExperienceLabels();
    setSectionDisplayText(
      stateExperienceDisplay,
      states.join(", "),
      "No state experience listed."
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

  updateRequiredFieldMarkers();
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
  updateBestForEditingState();
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
        if (targetKey === "education") {
          setActiveParalegalSection(null);
          openEducationModal();
          return;
        }
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
  const resolvedUrl = url || DEFAULT_AVATAR_DATA;

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
  preview.src = resolvedUrl;
  if (preview.complete && preview.naturalWidth > 0) {
    markLoaded();
  }
}

function updateAttorneyAvatarPreview(user = {}) {
  const preview = document.getElementById("attorneyAvatarPreview");
  const initials = document.getElementById("attorneyAvatarInitials");
  const frame = document.getElementById("attorneyAvatarFrame");
  const avatarUrl = getDisplayProfileImage(user, { allowPending: true });
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

function updateParalegalVisibilityLock(user = {}) {
  const toggle = document.getElementById("paralegalHideProfile");
  if (!toggle) return;
  const approved = isParalegalPhotoApproved(user);
  if (!approved) {
    toggle.checked = true;
  }
  toggle.disabled = !approved;
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
  updateParalegalVisibilityLock(user);
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
    settingsState.profileImageOriginal = updatedUser.profileImageOriginal || settingsState.profileImageOriginal;
    settingsState.pendingProfileImage = updatedUser.pendingProfileImage || settingsState.pendingProfileImage;
    settingsState.pendingProfileImageOriginal =
      updatedUser.pendingProfileImageOriginal || settingsState.pendingProfileImageOriginal;
    settingsState.profilePhotoStatus = resolveProfilePhotoStatus(updatedUser);
    settingsState.practiceDescription = updatedUser.practiceDescription || updatedUser.bio || "";
    renderAttorneyPracticeAreas(updatedUser.practiceAreas || []);
    settingsState.notificationPrefs = {
      ...settingsState.notificationPrefs,
      email: updatedUser.notificationPrefs?.email !== false,
      emailMessages: updatedUser.notificationPrefs?.emailMessages !== false,
      emailCase: updatedUser.notificationPrefs?.emailCase !== false
    };
    hydrateAttorneyProfileForm(updatedUser);
    updatePhotoReviewStatus(updatedUser);
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
      degree: "",
      fieldOfStudy: "",
      grade: "",
      activities: ""
    };
  }
  if (typeof entry === "string") {
    return {
      school: entry,
      startMonth: "",
      startYear: "",
      endMonth: "",
      endYear: "",
      degree: "",
      fieldOfStudy: "",
      grade: "",
      activities: ""
    };
  }
  return {
    school: entry.school || entry.institution || "",
    startMonth: entry.startMonth || entry.beginMonth || "",
    startYear: entry.startYear || entry.beginYear || "",
    endMonth: entry.endMonth || entry.finishMonth || "",
    endYear: entry.endYear || entry.finishYear || "",
    degree: entry.degree || "",
    fieldOfStudy: entry.fieldOfStudy || entry.field || "",
    grade: entry.grade || "",
    activities: entry.activities || entry.activitiesAndSocieties || ""
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
    if (!opt.value && placeholderLabel) {
      option.textContent = placeholderLabel;
    } else {
      option.textContent = opt.label || placeholderLabel || "";
    }
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
  row.dataset.fieldOfStudy = entry.fieldOfStudy || "";
  row.dataset.grade = entry.grade || "";
  row.dataset.activities = entry.activities || "";

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
      const fieldOfStudy = row.dataset.fieldOfStudy || "";
      const grade = row.dataset.grade || "";
      const activities = row.dataset.activities || "";
      if (!school && !startYear && !endYear && !startMonth && !endMonth && !degree && !fieldOfStudy && !grade && !activities) {
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
      if (fieldOfStudy) entry.fieldOfStudy = fieldOfStudy;
      if (grade) entry.grade = grade;
      if (activities) entry.activities = activities;
      return entry;
    })
    .filter(Boolean);
}

function buildEducationModalField({ label, field, placeholder, value, type = "text", span = false, isTextarea = false }) {
  const row = document.createElement("div");
  row.className = "education-form-row";
  if (span) row.classList.add("education-form-span");

  const labelEl = document.createElement("label");
  labelEl.textContent = label;

  const input = isTextarea ? document.createElement("textarea") : document.createElement("input");
  if (!isTextarea) input.type = type;
  input.placeholder = placeholder || "";
  input.value = value || "";
  input.setAttribute("data-field", field);

  row.appendChild(labelEl);
  row.appendChild(input);
  return row;
}

function buildEducationDateRow({ label, monthField, yearField, monthValue, yearValue }) {
  const row = document.createElement("div");
  row.className = "education-form-row";

  const labelEl = document.createElement("label");
  labelEl.textContent = label;

  const grid = document.createElement("div");
  grid.className = "education-date-grid";
  const monthSelect = createEducationMonthSelect(monthValue, "Month");
  monthSelect.setAttribute("data-field", monthField);
  const yearInput = document.createElement("input");
  yearInput.type = "number";
  yearInput.placeholder = "Year";
  yearInput.value = yearValue || "";
  yearInput.min = "1900";
  yearInput.max = "2100";
  yearInput.setAttribute("data-field", yearField);
  grid.appendChild(monthSelect);
  grid.appendChild(yearInput);

  row.appendChild(labelEl);
  row.appendChild(grid);
  return row;
}

function buildEducationModalEntry(entry = {}) {
  const normalized = normalizeEducationEntry(entry);
  const card = document.createElement("div");
  card.className = "education-entry";

  const header = document.createElement("div");
  header.className = "education-entry-header";

  const title = document.createElement("h4");
  title.className = "education-entry-title";
  title.textContent = "Education";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "education-entry-remove";
  removeBtn.textContent = "Remove";
  removeBtn.setAttribute("aria-label", "Remove education");
  removeBtn.addEventListener("click", () => {
    card.remove();
    updateEducationEntryTitles();
  });

  header.appendChild(title);
  header.appendChild(removeBtn);
  card.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "education-form-grid";
  grid.appendChild(
    buildEducationModalField({
      label: "School *",
      field: "school",
      placeholder: "Ex: Boston University",
      value: normalized.school,
      span: true
    })
  );
  grid.appendChild(
    buildEducationModalField({
      label: "Degree",
      field: "degree",
      placeholder: "Ex: Bachelor's",
      value: normalized.degree
    })
  );
  grid.appendChild(
    buildEducationModalField({
      label: "Field of study",
      field: "fieldOfStudy",
      placeholder: "Ex: Business",
      value: normalized.fieldOfStudy
    })
  );
  grid.appendChild(
    buildEducationDateRow({
      label: "Start date",
      monthField: "startMonth",
      yearField: "startYear",
      monthValue: normalized.startMonth,
      yearValue: normalized.startYear
    })
  );
  grid.appendChild(
    buildEducationDateRow({
      label: "End date (or expected)",
      monthField: "endMonth",
      yearField: "endYear",
      monthValue: normalized.endMonth,
      yearValue: normalized.endYear
    })
  );
  grid.appendChild(
    buildEducationModalField({
      label: "Grade",
      field: "grade",
      placeholder: "Ex: 3.8 GPA",
      value: normalized.grade
    })
  );
  grid.appendChild(
    buildEducationModalField({
      label: "Activities and societies",
      field: "activities",
      placeholder: "Ex: Alpha Phi Omega, Marching Band, Volleyball",
      value: normalized.activities,
      span: true,
      isTextarea: true
    })
  );

  card.appendChild(grid);
  return card;
}

function updateEducationEntryTitles() {
  if (!educationModalList) return;
  const entries = educationModalList.querySelectorAll(".education-entry");
  entries.forEach((entry, index) => {
    const title = entry.querySelector(".education-entry-title");
    if (title) title.textContent = `Education ${index + 1}`;
  });
}

function renderEducationModalEntries(education = []) {
  if (!educationModalList) return;
  educationModalList.innerHTML = "";
  const entries =
    Array.isArray(education) && education.length
      ? education.map((entry) => normalizeEducationEntry(entry))
      : [normalizeEducationEntry()];
  entries.forEach((entry) => educationModalList.appendChild(buildEducationModalEntry(entry)));
  updateEducationEntryTitles();
}

function collectEducationFromModal() {
  if (!educationModalList) return settingsState.education || [];
  const entries = [];
  educationModalList.querySelectorAll(".education-entry").forEach((entryEl) => {
    const data = {};
    entryEl.querySelectorAll("[data-field]").forEach((fieldEl) => {
      const field = fieldEl.getAttribute("data-field");
      if (!field) return;
      const value = typeof fieldEl.value === "string" ? fieldEl.value.trim() : "";
      data[field] = value;
    });
    const hasContent = Object.values(data).some((value) => String(value || "").trim().length > 0);
    if (hasContent) entries.push(normalizeEducationEntry(data));
  });
  return entries;
}

function openEducationModal() {
  if (!educationModalOverlay || !educationModal) return;
  bindEducationModal();
  const current = collectEducationFromEditor();
  const entries = current.length ? current : settingsState.education || [];
  renderEducationModalEntries(entries);
  educationModalOverlay.classList.add("is-active");
  educationModalOverlay.setAttribute("aria-hidden", "false");
  educationModal.classList.add("is-active");
  educationModalOpen = true;
  const firstInput = educationModalList?.querySelector("[data-field='school']");
  if (firstInput) {
    setTimeout(() => firstInput.focus(), 0);
  }
}

function closeEducationModal() {
  if (!educationModalOverlay || !educationModal) return;
  educationModalOverlay.classList.remove("is-active");
  educationModalOverlay.setAttribute("aria-hidden", "true");
  educationModal.classList.remove("is-active");
  educationModalOpen = false;
}

function bindEducationModal() {
  if (educationModalBound) return;
  if (!educationModalOverlay || !educationModal) return;
  educationModalBound = true;

  educationModalOverlay.addEventListener("click", (evt) => {
    if (evt.target === educationModalOverlay) {
      closeEducationModal();
    }
  });
  educationModalClose?.addEventListener("click", closeEducationModal);
  educationModalCancel?.addEventListener("click", closeEducationModal);
  educationModalAdd?.addEventListener("click", () => {
    if (!educationModalList) return;
    educationModalList.appendChild(buildEducationModalEntry(normalizeEducationEntry()));
    updateEducationEntryTitles();
  });
  educationModalSave?.addEventListener("click", () => {
    const entries = collectEducationFromModal();
    settingsState.education = entries;
    renderEducationEditor(entries);
    refreshParalegalSectionDisplays();
    closeEducationModal();
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && educationModalOpen) {
      closeEducationModal();
    }
  });
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
  const sidebarLogo = document.querySelector(".sidebar .logo");

  if (eyebrow) eyebrow.textContent = "Account";
  if (title) {
    title.textContent = role === "paralegal" ? "Account Settings" : "Account Settings";
  }
  if (sidebarLogo) {
    const defaultText = sidebarLogo.dataset.defaultText || sidebarLogo.textContent;
    if (!sidebarLogo.dataset.defaultText) sidebarLogo.dataset.defaultText = defaultText;
    sidebarLogo.textContent = isParalegal ? "Account Settings" : defaultText;
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
  const rawUrl = getDisplayProfileImage(user, { allowPending: true });
  const resolvedUrl = rawUrl || DEFAULT_AVATAR_DATA;
  const cacheBusted = rawUrl
    ? rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")
      ? rawUrl
      : `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}t=${Date.now()}`
    : resolvedUrl;

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

  updateAvatarRemoveButton(user);
}

function renderFallback(sectionId, title) {
  const section = document.getElementById(sectionId);
  if (section) section.innerHTML = `<h3>${title}</h3><p>Unable to load.</p>`;
}

function syncCluster(user = {}) {
  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.name || "Paralegal";
  const roleLabel = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : "Paralegal";
  const avatar = getDisplayProfileImage(user, { allowPending: true }) || "https://via.placeholder.com/64x64.png?text=PL";
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
      applyStateExperienceInput(user.stateExperience || []);
      bindStateExperienceInput();
      renderExperienceRows(Array.isArray(user.experience) ? user.experience : []);
      bindExperienceAddButton();
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
  updatePhotoReviewStatus(user);

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
    applyStateExperienceInput(user.stateExperience || []);
    bindStateExperienceInput();
    renderBestForList(Array.isArray(user.bestFor) ? user.bestFor : [], { editable: false });
    renderExperienceRows(Array.isArray(user.experience) ? user.experience : []);
    bindExperienceAddButton();
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
    updateRequiredFieldMarkers();
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
    updateRequiredFieldMarkers();
  });

  updateRequiredFieldMarkers();
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
  if (String(currentUser?.role || "").toLowerCase() === "paralegal") {
    const requiredStatus = updateRequiredFieldMarkers();
    if (!requiredStatus.ok) {
      const missingList =
        Array.isArray(requiredStatus.missing) && requiredStatus.missing.length
          ? requiredStatus.missing.join(", ")
          : "required fields";
      showToast(`Missing required fields: ${missingList}.`, "err");
      return;
    }
  }
  const stagedPhoto = !!settingsState.stagedProfilePhotoFile;
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
  const resumeKeyInput = document.getElementById("resumeKeyInput");
  const certificateKeyInput = document.getElementById("certificateKeyInput");
  const writingSampleKeyInput = document.getElementById("writingSampleKeyInput");
  if (settingsState.stagedProfilePhotoFile) {
    try {
      const payload = await uploadProfilePhotoFile(
        settingsState.stagedProfilePhotoFile,
        settingsState.stagedProfilePhotoOriginalFile
      );
      applyProfilePhotoUploadResult(payload, { suppressToast: true });
    } catch (err) {
      console.error("Unable to upload profile photo", err);
      showToast("Unable to upload photo. Please try again.", "err");
      return;
    }
  }
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
  body.stateExperience = readStateExperienceInput();
  body.bestFor = collectBestForEntries();
  body.skills = body.highlightedSkills;
  body.experience = buildExperienceEntriesForSave(collectExperienceRows());
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
  const pendingFallback = settingsState.pendingProfileImage || currentUser?.pendingProfileImage || "";
  const pendingOriginalFallback =
    settingsState.pendingProfileImageOriginal || currentUser?.pendingProfileImageOriginal || "";
  if (pendingFallback && !updatedUser?.pendingProfileImage) {
    updatedUser.pendingProfileImage = pendingFallback;
    updatedUser.profilePhotoStatus = updatedUser.profilePhotoStatus || "pending_review";
  }
  if (pendingOriginalFallback && !updatedUser?.pendingProfileImageOriginal) {
    updatedUser.pendingProfileImageOriginal = pendingOriginalFallback;
  }
  const mergedUser = mergeSessionPreferences({
    ...(currentUser || {}),
    ...updatedUser,
    role: updatedUser.role || currentUser?.role || ""
  });
  localStorage.setItem("lpc_user", JSON.stringify(mergedUser));
  currentUser = mergedUser;
  settingsState.bio = updatedUser.bio || "";
  settingsState.education = updatedUser.education || [];
  settingsState.awards = updatedUser.awards || [];
  settingsState.highlightedSkills = updatedUser.highlightedSkills || updatedUser.skills || [];
  settingsState.stateExperience = updatedUser.stateExperience || [];
  settingsState.linkedInURL = updatedUser.linkedInURL || "";
  settingsState.notificationPrefs = {
    email: true,
    sms: false,
    ...(updatedUser.notificationPrefs || {})
  };
  const newFreq = typeof updatedUser.digestFrequency === "string" ? updatedUser.digestFrequency : "off";
  settingsState.digestFrequency = ["off", "daily", "weekly"].includes(newFreq) ? newFreq : "off";
  settingsState.profileImage = updatedUser.profileImage || settingsState.profileImage;
  settingsState.profileImageOriginal = updatedUser.profileImageOriginal || settingsState.profileImageOriginal;
  settingsState.pendingProfileImage = updatedUser.pendingProfileImage || settingsState.pendingProfileImage;
  settingsState.pendingProfileImageOriginal =
    updatedUser.pendingProfileImageOriginal || settingsState.pendingProfileImageOriginal;
  settingsState.profilePhotoStatus = resolveProfilePhotoStatus(updatedUser);
  settingsState.pendingResumeKey = "";
  settingsState.pendingCertificateKey = "";
  settingsState.pendingWritingSampleKey = "";
  settingsState.removeResume = false;
  settingsState.removeCertificate = false;
  settingsState.removeWritingSample = false;
  if (resumeKeyInput) resumeKeyInput.value = "";
  if (certificateKeyInput) certificateKeyInput.value = "";
  if (writingSampleKeyInput) writingSampleKeyInput.value = "";
  if (writingSampleInput) writingSampleInput.value = "";

  persistSession({ user: mergedUser });
  window.updateSessionUser?.(mergedUser);

  applyAvatar?.(mergedUser);
  updateAvatarRemoveButton(mergedUser);
  updatePhotoReviewStatus(mergedUser);
  hydrateProfileForm(mergedUser);
  renderLanguageEditor(mergedUser.languages || []);
  bootstrapProfileSettings(mergedUser);
  syncCluster?.(mergedUser);
  window.hydrateParalegalCluster?.(mergedUser);
  try {
    window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: mergedUser }));
  } catch (_) {}
  try {
    localStorage.removeItem(PREFILL_CACHE_KEY);
  } catch {}
  showToast(
    stagedPhoto ? "Settings saved and profile photo submitted for review." : "Settings saved!",
    "ok"
  );
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

let activeCropper = null;
let cropperModal = null;
let cropperImage = null;
let cropperZoom = null;
let cropperConfig = null;
let cropperFile = null;
let cropperOriginalFile = null;
let cropperOriginalUrl = "";
let cropperObjectUrl = null;
let cropperBaseZoom = 1;
let cropperZoomLock = false;

function getCurrentCropperZoom() {
  if (!activeCropper) return 1;
  const data = activeCropper.getImageData();
  return data?.naturalWidth ? data.width / data.naturalWidth : 1;
}

function syncCropperBaseZoom({ resetSlider = false } = {}) {
  if (!activeCropper) return;
  cropperBaseZoom = getCurrentCropperZoom();
  if (!cropperZoom) return;
  cropperZoomLock = true;
  cropperZoom.min = "0";
  cropperZoom.max = "0.5";
  cropperZoom.step = "0.01";
  if (resetSlider) {
    cropperZoom.value = "0";
  } else {
    const relative = cropperBaseZoom ? getCurrentCropperZoom() / cropperBaseZoom - 1 : 0;
    cropperZoom.value = String(Math.min(0.5, Math.max(0, relative)));
  }
  requestAnimationFrame(() => {
    cropperZoomLock = false;
  });
}

function initAvatarUploaders() {
  bindAvatarRemoval();
  bindAvatarEditing();
  initPhotoCropperModal();
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

function updateAvatarRemoveButton(user = currentUser || {}) {
  const removeBtn = document.getElementById("removeAvatarBtn");
  const editBtn = document.getElementById("editAvatarBtn");
  const attorneyEditBtn = document.getElementById("editAttorneyAvatarBtn");
  const rawUrl = user.profileImage || user.avatarURL || settingsState.profileImage || "";
  const pendingUrl = resolvePendingProfileImage(user);
  const stagedUrl = settingsState.stagedProfilePhotoUrl || "";
  const hasPhoto = Boolean(rawUrl || pendingUrl || stagedUrl);
  if (removeBtn) {
    removeBtn.classList.toggle("hidden", !hasPhoto);
    removeBtn.disabled = !hasPhoto;
  }
  if (editBtn) {
    editBtn.classList.toggle("hidden", !hasPhoto);
    editBtn.disabled = !hasPhoto;
  }
  if (attorneyEditBtn) {
    attorneyEditBtn.classList.toggle("hidden", !hasPhoto);
    attorneyEditBtn.disabled = !hasPhoto;
  }
}

function clearStagedProfilePhoto() {
  if (settingsState.stagedProfilePhotoUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(settingsState.stagedProfilePhotoUrl);
  }
  settingsState.stagedProfilePhotoUrl = "";
  settingsState.stagedProfilePhotoFile = null;
  if (settingsState.stagedProfilePhotoOriginalUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(settingsState.stagedProfilePhotoOriginalUrl);
  }
  settingsState.stagedProfilePhotoOriginalUrl = "";
  settingsState.stagedProfilePhotoOriginalFile = null;
}

function applyProfilePhotoUploadResult(payload = {}, { suppressToast = false } = {}) {
  const status = String(payload?.status || payload?.profilePhotoStatus || "").trim();
  const pendingUrl = payload?.pendingProfileImage || (status === "pending_review" ? payload?.url : "");
  const approvedUrl = payload?.profileImage || payload?.avatarURL || (status !== "pending_review" ? payload?.url : "");
  const pendingOriginal = payload?.pendingProfileImageOriginal || "";
  const approvedOriginal = payload?.profileImageOriginal || "";

  if (status === "pending_review") {
    const updatedUser = mergeSessionPreferences({
      ...(currentUser || {}),
      pendingProfileImage: pendingUrl,
      pendingProfileImageOriginal: pendingOriginal,
      profilePhotoStatus: "pending_review",
    });
    currentUser = updatedUser;
    settingsState.pendingProfileImage = pendingUrl || settingsState.pendingProfileImage;
    settingsState.pendingProfileImageOriginal = pendingOriginal || settingsState.pendingProfileImageOriginal;
    settingsState.profilePhotoStatus = "pending_review";
    persistSession({ user: updatedUser });
    window.updateSessionUser?.(updatedUser);
    applyAvatar(updatedUser);
    updateAvatarRemoveButton(updatedUser);
    updatePhotoReviewStatus(updatedUser);
    if (!suppressToast) {
      showToast("Photo submitted for review.", "ok");
    }
  } else if (approvedUrl) {
    const updatedUser = mergeSessionPreferences({
      ...(currentUser || {}),
      profileImage: approvedUrl,
      avatarURL: approvedUrl,
      profileImageOriginal: approvedOriginal || (currentUser?.profileImageOriginal || ""),
      pendingProfileImage: "",
      pendingProfileImageOriginal: "",
      profilePhotoStatus: "approved",
    });
    currentUser = updatedUser;
    settingsState.profileImage = approvedUrl;
    settingsState.profileImageOriginal =
      approvedOriginal || currentUser?.profileImageOriginal || settingsState.profileImageOriginal;
    settingsState.pendingProfileImage = "";
    settingsState.pendingProfileImageOriginal = "";
    settingsState.profilePhotoStatus = "approved";
    persistSession({ user: updatedUser });
    window.updateSessionUser?.(updatedUser);
    applyAvatar(updatedUser);
    updateAvatarRemoveButton(updatedUser);
    updatePhotoReviewStatus(updatedUser);
    if (!suppressToast) {
      showToast("Profile photo updated!", "ok");
    }
  }

  updateParalegalVisibilityLock(currentUser || {});
  updateRequiredFieldMarkers();
  clearStagedProfilePhoto();
}

function bindAvatarRemoval() {
  const removeBtn = document.getElementById("removeAvatarBtn");
  if (!removeBtn) return;
  if (removeBtn.dataset.bound === "true") return;
  removeBtn.dataset.bound = "true";
  removeBtn.addEventListener("click", async () => {
    if (settingsState.stagedProfilePhotoFile) {
      clearStagedProfilePhoto();
      applyAvatar(currentUser || {});
      updateAvatarRemoveButton(currentUser || {});
      updatePhotoReviewStatus(currentUser || {});
      updateRequiredFieldMarkers();
      return;
    }
    if (!currentUser) return;
    const originalLabel = removeBtn.textContent;
    removeBtn.disabled = true;
    removeBtn.textContent = "Removing…";
    try {
      const res = await secureFetch("/api/users/me", {
        method: "PATCH",
        body: { profileImage: "", avatarURL: "" }
      });
      const updatedUser = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(updatedUser?.error || "Unable to remove photo");
      }
      const mergedUser = mergeSessionPreferences(updatedUser);
      currentUser = mergedUser;
      settingsState.profileImage = updatedUser.profileImage || "";
      settingsState.profileImageOriginal = updatedUser.profileImageOriginal || "";
      settingsState.pendingProfileImage = updatedUser.pendingProfileImage || "";
      settingsState.pendingProfileImageOriginal = updatedUser.pendingProfileImageOriginal || "";
      settingsState.profilePhotoStatus = resolveProfilePhotoStatus(updatedUser);
      persistSession({ user: mergedUser });
      window.updateSessionUser?.(mergedUser);
      applyAvatar(mergedUser);
      updateAvatarRemoveButton(mergedUser);
      updatePhotoReviewStatus(mergedUser);
      updateRequiredFieldMarkers();
      showToast("Profile photo removed.", "ok");
    } catch (err) {
      console.error("Unable to remove profile photo", err);
      showToast(err.message || "Unable to remove photo.", "err");
    } finally {
      removeBtn.textContent = originalLabel;
      updateAvatarRemoveButton(currentUser);
    }
  });
}

function bindAvatarEditing() {
  const editBtn = document.getElementById("editAvatarBtn");
  const attorneyEditBtn = document.getElementById("editAttorneyAvatarBtn");
  const paralegalConfig = avatarUploadConfigs.find((config) => config.frameId === "avatarFrame");
  const attorneyConfig = avatarUploadConfigs.find((config) => config.frameId === "attorneyAvatarFrame");

  if (editBtn && editBtn.dataset.bound !== "true") {
    editBtn.dataset.bound = "true";
    editBtn.addEventListener("click", () => {
      if (paralegalConfig) openExistingPhotoEditor(paralegalConfig);
    });
  }
  if (attorneyEditBtn && attorneyEditBtn.dataset.bound !== "true") {
    attorneyEditBtn.dataset.bound = "true";
    attorneyEditBtn.addEventListener("click", () => {
      if (attorneyConfig) openExistingPhotoEditor(attorneyConfig);
    });
  }
}

async function handleAvatarUpload(config) {
  const input = document.getElementById(config.inputId);
  if (!input) return;

  const file = input.files?.[0];
  if (!file) return;

  if (typeof Cropper !== "undefined" && cropperModal && cropperImage) {
    openPhotoCropper(file, config);
  } else {
    stagePhotoDirect(file, config);
  }
  input.value = "";
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

function initPhotoCropperModal() {
  cropperModal = document.getElementById("photoCropModal");
  cropperImage = document.getElementById("photoCropImage");
  cropperZoom = document.getElementById("photoCropZoom");
  const cancelBtn = document.getElementById("photoCropCancel");
  const saveBtn = document.getElementById("photoCropSave");
  const modalCard = cropperModal?.querySelector(".photo-crop-card");
  if (!cropperModal || !cropperImage || !saveBtn) return;

  cancelBtn?.addEventListener("click", closePhotoCropper);
  modalCard?.addEventListener("mousedown", (event) => event.stopPropagation());
  cropperModal.addEventListener("mousedown", (event) => {
    if (event.target === cropperModal) closePhotoCropper();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && cropperModal.classList.contains("show")) {
      closePhotoCropper();
    }
  });
  if (cropperZoom) {
    cropperZoom.disabled = true;
    cropperZoom.addEventListener("mousedown", () => syncCropperBaseZoom({ resetSlider: true }));
    cropperZoom.addEventListener("touchstart", () => syncCropperBaseZoom({ resetSlider: true }), {
      passive: true,
    });
    cropperZoom.addEventListener("input", () => {
      if (activeCropper) {
        const multiplier = Number(cropperZoom.value);
        activeCropper.zoomTo(cropperBaseZoom * (1 + multiplier));
      }
    });
  }
  saveBtn.addEventListener("click", () => {
    void applyCroppedPhoto();
  });
}

function openPhotoCropper(file, config) {
  if (!cropperModal || !cropperImage) return;
  cropperConfig = config;
  cropperFile = file;
  cropperOriginalFile = file;
  cropperOriginalUrl = "";

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : "";
    if (dataUrl) {
      loadCropperImage(dataUrl, false);
    } else {
      loadCropperImage(URL.createObjectURL(file), true);
    }
  };
  reader.onerror = () => {
    loadCropperImage(URL.createObjectURL(file), true);
  };
  reader.readAsDataURL(file);
}

function openPhotoCropperFromUrl(url, config, isObjectUrl = false, options = {}) {
  if (!cropperModal || !cropperImage) return;
  cropperConfig = config;
  cropperFile = null;
  cropperOriginalFile = null;
  cropperOriginalUrl = options.originalUrl || (!isObjectUrl ? url : "");
  loadCropperImage(url, isObjectUrl);
}

function openExistingPhotoEditor(config) {
  const source = getOriginalPhotoSource(currentUser || {}, { allowPending: true });
  const fallbackUrl = getDisplayProfileImage(currentUser || {}, { allowPending: true });
  const primaryUrl =
    source && source.value && source.value !== DEFAULT_AVATAR_DATA ? source.value : fallbackUrl || "";

  if (!primaryUrl || primaryUrl === DEFAULT_AVATAR_DATA) {
    showToast("Upload the original profile photo to enable editing.", "err");
    return;
  }
  if (source?.type === "file") {
    openPhotoCropper(source.value, config);
    return;
  }

  const openFromBlob = (blob, originalUrl) => {
    const objectUrl = URL.createObjectURL(blob);
    openPhotoCropperFromUrl(objectUrl, config, true, { originalUrl });
  };

  const tryDirect = (targetUrl, allowFallback) => {
    if (targetUrl.startsWith("data:")) {
      openPhotoCropperFromUrl(targetUrl, config, false, { originalUrl: targetUrl });
      return;
    }
    if (targetUrl.startsWith("blob:")) {
      openPhotoCropperFromUrl(targetUrl, config, true, { originalUrl: targetUrl });
      return;
    }
    let fetchOptions = undefined;
    try {
      const parsed = new URL(targetUrl, window.location.href);
      if (parsed.origin === window.location.origin) {
        fetchOptions = { credentials: "include" };
      }
    } catch (_) {
      fetchOptions = { credentials: "include" };
    }
    fetch(targetUrl, fetchOptions)
      .then((res) => {
        if (!res.ok) throw new Error("Unable to load profile photo.");
        return res.blob();
      })
      .then((blob) => openFromBlob(blob, targetUrl))
      .catch(() => {
        if (allowFallback && fallbackUrl && fallbackUrl !== targetUrl) {
          tryDirect(fallbackUrl, false);
          return;
        }
        showToast("Unable to load the original photo. Please re-upload the image.", "err");
      });
  };

  if (primaryUrl.startsWith("data:") || primaryUrl.startsWith("blob:")) {
    openPhotoCropperFromUrl(primaryUrl, config, primaryUrl.startsWith("blob:"), { originalUrl: primaryUrl });
    return;
  }

  const originalUrl = source?.value || fallbackUrl || "";
  const allowFallback = Boolean(source?.value && fallbackUrl && fallbackUrl !== primaryUrl);
  secureFetch("/api/uploads/profile-photo/original")
    .then((res) => {
      if (!res.ok) throw new Error("Unable to load profile photo.");
      return res.blob();
    })
    .then((blob) => openFromBlob(blob, originalUrl || primaryUrl))
    .catch(() => {
      tryDirect(primaryUrl, allowFallback);
    });
}

function loadCropperImage(url, isObjectUrl) {
  if (!cropperModal || !cropperImage) return;
  if (cropperZoom) {
    cropperZoom.disabled = true;
  }
  if (cropperObjectUrl) {
    URL.revokeObjectURL(cropperObjectUrl);
    cropperObjectUrl = null;
  }
  if (isObjectUrl) cropperObjectUrl = url;
  cropperModal.classList.add("show");
  cropperModal.setAttribute("aria-hidden", "false");
  if (activeCropper) {
    activeCropper.destroy();
    activeCropper = null;
  }
  cropperImage.onload = () => {
    activeCropper = new Cropper(cropperImage, {
      aspectRatio: 1,
      viewMode: 1,
      dragMode: "move",
      autoCropArea: 1,
      background: false,
      guides: false,
      center: false,
      cropBoxMovable: false,
      cropBoxResizable: false,
      responsive: true,
      zoomOnWheel: true,
      zoomOnTouch: true,
      ready() {
        requestAnimationFrame(() => syncCropperBaseZoom({ resetSlider: true }));
        if (cropperZoom) cropperZoom.disabled = false;
      },
      zoom() {
        if (!cropperZoom) return;
        if (cropperZoomLock) return;
        const data = this.getImageData();
        const currentZoom = data.naturalWidth ? data.width / data.naturalWidth : 1;
        const relative = cropperBaseZoom ? currentZoom / cropperBaseZoom - 1 : 0;
        const clamped = Math.min(0.5, Math.max(0, relative));
        cropperZoom.value = String(clamped);
      },
    });
    if (cropperZoom) {
      cropperZoom.disabled = false;
    }
  };
  cropperImage.src = url;
}

function closePhotoCropper() {
  if (!cropperModal) return;
  cropperModal.classList.remove("show");
  cropperModal.setAttribute("aria-hidden", "true");
  destroyPhotoCropper();
}

function destroyPhotoCropper() {
  if (activeCropper) {
    activeCropper.destroy();
    activeCropper = null;
  }
  if (cropperImage) cropperImage.src = "";
  if (cropperZoom) {
    cropperZoom.value = "1";
    cropperZoom.disabled = true;
  }
  cropperBaseZoom = 1;
  if (cropperObjectUrl) {
    URL.revokeObjectURL(cropperObjectUrl);
    cropperObjectUrl = null;
  }
  cropperConfig = null;
  cropperFile = null;
  cropperOriginalFile = null;
  cropperOriginalUrl = "";
}

async function applyCroppedPhoto() {
  if (!activeCropper || !cropperConfig) return;
  const preview = document.getElementById(cropperConfig.previewId);
  const initials = document.getElementById(cropperConfig.initialsId);
  const frame = document.getElementById(cropperConfig.frameId);
  const canvas = activeCropper.getCroppedCanvas({
    width: 600,
    height: 600,
    imageSmoothingQuality: "high",
  });
  if (!canvas) return;

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) return;
  const name = cropperFile?.name ? cropperFile.name.replace(/\.[^.]+$/, ".jpg") : "profile-photo.jpg";
  const file = new File([blob], name, { type: "image/jpeg" });
  const previewUrl = canvas.toDataURL("image/jpeg", 0.92);

  updateAvatarPreview(preview, frame, initials, previewUrl);
  settingsState.stagedProfilePhotoFile = file;
  settingsState.stagedProfilePhotoUrl = previewUrl;
  if (settingsState.stagedProfilePhotoOriginalUrl?.startsWith("blob:") && settingsState.stagedProfilePhotoOriginalUrl !== cropperOriginalUrl) {
    URL.revokeObjectURL(settingsState.stagedProfilePhotoOriginalUrl);
  }
  if (cropperOriginalFile) {
    settingsState.stagedProfilePhotoOriginalFile = cropperOriginalFile;
    settingsState.stagedProfilePhotoOriginalUrl = "";
  } else if (cropperOriginalUrl) {
    settingsState.stagedProfilePhotoOriginalFile = null;
    settingsState.stagedProfilePhotoOriginalUrl = cropperOriginalUrl;
  } else {
    settingsState.stagedProfilePhotoOriginalFile = null;
    settingsState.stagedProfilePhotoOriginalUrl = "";
  }
  applyAvatar(currentUser || {});
  updateAvatarRemoveButton(currentUser || {});
  updatePhotoReviewStatus(currentUser || {});
  updateRequiredFieldMarkers();
  closePhotoCropper();
}

function stagePhotoDirect(file, config) {
  const preview = document.getElementById(config.previewId);
  const initials = document.getElementById(config.initialsId);
  const frame = document.getElementById(config.frameId);
  if (!preview || !frame) return;

  if (settingsState.stagedProfilePhotoUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(settingsState.stagedProfilePhotoUrl);
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : "";
    const previewUrl = dataUrl || URL.createObjectURL(file);
    updateAvatarPreview(preview, frame, initials, previewUrl);
    settingsState.stagedProfilePhotoFile = file;
    settingsState.stagedProfilePhotoUrl = previewUrl;
    if (settingsState.stagedProfilePhotoOriginalUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(settingsState.stagedProfilePhotoOriginalUrl);
    }
    settingsState.stagedProfilePhotoOriginalFile = file;
    settingsState.stagedProfilePhotoOriginalUrl = "";
    applyAvatar(currentUser || {});
    updateAvatarRemoveButton(currentUser || {});
    updatePhotoReviewStatus(currentUser || {});
    updateRequiredFieldMarkers();
  };
  reader.onerror = () => {
    const fallbackUrl = URL.createObjectURL(file);
    updateAvatarPreview(preview, frame, initials, fallbackUrl);
    settingsState.stagedProfilePhotoFile = file;
    settingsState.stagedProfilePhotoUrl = fallbackUrl;
    if (settingsState.stagedProfilePhotoOriginalUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(settingsState.stagedProfilePhotoOriginalUrl);
    }
    settingsState.stagedProfilePhotoOriginalFile = file;
    settingsState.stagedProfilePhotoOriginalUrl = "";
    applyAvatar(currentUser || {});
    updateAvatarRemoveButton(currentUser || {});
    updatePhotoReviewStatus(currentUser || {});
    updateRequiredFieldMarkers();
  };
  reader.readAsDataURL(file);
}

async function uploadProfilePhotoFile(file, originalFile) {
  const formData = new FormData();
  formData.append("file", file, file.name || "avatar.png");
  if (originalFile) {
    formData.append("original", originalFile, originalFile.name || "profile-original.png");
  }

  const res = await fetch("/api/uploads/profile-photo", {
    method: "POST",
    body: formData,
    credentials: "include"
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Upload failed");
  }
  return payload;
}

document.addEventListener("DOMContentLoaded", initAvatarUploaders);

async function saveProfile() {
  const saveBtn = document.getElementById("profileSaveBtn");
  const originalLabel = saveBtn?.textContent || "Save changes";
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
  }
  try {
    await saveSettings();
  } catch (err) {
    console.error("Profile save failed", err);
    showToast(err?.message || "Unable to save settings right now.", "err");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  }
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

  // Clear client auth (preserve non-auth keys like tour flags)
  ["lpc_user", "lpc_token", "token", "auth_token", "LPC_JWT", "lpc_jwt"].forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {}
    try {
      sessionStorage.removeItem(key);
    } catch {}
  });

  // Backend logout (if applicable)
  fetch("/api/auth/logout", { credentials: "include" })
    .finally(() => {
      window.location.href = "/login.html";
    });
};
