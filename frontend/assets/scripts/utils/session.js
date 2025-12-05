(function () {
  const DISABLED_ERROR = "This account has been disabled.";
  const DISABLED_MSG_KEY = "disabledAccountMsg";
  let hasRedirected = false;
  let nukedOnRedirect = false;
  let cachedUser = null;
  let sessionPromise = null;

  function redirectToLogin() {
    if (hasRedirected) return;
    hasRedirected = true;
    try {
      window.location.href = "login.html";
    } catch (_) {}
  }

  function rememberDisabled(message) {
    try {
      sessionStorage.setItem(DISABLED_MSG_KEY, message || DISABLED_ERROR);
    } catch (_) {}
  }

  function handleDisabledAccount(message) {
    rememberDisabled(message);
    invalidateAndRedirect();
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
              return null;
            }
            if (res.status === 401) return null;
            return payload?.user || null;
          }
          return payload?.user || null;
        })
        .catch(() => null)
        .then((user) => {
          cachedUser = user;
          try {
            if (user?.avatarURL) {
              localStorage.setItem("avatarURL", user.avatarURL);
            }
            const avatarNodes = document.querySelectorAll("[data-avatar]");
            avatarNodes.forEach((el) => {
              if (el) el.src = user?.avatarURL || "assets/default-avatar.png";
            });
          } catch (_) {}
          return user;
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
    try {
      localStorage.removeItem("lpc_user");
    } catch (_) {}
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
    sessionPromise = Promise.resolve(cachedUser);
  }

  fetchSession().catch(() => {});

  window.checkSession = checkSession;
  window.redirectUserDashboard = redirectUserDashboard;
  window.clearStoredSession = clearStoredSession;
  window.getSessionToken = () => "";
  window.getSessionData = getSessionData;
  window.getStoredUser = getCachedUser;
  window.refreshSession = refreshSession;
  window.updateSessionUser = updateSessionUser;

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
