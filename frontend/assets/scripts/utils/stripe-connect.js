import { secureFetch } from "../auth.js";

const CACHE_KEY = "lpc_stripe_connect_status";
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEV_STRIPE_STORAGE_KEY = "lpc_stripe_dev_override";
const DEV_STRIPE_ALLOWLIST = [
  "samanthasider+attorney@gmail.com",
  "samanthasider+paralegal@gmail.com",
  "samanthasider+11@gmail.com",
  "samanthasider+56@gmail.com",
];
const ALWAYS_STRIPE_BYPASS_EMAILS = new Set(["samanthasider+56@gmail.com"]);
const DEV_STRIPE_QUERY_PARAM = "stripe";
const DEV_STRIPE_QUERY_VALUE = "dev";

export const STRIPE_GATE_MESSAGE = "Stripe Connect is required to receive payment. Connect it from your dashboard.";

let cachedStatus;
let cachedAt = 0;
let inFlight = null;

function getStoredUserEmail() {
  try {
    const raw = localStorage.getItem("lpc_user");
    const parsed = raw ? JSON.parse(raw) : null;
    return String(parsed?.email || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function hasDevStripeToggle() {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search || "");
    const paramValue = String(params.get(DEV_STRIPE_QUERY_PARAM) || "").toLowerCase();
    if (paramValue === DEV_STRIPE_QUERY_VALUE) {
      localStorage.setItem(DEV_STRIPE_STORAGE_KEY, "true");
    }
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(DEV_STRIPE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function shouldBypassStripe() {
  const email = getStoredUserEmail();
  if (!email) return false;
  if (ALWAYS_STRIPE_BYPASS_EMAILS.has(email)) return true;
  if (!DEV_STRIPE_ALLOWLIST.includes(email)) return false;
  return hasDevStripeToggle();
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!Object.prototype.hasOwnProperty.call(parsed, "at")) return null;
    if (!Object.prototype.hasOwnProperty.call(parsed, "data")) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ at: Date.now(), data: data ?? null })
    );
  } catch {
    /* ignore */
  }
}

export function isStripeConnected(status) {
  return !!status?.connected || (!!status?.details_submitted && !!status?.payouts_enabled);
}

export async function getStripeConnectStatus({ force = false } = {}) {
  if (shouldBypassStripe()) {
    const devStatus = { connected: true, details_submitted: true, payouts_enabled: true, devBypass: true };
    cachedStatus = devStatus;
    cachedAt = Date.now();
    writeCache(devStatus);
    return devStatus;
  }
  const now = Date.now();
  if (!force && cachedAt && now - cachedAt < CACHE_TTL_MS) {
    return cachedStatus ?? null;
  }

  if (!force) {
    const cached = readCache();
    if (cached && now - cached.at < CACHE_TTL_MS) {
      cachedStatus = cached.data ?? null;
      cachedAt = cached.at || now;
      return cachedStatus;
    }
  }

  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await secureFetch("/api/payments/connect/status", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("stripe status");
      const data = await res.json().catch(() => ({}));
      cachedStatus = data;
      cachedAt = Date.now();
      writeCache(data);
      return data;
    } catch {
      cachedStatus = null;
      cachedAt = Date.now();
      writeCache(null);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export async function ensureStripeConnected({ force = false } = {}) {
  const status = await getStripeConnectStatus({ force });
  return isStripeConnected(status);
}

export async function startStripeOnboarding() {
  const res = await secureFetch("/api/payments/connect", { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Unable to start Stripe onboarding.");
  }
  const url = data?.url;
  if (url && typeof window !== "undefined") {
    window.location.href = url;
  }
  return url;
}

export function clearStripeConnectCache() {
  cachedStatus = null;
  cachedAt = 0;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}
