const {
  FAILURE_CLASSES,
  normalizeParalegalToolEvidence,
  renderParalegalEvidenceAnswer,
} = require("../ai/paralegalEvidenceContract");

describe("paralegal evidence contract", () => {
  test("normalizes authored facts without exposing sensitive transport fields", () => {
    const evidence = normalizeParalegalToolEvidence({
      toolName: "get_paralegal_case_financials",
      result: {
        ok: true,
        evidenceState: "verified",
        transferId: "tr_secret",
        evidence: {
          capabilityId: "P17_matter_financials",
          authorized: true,
          facts: [
            { key: "gross", value: { formatted: "$100.00" } },
            { key: "platformFee", value: { formatted: "$20.00" } },
            { key: "net", value: { formatted: "$80.00" } },
            { key: "stripeAccountId", value: "acct_embedded_secret" },
            { key: "internalNotes", value: "hidden" },
          ],
        },
      },
    });
    expect(evidence.facts).toEqual(expect.arrayContaining([
      { key: "gross.formatted", value: "$100.00" },
      { key: "platformFee.formatted", value: "$20.00" },
      { key: "net.formatted", value: "$80.00" },
    ]));
    expect(evidence.facts.some((fact) => fact.key.includes("transferId"))).toBe(false);
    expect(evidence.facts.some((fact) => /stripeAccountId|internalNotes/.test(fact.key))).toBe(false);
  });

  test("labels gross, paralegal platform fee, and net payout", () => {
    const evidence = normalizeParalegalToolEvidence({
      toolName: "get_paralegal_case_financials",
      result: {
        ok: true,
        evidenceState: "verified",
        evidence: {
          capabilityId: "P17_matter_financials",
          authorized: true,
          facts: [
            { key: "gross", value: { formatted: "$100.00" } },
            { key: "platformFee", value: { formatted: "$20.00" } },
            { key: "net", value: { formatted: "$80.00" } },
            { key: "finalized", value: false },
          ],
        },
      },
    });
    const rendered = renderParalegalEvidenceAnswer("P17_matter_financials", evidence);
    expect(rendered.ok).toBe(true);
    expect(rendered.reply).toContain("gross amount is $100.00");
    expect(rendered.reply).toContain("paralegal platform fee is $20.00");
    expect(rendered.reply).toContain("current estimated net payout is $80.00");
  });

  test("keeps release separate from external bank receipt", () => {
    const evidence = normalizeParalegalToolEvidence({
      toolName: "get_paralegal_workflow_readiness",
      result: {
        ok: true,
        evidenceState: "verified",
        evidence: {
          capabilityId: "P21_completion_release",
          authorized: true,
          facts: [
            { key: "paymentReleased", value: true },
            { key: "bankDepositEstimateBusinessDays", value: { minimum: 3, maximum: 5 } },
          ],
        },
      },
    });
    const rendered = renderParalegalEvidenceAnswer("P21_completion_release", evidence);
    expect(rendered.reply).toContain("records the funds as released");
    expect(rendered.reply).toContain("does not by itself confirm they reached your bank");
    expect(rendered.reply).toContain("3–5 business days");
  });

  test("returns a truthful authorization limitation", () => {
    const rendered = renderParalegalEvidenceAnswer("P02_matter_details", {
      authorized: false,
      state: "unauthorized",
      facts: [],
    });
    expect(rendered.failureClass).toBe(FAILURE_CLASSES.EVIDENCE_UNAUTHORIZED);
    expect(rendered.reply).toContain("can’t access");
  });
});
