const DISQUALIFIER_KEYS = new Set([
  "involvesPayment",
  "involvesPayout",
  "involvesBillingPromise",
  "legalOrDisputeContext",
]);

function clampUnit(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeFactorValue(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return clampUnit(value);
  return 0;
}

function isDisqualifyingFactor(factor = {}) {
  if (!factor || typeof factor !== "object") return false;

  for (const key of DISQUALIFIER_KEYS) {
    if (factor[key] === true) return true;
  }

  const label = String(factor.key || factor.name || factor.type || factor.id || "").trim();
  if (DISQUALIFIER_KEYS.has(label) && factor.value === true) {
    return true;
  }

  return false;
}

function scoreConfidence(factors = []) {
  const list = Array.isArray(factors) ? factors : [];
  if (!list.length) return 0;

  if (list.some((factor) => isDisqualifyingFactor(factor))) {
    return 0;
  }

  let weightedScore = 0;
  let totalWeight = 0;

  list.forEach((factor) => {
    const weight = Math.max(0, Number(factor?.weight || 0));
    if (!weight) return;
    weightedScore += normalizeFactorValue(factor?.value) * weight;
    totalWeight += weight;
  });

  if (!totalWeight) return 0;
  return clampUnit(weightedScore / totalWeight);
}

module.exports = {
  scoreConfidence,
};
