(function () {
  const DISABLED_ERROR = "This account has been deactivated.";
  const DISABLED_MSG_KEY = "disabledAccountMsg";
  let hasRedirected = false;
  let nukedOnRedirect = false;
  let cachedUser = null;
  let sessionPromise = null;
  let sessionGeneration = 0;
  let lastSessionFailure = null;
  const LEGACY_TOKEN_KEYS = ["lpc_token", "token", "auth_token", "LPC_JWT", "lpc_jwt"];
  const VALID_THEMES = ["light", "dark"];
  const THEME_CLASSES_TO_CLEAR = ["theme-light", "theme-dark"];
  const FONT_SIZE_MAP = {
    xs: "15px",
    sm: "16px",
    md: "17px",
    lg: "20px",
    xl: "22px"
  };
  let currentFontSize = null;

  function projectSessionUser(user) {
    if (!user || typeof user !== "object" || Array.isArray(user)) return null;
    const snapshot = {};
    const id = typeof (user.id || user._id) === "string" ? String(user.id || user._id) : "";
    if (id) snapshot.id = id;
    if (typeof user.role === "string") snapshot.role = user.role;
    if (typeof user.status === "string") snapshot.status = user.status;
    if (typeof user.firstName === "string") snapshot.firstName = user.firstName;
    if (typeof user.lastName === "string") snapshot.lastName = user.lastName;
    if (typeof user.name === "string") snapshot.name = user.name;
    if (typeof user.avatarURL === "string") snapshot.avatarURL = user.avatarURL;
    if (typeof user.profileImage === "string") snapshot.profileImage = user.profileImage;
    if (typeof user.pendingProfileImage === "string") snapshot.pendingProfileImage = user.pendingProfileImage;
    if (typeof user.profilePhotoStatus === "string") snapshot.profilePhotoStatus = user.profilePhotoStatus;
    if (typeof user.disabled === "boolean") snapshot.disabled = user.disabled;
    if (typeof user.deleted === "boolean") snapshot.deleted = user.deleted;
    if (typeof user.isFirstLogin === "boolean") snapshot.isFirstLogin = user.isFirstLogin;

    const preferences = {};
    if (typeof user.preferences?.theme === "string") {
      preferences.theme = normalizeTheme(user.preferences.theme);
    }
    if (typeof user.preferences?.fontSize === "string") preferences.fontSize = user.preferences.fontSize;
    if (Object.keys(preferences).length) snapshot.preferences = preferences;

    const onboarding = {};
    if (typeof user.onboarding?.paralegalTourCompleted === "boolean") onboarding.paralegalTourCompleted = user.onboarding.paralegalTourCompleted;
    if (typeof user.onboarding?.paralegalProfileTourCompleted === "boolean") onboarding.paralegalProfileTourCompleted = user.onboarding.paralegalProfileTourCompleted;
    if (typeof user.onboarding?.attorneyTourCompleted === "boolean") onboarding.attorneyTourCompleted = user.onboarding.attorneyTourCompleted;
    if (typeof user.onboarding?.attorneyProfileCompleted === "boolean") onboarding.attorneyProfileCompleted = user.onboarding.attorneyProfileCompleted;
    if (Object.keys(onboarding).length) snapshot.onboarding = onboarding;
    return snapshot;
  }

  function sanitizeStoredSessionSnapshot() {
    try {
      const raw = localStorage.getItem("lpc_user");
      if (raw) {
        const snapshot = projectSessionUser(JSON.parse(raw));
        if (snapshot && Object.keys(snapshot).length) {
          const next = JSON.stringify(snapshot);
          if (next !== raw) localStorage.setItem("lpc_user", next);
        } else {
          localStorage.removeItem("lpc_user");
        }
      }
      localStorage.removeItem("avatarURL");
    } catch (_) {
      try {
        localStorage.removeItem("lpc_user");
        localStorage.removeItem("avatarURL");
      } catch (_) {}
    }
  }

  sanitizeStoredSessionSnapshot();

  const earlyTheme = (() => {
    try {
      const raw = localStorage.getItem("lpc_user");
      if (!raw) return null;
      const stored = JSON.parse(raw);
      const theme = String(stored?.preferences?.theme || "").toLowerCase();
      const fontSize = String(stored?.preferences?.fontSize || "").toLowerCase();
      const hasUser = !!(stored?.id || stored?._id || stored?.email || stored?.role);
      const normalizedTheme = normalizeTheme(theme);
      return { classes: [`theme-${normalizedTheme}`], fontSize, theme: normalizedTheme, hasUser };
    } catch (_) {
      return null;
    }
  })();

  function applyThemeClasses(node, classes) {
    if (!node) return;
    THEME_CLASSES_TO_CLEAR.forEach((className) => node.classList.remove(className));
    (classes || []).forEach((cls) => node.classList.add(cls));
  }

  if (earlyTheme) {
    if (earlyTheme.hasUser) {
      document.documentElement.classList.add("has-user-cache");
    }
    applyThemeClasses(document.documentElement, earlyTheme.classes);
    if (earlyTheme.fontSize && FONT_SIZE_MAP[earlyTheme.fontSize]) {
      document.documentElement.style.fontSize = FONT_SIZE_MAP[earlyTheme.fontSize];
    }
    if (document.body) {
      applyThemeClasses(document.body, earlyTheme.classes);
    } else if (document.documentElement) {
      const observer = new MutationObserver(() => {
        if (document.body) {
          applyThemeClasses(document.body, earlyTheme.classes);
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function normalizeTheme(value) {
    const candidate = String(value || "").toLowerCase();
    if (VALID_THEMES.includes(candidate)) return candidate;
    return /dark$/i.test(candidate) ? "dark" : "light";
  }

  function applyClassToBody(classNames) {
    const classes = Array.isArray(classNames) ? classNames : [classNames];
    const targets = [];
    if (document.body) targets.push(document.body);
    if (document.documentElement) targets.push(document.documentElement);
    targets.forEach((node) => {
      THEME_CLASSES_TO_CLEAR.forEach((className) => node.classList.remove(className));
      classes.forEach((value) => {
        if (value) node.classList.add(value);
      });
    });
  }

  function getThemeClasses(theme) {
    return [`theme-${theme}`];
  }

  function setThemeClass(theme) {
    const normalized = normalizeTheme(theme);
    const classNames = getThemeClasses(normalized);
    if (document.body) {
      applyClassToBody(classNames);
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          applyClassToBody(classNames);
        },
        { once: true }
      );
    }
    applyThemeOverrides();
    return normalized;
  }

  function applyThemeOverrides() {
    const apply = () => {
      const body = document.body;
      const root = document.documentElement;
      if (!body || !root) return;
      body.style.removeProperty("--bg");
      root.style.removeProperty("--bg");
      body.style.removeProperty("--app-background");
      root.style.removeProperty("--app-background");
    };

    if (document.body) {
      apply();
    } else {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    }
  }

  function applyThemePreference(theme) {
    const normalized = setThemeClass(theme);
    if (cachedUser) {
      cachedUser.preferences = { ...(cachedUser.preferences || {}), theme: normalized };
      persistStoredUser(cachedUser);
    }
    return normalized;
  }

  function normalizeFontSize(value) {
    const key = String(value || "").toLowerCase();
    return FONT_SIZE_MAP[key] ? key : "md";
  }

  function applyFontSizePreference(fontSize) {
    const normalized = normalizeFontSize(fontSize);
    if (currentFontSize === normalized) return normalized;
    const size = FONT_SIZE_MAP[normalized] || FONT_SIZE_MAP.md;
    if (document.documentElement) {
      document.documentElement.style.fontSize = size;
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          if (document.documentElement) {
            document.documentElement.style.fontSize = size;
          }
        },
        { once: true }
      );
    }
    currentFontSize = normalized;
    if (cachedUser) {
      cachedUser.preferences = { ...(cachedUser.preferences || {}), fontSize: normalized };
      persistStoredUser(cachedUser);
    }
    return normalized;
  }

  function applyThemeFromUser(user) {
    const theme = user?.preferences?.theme;
    if (theme) applyThemePreference(theme);
  }

  function applyFontSizeFromUser(user) {
    const fontSize = user?.preferences?.fontSize;
    if (fontSize) applyFontSizePreference(fontSize);
  }

  function redirectToLogin() {
    if (hasRedirected) return;
    if (isLoginPage()) return;
    hasRedirected = true;
    try {
      window.location.href = `login.html?next=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`;
    } catch (_) {}
  }

  function isLoginPage() {
    if (typeof window === "undefined") return false;
    const path = String(window.location?.pathname || "").toLowerCase();
    const href = String(window.location?.href || "").toLowerCase();
    return path.endsWith("/login.html") || path.endsWith("login.html") || href.includes("login.html");
  }

  async function clearServerSession() {
    try {
      const csrfResponse = await fetch("/api/csrf", { credentials: "include" });
      const payload = await csrfResponse.json().catch(() => ({}));
      const csrfToken = csrfResponse.ok ? String(payload?.csrfToken || "") : "";
      if (!csrfToken) return false;
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrfToken },
      });
      return response.ok;
    } catch (_) {
      return false;
    }
  }

  function rememberDisabled(message) {
    try {
      sessionStorage.setItem(DISABLED_MSG_KEY, message || DISABLED_ERROR);
    } catch (_) {}
  }

  function isDisabledAccountMessage(message) {
    return /account has been (disabled|deactivated)/i.test(String(message || ""));
  }

  function handleDisabledAccount(message) {
    rememberDisabled(message);
    void clearServerSession();
    invalidateAndRedirect();
  }

  function shouldPreserveStoredSession() {
    return lastSessionFailure === "network" || lastSessionFailure === "server";
  }

  async function fetchSession(force = false) {
    if (force) {
      sessionGeneration += 1;
      sessionPromise = null;
    }
    if (!sessionPromise) {
      const requestGeneration = ++sessionGeneration;
      sessionPromise = fetch("/api/auth/me", { credentials: "include" })
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const message = payload?.error || payload?.msg;
            if (isDisabledAccountMessage(message)) {
              handleDisabledAccount(message || DISABLED_ERROR);
              lastSessionFailure = "disabled";
              return null;
            }
            if (
              res.status === 401 ||
              (res.status === 403 && /session expired|invalid token|not authenticated/i.test(String(message || "")))
            ) {
              lastSessionFailure = "unauthorized";
              return null;
            }
            lastSessionFailure = "server";
            return payload?.user || null;
          }
          lastSessionFailure = null;
          return payload?.user || null;
        })
        .catch(() => {
          lastSessionFailure = "network";
          return null;
        })
        .then((user) => {
          if (requestGeneration !== sessionGeneration) return null;
          let resolvedUser = user;
          if (!resolvedUser && shouldPreserveStoredSession()) {
            resolvedUser = readStoredUserRaw();
          }
          const storedSnapshot = readStoredUserRaw();
          const mergedUser = mergeStoredUser(storedSnapshot, resolvedUser);
          cachedUser = mergedUser;
          syncStoredUser(mergedUser);
          applyThemeFromUser(mergedUser);
          applyFontSizeFromUser(mergedUser);
          try {
            const avatarSrc =
              resolvedUser?.pendingProfileImage ||
              resolvedUser?.profileImage ||
              resolvedUser?.avatarURL ||
              "assets/avatar-placeholder.svg";
            const avatarNodes = document.querySelectorAll("[data-avatar]");
            avatarNodes.forEach((el) => {
              if (el) el.src = avatarSrc;
            });
          } catch (_) {}
          return resolvedUser;
        });
    }
    return sessionPromise;
  }

  function getCachedUser() {
    return cachedUser;
  }

  function clearStoredSession() {
    sessionGeneration += 1;
    cachedUser = null;
    sessionPromise = null;
    try {
      localStorage.removeItem("lpc_user");
      localStorage.removeItem("avatarURL");
    } catch (_) {}
    ["lpc-support-context", "lpc_support_session_user", "lpc_support_drawer_pin"].forEach((key) => {
      try {
        sessionStorage.removeItem(key);
      } catch (_) {}
    });
    LEGACY_TOKEN_KEYS.forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
      try {
        sessionStorage.removeItem(key);
      } catch (_) {}
    });
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== "lpc_user" || event.newValue || !event.oldValue) return;
    sessionGeneration += 1;
    cachedUser = null;
    sessionPromise = null;
    redirectToLogin();
  });

  function reauthorizeVisibleSession(source) {
    fetchSession(true).then((user) => {
      if (!user && !shouldPreserveStoredSession()) invalidateAndRedirect();
    }).catch((error) => {
      console.warn(`[session] ${source} reauthorization failed`, error);
    });
  }

  window.addEventListener("lpc:lifecycle-refresh", () => {
    if (document.visibilityState !== "visible") return;
    reauthorizeVisibleSession("lifecycle");
  });

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    reauthorizeVisibleSession("pageshow");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    reauthorizeVisibleSession("visibility");
  });

  function invalidateAndRedirect() {
    if (!nukedOnRedirect) {
      nukedOnRedirect = true;
      clearStoredSession();
    }
    redirectToLogin();
  }

  async function getSessionData(force = false) {
    const user = await fetchSession(force);
    const role = String(user?.role || "").toLowerCase();
    const status = String(user?.status || "").toLowerCase();
    return { user, role, status };
  }

  async function checkSession(expectedRole, options = {}) {
    const { redirectOnFail = true } = options;
    let sessionData;
    try {
      sessionData = await getSessionData();
    } catch (err) {
      if (redirectOnFail) invalidateAndRedirect();
      throw err;
    }
    const { user, role, status } = sessionData;
    const normalizedRole = String(role || "").toLowerCase();
    if (!user) {
      if (redirectOnFail) invalidateAndRedirect();
      throw new Error("Authentication required");
    }
    if (user?.disabled) {
      if (redirectOnFail) handleDisabledAccount(DISABLED_ERROR);
      throw new Error(DISABLED_ERROR);
    }
    if (expectedRole && normalizedRole !== String(expectedRole).toLowerCase()) {
      if (redirectOnFail) invalidateAndRedirect();
      throw new Error("Forbidden");
    }
    if (status && status !== "approved") {
      if (redirectOnFail) invalidateAndRedirect();
      throw new Error("Not approved");
    }
    nukedOnRedirect = false;
    return { user, role: normalizedRole, status };
  }

  function redirectUserDashboard(roleOverride) {
    const roleValue = roleOverride || cachedUser?.role || "attorney";
    const norm = String(roleValue).toLowerCase();
    const target = norm === "admin"
        ? "admin-dashboard.html"
        : norm === "director"
        ? "director-portal.html"
        : norm === "paralegal"
        ? "dashboard-paralegal.html"
        : "dashboard-attorney.html";
    try {
      window.location.href = target;
    } catch (_) {}
  }

  async function refreshSession(expectedRole) {
    try {
      return await checkSession(expectedRole);
    } catch {
      return null;
    }
  }

  function updateSessionUser(user) {
    if (!user || typeof user !== "object") return;
    cachedUser = { ...(cachedUser || {}), ...user };
    applyThemeFromUser(cachedUser);
    applyFontSizeFromUser(cachedUser);
    sessionPromise = Promise.resolve(cachedUser);
    persistStoredUser(cachedUser);
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      try {
        window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: cachedUser }));
      } catch (_) {}
    }
  }

  function readStoredUserRaw() {
    try {
      const raw = localStorage.getItem("lpc_user");
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function normalizeUserId(user) {
    return String(user?.id || user?._id || "");
  }

  function normalizeRole(user) {
    return String(user?.role || "").toLowerCase();
  }

  function mergeStoredUser(stored, serverUser) {
    if (!stored) return serverUser;
    if (!serverUser) return stored;
    const merged = { ...stored, ...serverUser };
    if (stored.preferences || serverUser.preferences) {
      merged.preferences = { ...(stored.preferences || {}), ...(serverUser.preferences || {}) };
    }
    if (typeof serverUser.isFirstLogin !== "boolean" && typeof stored.isFirstLogin === "boolean") {
      merged.isFirstLogin = stored.isFirstLogin;
    }
    return merged;
  }

  function persistStoredUser(user) {
    try {
      if (user) {
        const snapshot = projectSessionUser(user);
        if (snapshot && Object.keys(snapshot).length) {
          const payload = JSON.stringify(snapshot);
          if (localStorage.getItem("lpc_user") !== payload) localStorage.setItem("lpc_user", payload);
        } else if (localStorage.getItem("lpc_user")) {
          localStorage.removeItem("lpc_user");
        }
      } else if (localStorage.getItem("lpc_user")) {
        localStorage.removeItem("lpc_user");
      }
    } catch (_) {}
  }

  function syncStoredUser(serverUser) {
    const stored = readStoredUserRaw();
    if (!serverUser) {
      if (stored) persistStoredUser(null);
      return;
    }
    const next = projectSessionUser(serverUser);
    const changed = JSON.stringify(stored || null) !== JSON.stringify(next || null);
    persistStoredUser(serverUser);
    if (!stored) return;
    const sameId = normalizeUserId(stored) === normalizeUserId(serverUser);
    const sameRole = normalizeRole(stored) === normalizeRole(serverUser);
    if (!sameId || !sameRole || changed) {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        try {
          window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: serverUser }));
        } catch (_) {}
      }
    }
  }

  if (!isLoginPage()) {
    fetchSession().catch((error) => console.warn("[session] background session refresh rejected", error));
  }

  window.checkSession = checkSession;
  window.redirectUserDashboard = redirectUserDashboard;
  window.clearStoredSession = clearStoredSession;
  window.getSessionData = getSessionData;
  window.getStoredUser = getCachedUser;
  window.refreshSession = refreshSession;
  window.updateSessionUser = updateSessionUser;
  window.projectSessionUser = projectSessionUser;
  window.applyThemePreference = applyThemePreference;
  window.getThemePreference = () => cachedUser?.preferences?.theme || null;
  window.applyFontSizePreference = applyFontSizePreference;
  window.getFontSizePreference = () => cachedUser?.preferences?.fontSize || null;

  function updateHeaderBasedOnAuth(isLoggedIn) {
    document.querySelectorAll("[data-authed-only]").forEach((el) => {
      el.style.display = isLoggedIn ? "" : "none";
    });
    document.querySelectorAll("[data-public-only]").forEach((el) => {
      el.style.display = isLoggedIn ? "none" : "";
    });
  }

  async function runHeaderGuard() {
    const headerRoot = document.getElementById("mainHeader");
    if (!headerRoot) return;
    headerRoot.style.visibility = "hidden";
    let authed = false;
    try {
      await checkSession(undefined, { redirectOnFail: false });
      authed = true;
    } catch (error) {
      console.debug("[session] public header authentication probe failed", error);
    }
    updateHeaderBasedOnAuth(authed);
    headerRoot.style.visibility = "visible";
  }

  document.addEventListener("DOMContentLoaded", () => {
    runHeaderGuard();
  });

  window.updateHeaderBasedOnAuth = updateHeaderBasedOnAuth;

  async function requireRole(expectedRole) {
    try {
      const session = await checkSession(undefined, { redirectOnFail: true });
      const user = session?.user || session;
      if (!user) throw new Error("Not logged-in");
      const normalizedRole = String(user.role || session?.role || "").toLowerCase();
      if (!user.role && normalizedRole) {
        user.role = normalizedRole;
      }
      const normalizedExpected = expectedRole ? String(expectedRole).toLowerCase() : "";
      if (normalizedExpected && normalizedRole !== normalizedExpected) {
        redirectToRole(normalizedRole);
        return null;
      }
      const protectedRoot = document.getElementById("protectedContent");
      if (protectedRoot) {
        protectedRoot.style.visibility = "visible";
      }
      return user;
    } catch (error) {
      redirectToLogin();
      return null;
    }
  }

  function redirectToRole(role) {
    if (role === "attorney") {
      window.location.href = "dashboard-attorney.html";
    } else if (role === "paralegal") {
      window.location.href = "dashboard-paralegal.html";
    } else if (role === "admin") {
      window.location.href = "admin-dashboard.html";
    } else if (role === "director") {
      window.location.href = "director-portal.html";
    } else {
      window.location.href = "login.html";
    }
  }

  window.requireRole = requireRole;
})();

import("../web-vitals-rum.js").catch((error) => console.warn("[performance] RUM module failed to load", error));
