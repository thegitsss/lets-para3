// frontend/assets/scripts/auth.js
// Lightweight auth helpers for the Express/Mongo backend.
// - Prefetches CSRF token and exposes it
// - secureFetch(): auto-includes CSRF header for mutating requests, supports FormData/Blob
// - Role-based visibility via [data-visible="attorney|paralegal|admin"]

export let CSRF_TOKEN = "";

const USER_KEY = "lpc_user";
const SUPPORT_SESSION_USER_KEY = "lpc_support_session_user";
const LEGACY_TOKEN_KEYS = ["LPC_JWT", "lpc_jwt"];
let redirectingToLogin = false;

const SESSION_STRING_FIELDS = [
  "id",
  "_id",
  "role",
  "status",
  "firstName",
  "lastName",
  "name",
  "avatarURL",
  "profileImage",
  "pendingProfileImage",
  "profilePhotoStatus",
];
const SESSION_BOOLEAN_FIELDS = ["disabled", "deleted", "isFirstLogin", "legalAcceptanceRequired"];
const ONBOARDING_BOOLEAN_FIELDS = [
  "paralegalTourCompleted",
  "paralegalProfileTourCompleted",
  "attorneyTourCompleted",
  "attorneyProfileCompleted",
];

export function projectSessionUser(user) {
  if (typeof window !== "undefined" && typeof window.projectSessionUser === "function") {
    return window.projectSessionUser(user);
  }
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const snapshot = {};
  SESSION_STRING_FIELDS.forEach((field) => {
    if (typeof user[field] === "string") snapshot[field] = user[field];
  });
  SESSION_BOOLEAN_FIELDS.forEach((field) => {
    if (typeof user[field] === "boolean") snapshot[field] = user[field];
  });
  const preferences = {};
  if (typeof user.preferences?.theme === "string") preferences.theme = user.preferences.theme;
  if (typeof user.preferences?.fontSize === "string") preferences.fontSize = user.preferences.fontSize;
  if (Object.keys(preferences).length) snapshot.preferences = preferences;
  const onboarding = {};
  ONBOARDING_BOOLEAN_FIELDS.forEach((field) => {
    if (typeof user.onboarding?.[field] === "boolean") onboarding[field] = user.onboarding[field];
  });
  if (Object.keys(onboarding).length) snapshot.onboarding = onboarding;
  return snapshot;
}

function clearLegacyTokens() {
  LEGACY_TOKEN_KEYS.forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {}
    try {
      sessionStorage.removeItem(key);
    } catch {}
  });
}

function redirectToLoginOnce() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  try {
    if (typeof window !== "undefined") {
      window.location.href = "login.html";
    }
  } catch {
    /* noop */
  }
}

function redirectToLegalAcceptanceOnce() {
  if (typeof window === "undefined") return;
  const currentPath = String(window.location?.pathname || "").toLowerCase();
  if (currentPath.endsWith("/legal-acceptance.html")) return;
  try {
    window.location.replace("legal-acceptance.html");
  } catch {
    /* noop */
  }
}

function readStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getStoredSession() {
  const user = readStoredUser();
  return {
    user,
    role: String(user?.role || ""),
    status: String(user?.status || ""),
  };
}

export function persistSession({ user } = {}) {
  if (typeof user === "undefined") return;
  try {
    const snapshot = projectSessionUser(user);
    const payload = snapshot && Object.keys(snapshot).length ? JSON.stringify(snapshot) : "";
    if (payload) localStorage.setItem(USER_KEY, payload);
    else localStorage.removeItem(USER_KEY);
  } catch {
    try {
      localStorage.removeItem(USER_KEY);
    } catch {
      /* noop */
    }
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("avatarURL");
  } catch {
    /* noop */
  }
  try {
    sessionStorage.removeItem(SUPPORT_SESSION_USER_KEY);
    sessionStorage.removeItem("lpc-support-context");
    sessionStorage.removeItem("lpc_support_drawer_pin");
  } catch {
    /* noop */
  }
  clearLegacyTokens();
}

export function requireAuth(expectedRole) {
  const session = getStoredSession();
  const user = session.user;
  const role = String(session.role || "");
  const status = String(session.status || "");
  const normalizedRole = role.toLowerCase();
  const expected = typeof expectedRole === "string" ? expectedRole.toLowerCase() : "";

  if (!user || !role) {
    clearSession();
    redirectToLoginOnce();
    throw new Error("Authentication required");
  }

  if (user?.disabled || user?.deleted) {
    clearSession();
    redirectToLoginOnce();
    throw new Error("Account deactivated");
  }

  if (expected && normalizedRole !== expected) {
    clearSession();
    redirectToLoginOnce();
    throw new Error("Forbidden");
  }

  if (status && status.toLowerCase() !== "approved") {
    clearSession();
    redirectToLoginOnce();
    throw new Error("Not approved");
  }

  if (user?.legalAcceptanceRequired === true) {
    redirectToLegalAcceptanceOnce();
    const error = new Error("Updated legal documents must be accepted before continuing.");
    error.code = "LEGAL_ACCEPTANCE_REQUIRED";
    throw error;
  }

  return session;
}

// Prefetch CSRF token (sets cookie via server; we store the token for headers)
export async function fetchCSRF(force = false) {
  if (CSRF_TOKEN && !force) return CSRF_TOKEN;
  if (force) {
    CSRF_TOKEN = "";
    if (typeof window !== "undefined") window.__CSRF__ = "";
  }
  const r = await fetch("/api/csrf", { credentials: "include" });
  if (r.ok) {
    const { csrfToken } = await r.json();
    CSRF_TOKEN = csrfToken || "";
    // keep compat with older code
    if (typeof window !== "undefined") window.__CSRF__ = CSRF_TOKEN;
  }
  return CSRF_TOKEN;
}
export async function secureJSON(url, opts = {}) {
  const res = await secureFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function isCsrfFailure(response) {
  if (response?.status !== 403) return false;
  try {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return false;
    const payload = await response.clone().json();
    if (payload?.code === "CSRF_INVALID") return true;
    return /csrf/i.test(String(payload?.error || payload?.msg || ""));
  } catch {
    return false;
  }
}

function applyAuthResponseRedirect(response, opts = {}) {
  if (opts.noRedirect) return;
  if (response.status === 401) {
    clearSession();
    redirectToLoginOnce();
  } else if (response.status === 428) {
    redirectToLegalAcceptanceOnce();
  }
}

// Fetch wrapper that adds CSRF on mutating methods and handles JSON bodies safely.
export async function secureFetch(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  const headers = new Headers(opts.headers || {});
  let body = opts.body;

  if (isMutation) {
    if (typeof window !== "undefined" && typeof window.refreshSession === "function") {
      const activeSession = await window.refreshSession();
      if (!activeSession) {
        clearSession();
        redirectToLoginOnce();
        throw new Error("Session expired");
      }
    }
    if (!CSRF_TOKEN) {
      try {
        await fetchCSRF();
      } catch (error) {
        console.warn("[auth] CSRF preflight failed", error);
      }
    }
    if (CSRF_TOKEN) headers.set("X-CSRF-Token", CSRF_TOKEN);

    const isFormData = (typeof FormData !== "undefined") && body instanceof FormData;
    const isBlob = (typeof Blob !== "undefined") && body instanceof Blob;

    // Only auto-JSON if not FormData/Blob and Content-Type not already set
    if (!isFormData && !isBlob && body && typeof body === "object" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }
  } else {
    // Guard against accidental GET bodies
    const isFormData = (typeof FormData !== "undefined") && body instanceof FormData;
    const isBlob = (typeof Blob !== "undefined") && body instanceof Blob;
    if (body && typeof body === "object" && !isFormData && !isBlob) {
      body = undefined;
    }
  }

  let res = await fetch(url, {
    ...opts,
    body,
    headers,
    credentials: "include",
    signal: opts.signal,
  });

  // Refresh and retry only an explicit CSRF rejection. A normal authorization
  // denial must not be double-submitted or treated as an expired session.
  if (isMutation && await isCsrfFailure(res)) {
    try {
      const refreshedToken = await fetchCSRF(true);
      if (refreshedToken) {
        headers.set("X-CSRF-Token", refreshedToken);
        res = await fetch(url, { ...opts, body, headers, credentials: "include" });
      }
    } catch (error) {
      console.warn("[auth] CSRF refresh failed; preserving the original response", error);
      // Preserve the original response when a token refresh cannot be completed.
    }
  }

  applyAuthResponseRedirect(res, opts);

  return res;
}

// Convenience helpers
export function showMsg(el, txt) { if (el) el.textContent = txt; }

// Apply [data-visible="attorney"], [data-visible="paralegal"], [data-visible="admin"]
export function applyRoleVisibility(role) {
  const want = String(role || "").toLowerCase();
  document.querySelectorAll("[data-visible]").forEach((el) => {
    const needed = (el.getAttribute("data-visible") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase());
    if (!needed.includes(want)) el.remove();
  });
}

export async function logout(redirect = "login.html") {
  try {
    const response = await secureFetch("/api/auth/logout", { method: "POST", noRedirect: true });
    if (!response.ok) throw new Error(`Logout failed with HTTP ${response.status}`);
  } catch (error) {
    import("./utils/dialogs.js")
      .then(({ showAlert }) =>
        showAlert("Your session could not be ended. Check your connection and try again.", {
          title: "Log out unsuccessful",
        })
      )
      .catch((dialogError) => {
        console.error("[auth] logout failure dialog could not be shown", dialogError);
      });
    return false;
  }
  clearSession();
  if (redirect) {
    try {
      window.location.href = redirect;
    } catch {}
  }
  return true;
}

export async function logoutUser(event) {
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
  clearLegacyTokens();
  await logout("login.html");
}

window.logoutUser = logoutUser;

function wireLogoutButton() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn && !logoutBtn.dataset.boundLogout) {
    logoutBtn.dataset.boundLogout = "true";
    logoutBtn.addEventListener("click", logoutUser);
  }
}

function wireLogoutDelegation() {
  if (window.__lpcLogoutDelegation) return;
  window.__lpcLogoutDelegation = true;
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target?.closest?.("[data-logout]");
      if (!target) return;
      logoutUser(event);
    },
    true
  );
}

function loadPageEnhancements() {
  const path = String(window.location?.pathname || "").toLowerCase();
  import("./utils/support-drawer.js")
    .then(({ scanSupportLaunchers }) => scanSupportLaunchers())
    .catch((err) => {
      console.warn("Unable to load the LPC assistant", err);
    });
  const pageOwnsStateFilter = document.querySelector("#stateList[data-state-filter-owner='browse-page']");
  if ((path.endsWith("/browse-paralegals.html") || path.endsWith("browse-paralegals.html")) && !pageOwnsStateFilter) {
    import("./browse-paralegals-state-multiselect.js").catch((err) => {
      console.warn("Unable to load browse paralegal state multi-select", err);
    });
  }
}

// Boot-time: add 'loaded' class, fetch CSRF, and toggle role-based UI (best-effort)
window.addEventListener("DOMContentLoaded", async () => {
  document.body.classList.add("loaded");

  try {
    await fetchCSRF();
  } catch (error) {
    console.warn("[auth] initial CSRF hydration failed", error);
  }

  const isPublicPage = document.body?.dataset?.publicPage === "true";
  if (!isPublicPage) {
    try {
      let me = null;
      if (typeof window.getSessionData === "function") {
        me = (await window.getSessionData())?.user || null;
      } else {
        const response = await fetch("/api/auth/me", { credentials: "include" });
        const payload = await response.json().catch(() => ({}));
        me = response.ok ? payload?.user || null : null;
        if (!response.ok && (response.status === 401 || response.status === 403)) {
          const message = payload?.error || payload?.msg || "";
          clearSession();
          if (/account has been (disabled|deactivated)/i.test(message)) {
            try {
              sessionStorage.setItem("disabledAccountMsg", message);
            } catch {}
          }
        }
      }
      if (!me) {
        clearSession();
        redirectToLoginOnce();
        return;
      }
      if (me?.role) applyRoleVisibility(me.role);
    } catch (error) {
      console.warn("[auth] authenticated page guard failed closed", error);
      clearSession();
      redirectToLoginOnce();
      return;
    }
  }

  loadPageEnhancements();
  wireLogoutButton();
  wireLogoutDelegation();
});
// === Auto-inject logged-in user's name + avatar globally ===
export async function loadUserHeaderInfo() {
  try {
    let user = null;
    if (typeof window.getSessionData === "function") {
      user = (await window.getSessionData())?.user || null;
    } else {
      const res = await secureFetch("/api/auth/me", { method: "GET" });
      if (!res.ok) return;
      user = (await res.json().catch(() => ({})))?.user || null;
    }
    if (!user) return;

    document.querySelectorAll(".globalProfileImage").forEach((img) => {
      img.src =
        user.pendingProfileImage ||
        user.profileImage ||
        user.avatarURL ||
        "assets/avatar-placeholder.svg";
    });

    document.querySelectorAll(".globalProfileName").forEach((name) => {
      name.textContent = `${user.firstName || ""} ${user.lastName || ""}`.trim();
    });

    document.querySelectorAll(".globalProfileRole").forEach((role) => {
      let resolvedRole = String(user?.role || "").toLowerCase();
      if (!resolvedRole) {
        try {
          const stored = localStorage.getItem("lpc_user");
          const storedUser = stored ? JSON.parse(stored) : null;
          resolvedRole = String(storedUser?.role || "").toLowerCase();
        } catch {}
      }
      if (resolvedRole === "paralegal") {
        role.textContent = "Paralegal";
      } else if (resolvedRole === "admin") {
        role.textContent = "Admin";
      } else if (resolvedRole === "director") {
        role.textContent = "Director";
      } else if (resolvedRole) {
        role.textContent = "Attorney";
      } else {
        role.textContent = "Member";
      }
    });
  } catch (err) {
    console.warn("Could not load user header info:", err);
  }
}
window.loadUserHeaderInfo = loadUserHeaderInfo;
