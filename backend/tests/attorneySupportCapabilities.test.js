process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_attorney_capability_contract";

const {
  buildAttorneyRoutingEvalCases,
  getAttorneySupportCapabilities,
} = require("../ai/attorneySupportCapabilities");
const { getSupportManagerToolDefinitions } = require("../ai/supportAgentTools");
const {
  ATTORNEY_WORKFLOW_STAGES,
  isAttorneyPaymentMethodRequired,
} = require("../services/attorneyWorkflowPolicy");

describe("attorney support capability contract", () => {
  test("keeps payment prerequisites authoritative across every enforced attorney workflow stage", () => {
    expect(isAttorneyPaymentMethodRequired(ATTORNEY_WORKFLOW_STAGES.POST_MATTER)).toBe(true);
    expect(isAttorneyPaymentMethodRequired(ATTORNEY_WORKFLOW_STAGES.RECEIVE_APPLICATIONS)).toBe(true);
    expect(isAttorneyPaymentMethodRequired(ATTORNEY_WORKFLOW_STAGES.HIRE_AND_FUND)).toBe(true);
  });

  test("all 32 audited capabilities have unique ownership, evidence sources, and automated prompts", () => {
    const capabilities = getAttorneySupportCapabilities();
    const ids = capabilities.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(capabilities).toHaveLength(32);
    for (const capability of capabilities) {
      expect(["implemented", "policy_blocked", "boundary"]).toContain(capability.status);
      expect(capability.sources.length).toBeGreaterThan(0);
      expect(capability.prompts.length).toBeGreaterThanOrEqual(3);
      if (!capability.boundary) expect(capability.tools.length).toBeGreaterThan(0);
      for (const tool of capability.requiredTools || []) {
        expect(capability.tools).toContain(tool);
      }
    }
  });

  test("every capability tool is implemented and attorney-authorized", () => {
    const attorneyTools = new Set(getSupportManagerToolDefinitions("attorney").map((tool) => tool.name));
    const missing = getAttorneySupportCapabilities().flatMap((capability) =>
      capability.tools.filter((tool) => !attorneyTools.has(tool)).map((tool) => ({ capability: capability.id, tool }))
    );
    expect(missing).toEqual([]);
  });

  test("keeps executable hiring policy structurally separate from general product knowledge", () => {
    const capabilities = new Map(getAttorneySupportCapabilities().map((capability) => [capability.id, capability]));
    expect(capabilities.get("A10_hiring").tools).toContain("get_attorney_workflow_readiness");
    expect(capabilities.get("A31_product_knowledge").tools).toEqual(["search_lpc_knowledge"]);
  });

  test("generated routing evaluations cover every capability and include multi-turn cases", () => {
    const cases = buildAttorneyRoutingEvalCases({ expanded: true });
    const capabilityIds = new Set(cases.map((item) => item.capabilityId));
    for (const capability of getAttorneySupportCapabilities()) {
      expect(capabilityIds.has(capability.id)).toBe(true);
    }
    expect(cases.some((item) => Array.isArray(item.history) && item.history.length > 0)).toBe(true);
    expect(
      cases.some(
        (item) =>
          item.prompt === "do i need a payment method first?" &&
          item.required.includes("get_attorney_workflow_readiness")
      )
    ).toBe(true);
    expect(cases.length).toBeGreaterThan(300);
  });
});
