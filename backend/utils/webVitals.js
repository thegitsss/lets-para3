const METRIC_LIMITS = Object.freeze({
  CLS: 10,
  INP: 60_000,
  LCP: 120_000,
});

const GOOD_THRESHOLDS = Object.freeze({
  CLS: 0.1,
  INP: 200,
  LCP: 2_500,
});

const POOR_THRESHOLDS = Object.freeze({
  CLS: 0.25,
  INP: 500,
  LCP: 4_000,
});

function cleanEnum(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizePagePath(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.length > 200) return "";
  const pathOnly = raw.split(/[?#]/, 1)[0];
  return /^[\/a-zA-Z0-9._~-]+$/.test(pathOnly) ? pathOnly : "";
}

function normalizeWebVitalSample(payload = {}) {
  const metric = String(payload.metric || "").trim().toUpperCase();
  if (!Object.hasOwn(METRIC_LIMITS, metric)) return null;
  const value = Number(payload.value);
  if (!Number.isFinite(value) || value < 0 || value > METRIC_LIMITS[metric]) return null;
  const page = normalizePagePath(payload.page);
  if (!page) return null;

  return {
    metric,
    value: Number(value.toFixed(metric === "CLS" ? 4 : 1)),
    rating:
      value <= GOOD_THRESHOLDS[metric]
        ? "good"
        : value <= POOR_THRESHOLDS[metric]
          ? "needs-improvement"
          : "poor",
    page,
    deviceClass: cleanEnum(payload.deviceClass, ["mobile", "desktop"], "desktop"),
    navigationType: cleanEnum(
      payload.navigationType,
      ["navigate", "reload", "back-forward", "back_forward", "prerender", "restore"],
      "navigate"
    ).replace("_", "-"),
    connectionType: cleanEnum(payload.connectionType, ["slow-2g", "2g", "3g", "4g"], "unknown"),
  };
}

function isTrustedVitalsRequest(req, env = process.env) {
  const fetchSite = String(req.get("sec-fetch-site") || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") return false;

  const origin = String(req.get("origin") || "").trim();
  if (!origin) return env.NODE_ENV !== "production";

  let expectedOrigin;
  try {
    expectedOrigin = env.NODE_ENV === "production"
      ? new URL(String(env.APP_BASE_URL || "")).origin
      : `${req.protocol}://${req.get("host")}`;
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isGoodP75(metric, value) {
  const threshold = GOOD_THRESHOLDS[String(metric || "").toUpperCase()];
  return Number.isFinite(Number(value)) && Number(value) <= threshold;
}

module.exports = {
  GOOD_THRESHOLDS,
  POOR_THRESHOLDS,
  normalizePagePath,
  normalizeWebVitalSample,
  isGoodP75,
  isTrustedVitalsRequest,
};
