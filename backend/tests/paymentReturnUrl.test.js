const { buildCheckoutReturnUrl } = require("../services/paymentReturnUrl");

describe("Stripe Checkout return URLs", () => {
  test("builds a canonical success return with Matter context before the Funds fragment", () => {
    expect(buildCheckoutReturnUrl({
      configuredUrl: "https://www.lets-paraconnect.com/dashboard-attorney.html?payment=success#funds",
      clientBase: "https://www.lets-paraconnect.com",
      state: "success",
      caseId: "64f000000000000000000001",
    })).toBe(
      "https://www.lets-paraconnect.com/dashboard-attorney.html?payment=success&caseId=64f000000000000000000001#funds"
    );
  });

  test("upgrades an already-issued legacy billing return without losing its Matter", () => {
    expect(buildCheckoutReturnUrl({
      configuredUrl: "https://www.lets-paraconnect.com/billing-attorney.html?checkout=cancelled",
      clientBase: "https://www.lets-paraconnect.com",
      state: "cancel",
      caseId: "64f000000000000000000002",
    })).toBe(
      "https://www.lets-paraconnect.com/dashboard-attorney.html?payment=cancel&caseId=64f000000000000000000002#funds"
    );
  });

  test("rejects ambiguous states and missing Matter context", () => {
    expect(() => buildCheckoutReturnUrl({
      clientBase: "https://www.lets-paraconnect.com",
      state: "pending",
      caseId: "64f000000000000000000003",
    })).toThrow(/success or cancel/i);
    expect(() => buildCheckoutReturnUrl({
      clientBase: "https://www.lets-paraconnect.com",
      state: "success",
      caseId: "",
    })).toThrow(/Matter id/i);
  });
});
