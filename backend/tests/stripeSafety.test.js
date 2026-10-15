describe("Stripe safety helpers", () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    jest.resetModules();
  });

  test("builds deterministic, operation-scoped idempotency keys", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    jest.resetModules();
    const stripe = require("../utils/stripe");
    const first = stripe.stripeIdempotencyKey("case_payout", "case-1", "user-1", 1000, "pi_1");
    const retry = stripe.stripeIdempotencyKey("case_payout", "case-1", "user-1", 1000, "pi_1");
    const changed = stripe.stripeIdempotencyKey("case_payout", "case-1", "user-1", 900, "pi_1");
    expect(first).toBe(retry);
    expect(first).not.toBe(changed);
    expect(first.length).toBeLessThanOrEqual(255);
  });

  test("pins the Stripe client API version even when the environment omits it", () => {
    const previousVersion = process.env.STRIPE_API_VERSION;
    delete process.env.STRIPE_API_VERSION;
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    jest.resetModules();
    const stripe = require("../utils/stripe");
    expect(stripe.getApiField("version")).toBe("2026-07-29.dahlia");
    if (previousVersion === undefined) delete process.env.STRIPE_API_VERSION;
    else process.env.STRIPE_API_VERSION = previousVersion;
  });

  test("fails closed when a live succeeded intent lacks a charge or the expected transfer group", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_placeholder";
    jest.resetModules();
    const stripe = require("../utils/stripe");
    expect(stripe.isTransferablePaymentIntent({
      id: "pi_live",
      status: "succeeded",
      transfer_group: "case_case-1",
    }, { caseId: "case-1" })).toEqual(expect.objectContaining({ transferable: false, reason: "missing_charge" }));

    expect(stripe.isTransferablePaymentIntent({
      id: "pi_live",
      status: "succeeded",
      latest_charge: { id: "ch_live", paid: true, captured: true },
      transfer_group: "case_other",
    }, { caseId: "case-1" })).toEqual(expect.objectContaining({ transferable: false, reason: "transfer_group_mismatch" }));
  });

  test("verifies case identity, exact charged amount, currency, and transfer group", () => {
    const mongoose = require("mongoose");
    const { validatePaymentIntentForCase } = require("../utils/paymentIntegrity");
    const caseId = new mongoose.Types.ObjectId();
    const caseDoc = {
      _id: caseId,
      lockedTotalAmount: 100000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 22000,
      currency: "usd",
      stripeMode: "live",
    };
    const validIntent = {
      id: "pi_live",
      amount: 122000,
      currency: "usd",
      livemode: true,
      transfer_group: `case_${caseId}`,
      metadata: { caseId: String(caseId) },
    };

    expect(validatePaymentIntentForCase(validIntent, caseDoc).valid).toBe(true);
    expect(validatePaymentIntentForCase({ ...validIntent, amount: 121999 }, caseDoc).reasons)
      .toContain("amount_mismatch");
    expect(validatePaymentIntentForCase({ ...validIntent, currency: "cad" }, caseDoc).reasons)
      .toContain("currency_mismatch");
    expect(validatePaymentIntentForCase({ ...validIntent, metadata: { caseId: "other" } }, caseDoc).reasons)
      .toContain("case_metadata_mismatch");
    expect(validatePaymentIntentForCase({ ...validIntent, livemode: false }, caseDoc).reasons)
      .toContain("stripe_mode_mismatch");
  });
});
