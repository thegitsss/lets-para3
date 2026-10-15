const { buildFundingFingerprint } = require("../utils/funding");

describe("funding idempotency policy", () => {
  test("preserves the established general funding-key format", () => {
    expect(
      buildFundingFingerprint({
        mode: "client-escrow",
        caseId: "case-1",
        amount: 125000,
        currency: "USD",
      })
    ).toBe("client-escrow:case-1:125000:usd");
  });

  test("binds hire funding keys to the selected paralegal", () => {
    expect(
      buildFundingFingerprint({
        mode: "hire-charge",
        caseId: "case-1",
        targetId: "paralegal-1",
        amount: 125000,
        currency: "USD",
      })
    ).toBe("hire-charge:case-1:paralegal-1:125000:usd");
  });
});
