const {
  PARALEGAL_ENTITY_CAPABILITY_IDS,
  buildParalegalRoutingEvalCases,
  getParalegalCapabilityForTool,
  getParalegalSupportCapabilities,
} = require("../ai/paralegalSupportCapabilities");

describe("paralegal support capability registry", () => {
  test("defines 32 unique paralegal capabilities", () => {
    const capabilities = getParalegalSupportCapabilities();
    expect(capabilities).toHaveLength(32);
    expect(new Set(capabilities.map((item) => item.id)).size).toBe(32);
    expect(capabilities.every((item) => /^P\d{2}_[a-z0-9_]+$/.test(item.id))).toBe(true);
  });

  test("keeps legal work product and mutations behind an explicit boundary", () => {
    const boundary = getParalegalSupportCapabilities().find((item) => item.id === "P32_boundary");
    expect(boundary).toMatchObject({ boundary: true, status: "boundary", tools: [] });
  });

  test("gives every non-boundary capability sources, prompts, and required evidence tools", () => {
    for (const capability of getParalegalSupportCapabilities().filter((item) => !item.boundary)) {
      expect(capability.tools.length).toBeGreaterThan(0);
      expect(capability.requiredTools.length).toBeGreaterThan(0);
      expect(capability.sources.length).toBeGreaterThan(0);
      expect(capability.prompts.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("covers the core paralegal read-only tools and entity capabilities", () => {
    const tools = new Set(getParalegalSupportCapabilities().flatMap((item) => item.tools));
    for (const name of [
      "get_paralegal_case_workspace",
      "get_paralegal_application_activity",
      "get_paralegal_invitation_activity",
      "get_paralegal_payout_setup",
      "get_paralegal_payout_history",
      "get_paralegal_case_financials",
      "get_paralegal_workflow_readiness",
      "get_paralegal_messaging_state",
    ]) {
      expect(tools.has(name)).toBe(true);
      expect(getParalegalCapabilityForTool(name)).toBeTruthy();
    }
    expect(PARALEGAL_ENTITY_CAPABILITY_IDS).toContain("P17_matter_financials");
    expect(PARALEGAL_ENTITY_CAPABILITY_IDS).toContain("P21_completion_release");
  });

  test("generates routing evaluation cases for every authored prompt", () => {
    const capabilities = getParalegalSupportCapabilities();
    const corpus = buildParalegalRoutingEvalCases();
    expect(corpus).toHaveLength(capabilities.reduce((count, item) => count + item.prompts.length, 0));
    expect(corpus.filter((item) => item.boundary).every((item) => item.required.length === 0)).toBe(true);
  });
});
