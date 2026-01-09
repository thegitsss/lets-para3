// frontend/assets/scripts/auth.js
// Lightweight auth helpers for the Express/Mongo backend.
// - Prefetches CSRF token and exposes it
// - secureFetch(): auto-includes CSRF header for mutating requests, supports FormData/Blob
// - Role-based visibility via [data-visible="attorney|paralegal|admin"]
// - Dev-safe reCAPTCHA helper

export let CSRF_TOKEN = "";

const USER_KEY = "lpc_user";
const LEGACY_TOKEN_KEYS = ["LPC_JWT", "lpc_jwt"];
let redirectingToLogin = false;

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
    const payload = user ? JSON.stringify(user) : "";
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

  return session;
}

// Prefetch CSRF token (sets cookie via server; we store the token for headers)
export async function fetchCSRF(force = false) {
  if (CSRF_TOKEN && !force) return CSRF_TOKEN;
  const r = await fetch("/api/csrf", { credentials: "include" });
  if (r.ok) {
    const { csrfToken } = await r.json();
    CSRF_TOKEN = csrfToken || "";
    // keep compat with older code
    window.__CSRF__ = CSRF_TOKEN;
  }
  return CSRF_TOKEN;
}
export async function secureJSON(url, opts = {}) {
  const res = await secureFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
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
      try { await fetchCSRF(); } catch {}
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

  const res = await fetch(url, {
    ...opts,
    body,
    headers,
    credentials: "include",
    signal: opts.signal,
  });

  // If CSRF expired and server returns 403, refresh once and retry
  if (res.status === 403 && isMutation) {
    try {
      await fetchCSRF(true);
      if (CSRF_TOKEN) headers.set("X-CSRF-Token", CSRF_TOKEN);
      return fetch(url, { ...opts, body, headers, credentials: "include" });
    } catch {
      return res;
    }
  }

  if ((res.status === 401 || res.status === 403) && !opts.noRedirect) {
    clearSession();
    redirectToLoginOnce();
  }

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
    await secureFetch("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  clearSession();
  if (redirect) {
    try {
      window.location.href = redirect;
    } catch {}
  }
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

// Boot-time: add 'loaded' class, fetch CSRF, and toggle role-based UI (best-effort)
window.addEventListener("DOMContentLoaded", async () => {
  document.body.classList.add("loaded");

  try { await fetchCSRF(); } catch {}

  try {
    const r = await fetch("/api/users/me", { credentials: "include" });
    const me = r.ok ? await r.json() : null;
    if (me?.role) applyRoleVisibility(me.role);
  } catch {
    // non-fatal for public/unauthenticated pages
  }

  wireLogoutButton();
});
// === Auto-inject logged-in user's name + avatar globally ===
export async function loadUserHeaderInfo() {
  try {
    const res = await secureFetch("/api/users/me", { method: "GET" });
    if (!res.ok) return;
    const user = await res.json();

    document.querySelectorAll(".globalProfileImage").forEach((img) => {
      img.src = user.profileImage || "default.jpg";
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
