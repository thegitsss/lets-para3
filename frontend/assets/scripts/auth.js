// frontend/assets/scripts/auth.js
// Lightweight auth helpers for the Express/Mongo backend.
// - Prefetches CSRF token and exposes it
// - secureFetch(): auto-includes CSRF header for mutating requests, supports FormData/Blob
// - Role-based visibility via [data-visible="attorney|paralegal|admin"]
// - Dev-safe reCAPTCHA helper

export let CSRF_TOKEN = "";

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
export async function secureJSON(url, opts = {}) {
  const res = await secureFetch(url, opts);
  if (res.status === 401 && !opts.noRedirect) {
    try { location.href = "login.html"; } catch {}
  }
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
  signal: opts.signal, // pass-through
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

  return res;
}

// Convenience helpers
export function showMsg(el, txt) { if (el) el.textContent = txt; }

// Dev-safe reCAPTCHA gate (returns true if grecaptcha isn’t present)
export function isRecaptchaValid(_siteKey, msgEl) {
  /* global grecaptcha */
  if (typeof grecaptcha === "undefined") return true; // likely dev
  const token = grecaptcha.getResponse();
  if (!token) {
    showMsg(msgEl, "Please verify you are not a robot.");
    return false;
  }
  return true;
}

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
});
// === Auto-inject logged-in user's name + avatar globally ===
window.loadUserHeaderInfo = async function () {
  try {
    // 1. Show cached info instantly
    const cachedUser = JSON.parse(localStorage.getItem("userInfo") || "{}");
    const nameEl = document.getElementById("user-name");
    const avatarEl = document.querySelector(".user-profile img");

    if (cachedUser.name && nameEl) nameEl.textContent = cachedUser.name;
    if (cachedUser.profileImage && avatarEl) avatarEl.src = cachedUser.profileImage;

    // 2. Refresh with live data
    const res = await fetch("/api/users/me", { credentials: "include" });
    if (!res.ok) return;

    const user = await res.json();
    if (!user || !user.name) return;

    // 3. Update UI
    if (nameEl) nameEl.textContent = user.name;
    if (avatarEl && user.profileImage) avatarEl.src = user.profileImage;

    // 4. Cache for next load
    localStorage.setItem(
      "userInfo",
      JSON.stringify({
        name: user.name,
        profileImage: user.profileImage || cachedUser.profileImage || ""
      })
    );
  } catch (err) {
    console.warn("Could not load user header info:", err);
  }
};
