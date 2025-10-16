// frontend/assets/scripts/helpers.js
// Backend-aligned helpers (cookie-based auth + CSRF via secureFetch).
// Exports:
//   - API_BASE: "/api"
//   - j(url, opts): fetch wrapper (uses secureFetch) with auto JSON/text parsing + structured errors
//   - escapeHTML(s): tiny sanitizer for UI

import { secureFetch } from "./auth.js";

export const API_BASE = "/api";

/** Normalize to an API URL (keeps absolute and rooted paths intact). */
function normalize(url) {
  if (/^https?:\/\//i.test(url)) return url;   // absolute URL
  if (url.startsWith("/")) return url;         // already rooted
  // relative path -> prefix with /api
  return `${API_BASE}/${url.replace(/^\/+/, "")}`;
}

/** Small HTML escaper for UI text nodes/attrs. */
export function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/**
 * j(url, opts): cookie-auth aware fetch wrapper.
 * - Delegates to secureFetch (adds CSRF on mutations, preserves FormData/Blob)
 * - Throws Error with {status, data} on non-OK
 * - Returns JSON if content-type is JSON; otherwise text
 */
export async function j(url, opts = {}) {
  const res = await secureFetch(normalize(url), { ...opts });

  if (!res.ok) {
    // Try to parse structured error
    let data;
    try {
      const ct = res.headers.get("content-type") || "";
      data = ct.includes("application/json") ? await res.json() : await res.text();
    } catch {
      data = null;
    }
    const message =
      (data && typeof data === "object" && (data.msg || data.error)) ||
      (typeof data === "string" && data) ||
      res.statusText ||
      "Request failed";
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}
