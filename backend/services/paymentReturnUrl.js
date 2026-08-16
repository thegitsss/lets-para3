const CHECKOUT_STATES = new Set(["success", "cancel"]);

function trimSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildCheckoutReturnUrl({ configuredUrl = "", clientBase, state, caseId } = {}) {
  const normalizedState = String(state || "").trim().toLowerCase();
  const normalizedCaseId = String(caseId || "").trim();
  if (!CHECKOUT_STATES.has(normalizedState)) {
    throw new Error("Stripe Checkout return state must be success or cancel.");
  }
  if (!normalizedCaseId) {
    throw new Error("Stripe Checkout return URL requires a Matter id.");
  }

  const fallbackBase = trimSlash(clientBase);
  const rawUrl = String(configuredUrl || "").trim() || `${fallbackBase}/dashboard-attorney.html`;
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("Stripe Checkout return URL must be an absolute URL.");
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Stripe Checkout return URL must use HTTP or HTTPS.");
  }

  target.pathname = "/dashboard-attorney.html";
  target.searchParams.delete("checkout");
  target.searchParams.set("payment", normalizedState);
  target.searchParams.set("caseId", normalizedCaseId);
  target.hash = "funds";
  return target.toString();
}

module.exports = {
  buildCheckoutReturnUrl,
};
