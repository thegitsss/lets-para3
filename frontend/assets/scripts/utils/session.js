(function () {
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

  async function fetchSession(force = false) {
    if (force) sessionPromise = null;
    if (!sessionPromise) {
      sessionPromise = fetch("/api/auth/me", { credentials: "include" })
        .then(async (res) => {
          if (!res.ok) {
            if (res.status === 401) return null;
            const payload = await res.json().catch(() => ({}));
            return payload?.user || null;
          }
          const data = await res.json().catch(() => ({}));
          return data?.user || null;
        })
        .catch(() => null)
        .then((user) => {
          cachedUser = user;
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

  async function checkSession(expectedRole) {
    const { user, role, status } = await getSessionData();
    if (!user) {
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
    return { user, role, status };
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

  fetchSession().catch(() => {});

  window.checkSession = checkSession;
  window.redirectUserDashboard = redirectUserDashboard;
  window.clearStoredSession = clearStoredSession;
  window.getSessionToken = () => "";
  window.getSessionData = getSessionData;
  window.getStoredUser = getCachedUser;
})();
