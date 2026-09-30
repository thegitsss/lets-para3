import { secureFetch } from "../auth.js";
import { normalizeHttpNavigationUrl } from "./navigation-url.js";

const CACHE_TTL_MS = 2 * 60 * 1000;

export const STRIPE_GATE_MESSAGE = "Complete Stripe payout setup before applying.";

let cachedStatus;
let cachedAt = 0;
let inFlight = null;

export function isStripeConnected(status) {
  return status?.readiness?.ready === true;
}

export async function getStripeConnectStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedAt && now - cachedAt < CACHE_TTL_MS) {
    return cachedStatus ?? null;
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
      return data;
    } catch {
      cachedStatus = null;
      cachedAt = Date.now();
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

export async function startStripeOnboarding({ request = secureFetch, isCurrent = () => true } = {}) {
  const res = await request("/api/payments/connect", { method: "POST", body: {} });
  const data = await res.json().catch(() => ({}));
  if (!isCurrent()) return null;
  if (!res.ok) {
    throw new Error(data?.error || "Unable to start Stripe onboarding.");
  }
  const url = normalizeHttpNavigationUrl(data?.url, { allowedHosts: ["connect.stripe.com"] });
  if (!url) throw new Error("Stripe returned an invalid onboarding destination.");
  if (typeof window !== "undefined") window.location.href = url;
  return url;
}

export function clearStripeConnectCache() {
  cachedStatus = null;
  cachedAt = 0;
}
