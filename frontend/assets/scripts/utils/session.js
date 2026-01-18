(function () {
  const DISABLED_ERROR = "This account has been disabled.";
  const DISABLED_MSG_KEY = "disabledAccountMsg";
  let hasRedirected = false;
  let nukedOnRedirect = false;
  let cachedUser = null;
  let sessionPromise = null;
  let cachedSessionToken = null;
  let lastSessionFailure = null;
  const LEGACY_TOKEN_KEYS = ["lpc_token", "token", "auth_token", "LPC_JWT", "lpc_jwt"];
  const VALID_THEMES = ["light", "dark", "mountain", "mountain-dark"];
  const FONT_SIZE_MAP = {
    xs: "14px",
    sm: "15px",
    md: "16px",
    lg: "17px",
    xl: "20px"
  };
  const MOUNTAIN_BG = "#f8f6f1";
  let currentTheme = null;
  let currentFontSize = null;

  function normalizeTheme(value) {
    const candidate = String(value || "").toLowerCase();
    return VALID_THEMES.includes(candidate) ? candidate : "mountain";
  }

  function applyClassToBody(classNames) {
    const classes = Array.isArray(classNames) ? classNames : [classNames];
    const targets = [];
    if (document.body) targets.push(document.body);
    if (document.documentElement) targets.push(document.documentElement);
    targets.forEach((node) => {
      VALID_THEMES.forEach((theme) => node.classList.remove(`theme-${theme}`));
      classes.forEach((value) => {
        if (value) node.classList.add(value);
      });
    });
  }

  function getThemeClasses(theme) {
    if (theme === "mountain-dark") return ["theme-mountain-dark", "theme-dark"];
    return [`theme-${theme}`];
  }

  function setThemeClass(theme) {
    const normalized = normalizeTheme(theme);
    if (currentTheme === normalized) return normalized;
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
    currentTheme = normalized;
    applyThemeOverrides(normalized);
    return normalized;
  }

  function applyThemeOverrides(theme) {
    const apply = () => {
      const body = document.body;
      const root = document.documentElement;
      if (!body || !root) return;
      if (theme === "mountain") {
        body.style.setProperty("--bg", MOUNTAIN_BG);
        root.style.setProperty("--bg", MOUNTAIN_BG);
        body.style.setProperty("--app-background", MOUNTAIN_BG);
        root.style.setProperty("--app-background", MOUNTAIN_BG);
      } else {
        body.style.removeProperty("--bg");
        root.style.removeProperty("--bg");
        body.style.removeProperty("--app-background");
        root.style.removeProperty("--app-background");
      }
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
      try {
        localStorage.setItem("lpc_user", JSON.stringify(cachedUser));
      } catch (_) {}
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
      try {
        localStorage.setItem("lpc_user", JSON.stringify(cachedUser));
      } catch (_) {}
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
      window.location.href = "login.html";
    } catch (_) {}
  }

  function isLoginPage() {
    if (typeof window === "undefined") return false;
    const path = String(window.location?.pathname || "").toLowerCase();
    const href = String(window.location?.href || "").toLowerCase();
    return path.endsWith("/login.html") || path.endsWith("login.html") || href.includes("login.html");
  }

  function clearServerSession() {
    try {
      fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (_) {}
  }

  function rememberDisabled(message) {
    try {
      sessionStorage.setItem(DISABLED_MSG_KEY, message || DISABLED_ERROR);
    } catch (_) {}
  }

  function handleDisabledAccount(message) {
    rememberDisabled(message);
    clearServerSession();
    invalidateAndRedirect();
  }

  function shouldPreserveStoredSession() {
    return lastSessionFailure === "network" || lastSessionFailure === "server";
  }

  async function fetchSession(force = false) {
    if (force) sessionPromise = null;
    if (!sessionPromise) {
      sessionPromise = fetch("/api/auth/me", { credentials: "include" })
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const message = payload?.error || payload?.msg;
            if (message === DISABLED_ERROR) {
              handleDisabledAccount(message);
              lastSessionFailure = "disabled";
              return null;
            }
            if (res.status === 401) {
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
          if (typeof document !== "undefined") {
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", () => injectBetaFooter(resolvedUser), { once: true });
            } else {
              injectBetaFooter(resolvedUser);
            }
          }
          try {
            if (resolvedUser?.avatarURL) {
              localStorage.setItem("avatarURL", resolvedUser.avatarURL);
            }
            const avatarNodes = document.querySelectorAll("[data-avatar]");
            avatarNodes.forEach((el) => {
              if (el) el.src = resolvedUser?.avatarURL || "assets/default-avatar.png";
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
    cachedUser = null;
    sessionPromise = null;
    cachedSessionToken = null;
    try {
      localStorage.removeItem("lpc_user");
    } catch (_) {}
    LEGACY_TOKEN_KEYS.forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
      try {
        sessionStorage.removeItem(key);
      } catch (_) {}
    });
  }

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
    const target =
      norm === "admin"
        ? "admin-dashboard.html"
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

  function readLegacyToken() {
    for (const key of LEGACY_TOKEN_KEYS) {
      try {
        const value = localStorage.getItem(key) || sessionStorage.getItem(key);
        if (value) return value;
      } catch (_) {}
    }
    return "";
  }

  function readStoredUser() {
    if (cachedUser) return cachedUser;
    try {
      const raw = localStorage.getItem("lpc_user");
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
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

  const BETA_FOOTER_STYLE_ID = "lpc-beta-footer-style";

  function ensureBetaFooterStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById(BETA_FOOTER_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BETA_FOOTER_STYLE_ID;
    style.textContent = `
      .sidebar-footer{display:flex;flex-direction:column;align-items:center;}
      .sidebar-footer .beta-footer{display:flex;align-items:center;justify-content:center;width:100%;gap:6px;font-size:0.82rem;color:var(--muted);letter-spacing:0.08em;margin-bottom:8px;font-weight:400;}
      .sidebar-footer .beta-pill{padding:0;border:none;border-radius:0;font-size:0.8rem;letter-spacing:0.12em;font-weight:400;}
      .sidebar-footer .beta-sep{font-size:0.7rem;letter-spacing:0;opacity:0.6;line-height:1;}
      .sidebar-footer .beta-link{color:var(--muted);text-decoration:none;border-bottom:1px solid transparent;font-size:0.82rem;letter-spacing:0.08em;font-weight:400;}
      .sidebar-footer .beta-link:hover{border-bottom-color:currentColor;}
    `;
    document.head.appendChild(style);
  }

  function buildBugReportLink() {
    const subject = encodeURIComponent("Report an Issue");
    const body = encodeURIComponent(
      "What happened?\n\nWhat did you expect?\n\n(Optional) Page or feature:"
    );
    return `mailto:support@lets-paraconnect.com?subject=${subject}&body=${body}`;
  }

  function injectBetaFooter(user) {
    if (!user || typeof document === "undefined") return;
    const footers = document.querySelectorAll(".sidebar-footer");
    if (!footers.length) return;
    ensureBetaFooterStyles();
    const href = buildBugReportLink();
    footers.forEach((footer) => {
      if (footer.querySelector(".beta-footer")) return;
      const wrap = document.createElement("div");
      wrap.className = "beta-footer";
      const pill = document.createElement("span");
      pill.className = "beta-pill";
      pill.textContent = "Beta";
      const sep = document.createElement("span");
      sep.className = "beta-sep";
      sep.textContent = "•";
      const link = document.createElement("a");
      link.className = "beta-link";
      link.href = href;
      link.textContent = "Report an Issue";
      link.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      wrap.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      wrap.appendChild(pill);
      wrap.appendChild(sep);
      wrap.appendChild(link);
      footer.prepend(wrap);
    });
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
        localStorage.setItem("lpc_user", JSON.stringify(user));
      } else {
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
    if (!stored) {
      persistStoredUser(serverUser);
      return;
    }
    const sameId = normalizeUserId(stored) === normalizeUserId(serverUser);
    const sameRole = normalizeRole(stored) === normalizeRole(serverUser);
    if (!sameId || !sameRole) {
      persistStoredUser(serverUser);
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        try {
          window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: serverUser }));
        } catch (_) {}
      }
    }
  }

  function getSessionToken() {
    if (cachedSessionToken) return cachedSessionToken;
    const legacy = readLegacyToken();
    if (legacy) {
      cachedSessionToken = legacy;
      return cachedSessionToken;
    }
    const user = readStoredUser();
    if (user?.id || user?._id) {
      cachedSessionToken = "__cookie_session__";
      return cachedSessionToken;
    }
    return "";
  }

  fetchSession().catch(() => {});

  window.checkSession = checkSession;
  window.redirectUserDashboard = redirectUserDashboard;
  window.clearStoredSession = clearStoredSession;
  window.getSessionToken = getSessionToken;
  window.getSessionData = getSessionData;
  window.getStoredUser = getCachedUser;
  window.refreshSession = refreshSession;
  window.updateSessionUser = updateSessionUser;
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
    } catch {}
    updateHeaderBasedOnAuth(authed);
    headerRoot.style.visibility = "visible";
  }

  document.addEventListener("DOMContentLoaded", () => {
    runHeaderGuard();
  });

  window.updateHeaderBasedOnAuth = updateHeaderBasedOnAuth;

  async function requireRole(expectedRole) {
    try {
      const session = await checkSession(undefined, { redirectOnFail: false });
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
    } catch {
      window.location.href = "login.html";
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
    } else {
      window.location.href = "login.html";
    }
  }

  window.requireRole = requireRole;
})();
