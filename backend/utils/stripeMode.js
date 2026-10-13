const STRIPE_MODE_VALUES = ["live", "test", "unknown"];

function normalizeStripeMode(value) {
  if (value === true) return "live";
  if (value === false) return "test";
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "live" || normalized === "test") return normalized;
  return "unknown";
}

function stripeModeFromLivemode(value) {
  return normalizeStripeMode(value);
}

function stripeModeFromSecret(secret) {
  const normalized = String(secret || "").trim().toLowerCase();
  if (
    normalized.startsWith("sk_live_") ||
    normalized.startsWith("pk_live_") ||
    normalized.startsWith("rk_live_")
  ) {
    return "live";
  }
  if (
    normalized.startsWith("sk_test_") ||
    normalized.startsWith("pk_test_") ||
    normalized.startsWith("rk_test_")
  ) {
    return "test";
  }
  return "unknown";
}

function currentStripeMode() {
  return stripeModeFromSecret(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_PUBLISHABLE_KEY || "");
}

function pickStripeMode(...values) {
  for (const value of values) {
    const normalized = normalizeStripeMode(value);
    if (normalized !== "unknown") return normalized;
  }
  return "unknown";
}

function createStripeModeSummary() {
  return {
    live: { amount: 0, count: 0 },
    test: { amount: 0, count: 0 },
    unknown: { amount: 0, count: 0 },
  };
}

function summarizeStripeModeGroups(groups = [], { amountKey = "total", countKey = "count" } = {}) {
  return groups.reduce((summary, entry) => {
    const mode = normalizeStripeMode(entry?._id);
    summary[mode].amount += Number(entry?.[amountKey] || 0);
    summary[mode].count += Number(entry?.[countKey] || 0);
    return summary;
  }, createStripeModeSummary());
}

function summarizeStripeModeAmounts(groups = [], options) {
  const summary = summarizeStripeModeGroups(groups, options);
  return STRIPE_MODE_VALUES.reduce((acc, mode) => {
    acc[mode] = summary[mode].amount;
    return acc;
  }, {});
}

module.exports = {
  STRIPE_MODE_VALUES,
  normalizeStripeMode,
  stripeModeFromLivemode,
  stripeModeFromSecret,
  currentStripeMode,
  pickStripeMode,
  createStripeModeSummary,
  summarizeStripeModeGroups,
  summarizeStripeModeAmounts,
};
