(function(){
  const TOKEN_KEY = "lpc_token";
  const USER_KEY = "lpc_user";
  let hasRedirected = false;
  let nukedOnRedirect = false;

  function redirectToLogin() {
    if (hasRedirected) return;
    hasRedirected = true;
    try {
      window.location.href = "login.html";
    } catch (_) {}
  }

  function readToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function readUser() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getSessionData() {
    const user = readUser();
    const token = readToken();
    const role = String(user?.role || "").toLowerCase();
    const status = String(user?.status || "").toLowerCase();
    return { token, user, role, status };
  }

  function clearStoredSession() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {}
  }

  function invalidateAndRedirect() {
    if (!nukedOnRedirect) {
      nukedOnRedirect = true;
      clearStoredSession();
    }
    redirectToLogin();
  }

  function checkSession(expectedRole) {
    const { token, user, role, status } = getSessionData();
    // Accept either a stored token or a persisted session user (token may be httpOnly cookie)
    if ((!token && !user) || !user) {
      invalidateAndRedirect();
      throw new Error("Authentication required");
    }
    if (expectedRole && role !== String(expectedRole).toLowerCase()) {
      invalidateAndRedirect();
      throw new Error("Forbidden");
    }
    if (status && status !== "approved") {
      invalidateAndRedirect();
      throw new Error("Not approved");
    }
    nukedOnRedirect = false;
    return { token, role, status, user };
  }

  function redirectUserDashboard(roleOverride) {
    let role = roleOverride;
    if (!role) {
      const user = readUser();
      role = user?.role || "attorney";
    }
    const norm = String(role).toLowerCase();
    const target = norm === "admin" ? "admin-dashboard.html" : norm === "paralegal"
      ? "dashboard-paralegal.html" : "dashboard-attorney.html";
    try {
      window.location.href = target;
    } catch (_) {}
  }

  window.checkSession = checkSession;
  window.redirectUserDashboard = redirectUserDashboard;
  window.clearStoredSession = clearStoredSession;
  window.getSessionToken = readToken;
  window.getSessionData = getSessionData;
  window.getStoredUser = readUser;
})();
