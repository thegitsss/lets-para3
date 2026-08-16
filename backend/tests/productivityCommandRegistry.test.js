const registry = require("../../frontend/assets/scripts/productivity-command-registry.js");
const {
  buildSupportConversationSystemPrompt,
  listPermittedProductivityCommands,
  sanitizeNavigationPayload,
} = require("../ai/supportAgent");

describe("Prompt 4 productivity command registry", () => {
  const caseId = "64b000000000000000000001";

  test("projects only role-safe navigation and workflow launches", () => {
    const attorney = registry.listCommands({ role: "attorney" });
    const paralegal = registry.listCommands({ role: "paralegal" });

    expect(attorney.map((command) => command.code)).toEqual(expect.arrayContaining([
      "attorney.home",
      "attorney.matters",
      "attorney.tasks",
      "attorney.post_matter",
      "common.account_settings",
    ]));
    expect(attorney.map((command) => command.code)).not.toContain("paralegal.browse_matters");
    expect(paralegal.map((command) => command.code)).toEqual(expect.arrayContaining([
      "paralegal.home",
      "paralegal.browse_matters",
      "paralegal.my_work",
      "common.account_settings",
    ]));
    expect(paralegal.map((command) => command.code)).not.toContain("attorney.billing");
    expect([...attorney, ...paralegal].every((command) => command.navigationOnly === true)).toBe(true);
    expect(JSON.stringify([...attorney, ...paralegal])).not.toMatch(/publish|release payment|refund|withdraw|dispute|payout setup|delete/i);
  });

  test("fails closed for unknown commands and unavailable Matter sections", () => {
    const context = { role: "attorney", caseId, availableMatterTabs: ["overview", "files"] };
    expect(registry.resolveCommand("invented.command", context)).toBeNull();
    expect(registry.resolveCommand("matter.messages", context)).toBeNull();
    expect(registry.resolveCommand("matter.files", context)).toEqual(expect.objectContaining({
      href: `/case-detail.html?caseId=${caseId}&tab=files`,
      navigationOnly: true,
    }));
    expect(registry.resolveCommand("matter.files", { ...context, caseId: "not-an-id" })).toBeNull();
  });

  test("Assistant accepts allowed codes and rejects raw URLs, invented codes, and role mismatch", () => {
    const pageContext = {
      caseId,
      availableMatterTabs: ["overview", "files"],
      permittedCommandCodes: ["attorney.matters", "matter.files"],
    };
    expect(sanitizeNavigationPayload({ commandCode: "attorney.matters" }, "attorney", pageContext)).toEqual(
      expect.objectContaining({ commandCode: "attorney.matters", ctaHref: "/dashboard-attorney.html#cases" })
    );
    expect(sanitizeNavigationPayload({ commandCode: "matter.files" }, "attorney", pageContext)).toEqual(
      expect.objectContaining({ ctaHref: `/case-detail.html?caseId=${caseId}&tab=files` })
    );
    expect(sanitizeNavigationPayload({ commandCode: "invented.command" }, "attorney", pageContext)).toBeNull();
    expect(sanitizeNavigationPayload({ commandCode: "paralegal.browse_matters" }, "attorney", pageContext)).toBeNull();
    expect(sanitizeNavigationPayload({ ctaHref: "/dashboard-attorney.html#cases" }, "attorney", pageContext)).toBeNull();
    expect(sanitizeNavigationPayload({ commandCode: "attorney.billing", method: "POST" }, "attorney", pageContext)).toBeNull();
  });

  test("model prompt exposes command codes but no member command URLs or mutation authority", () => {
    const pageContext = { permittedCommandCodes: ["paralegal.browse_matters"] };
    const commands = listPermittedProductivityCommands("paralegal", pageContext);
    const prompt = buildSupportConversationSystemPrompt({ userRole: "paralegal", pageContext });
    expect(commands.map((command) => command.code)).toEqual(["paralegal.browse_matters"]);
    expect(prompt).toContain("paralegal.browse_matters");
    expect(prompt).not.toContain("/browse-jobs.html");
    expect(prompt).toMatch(/Never publish, apply, select, fund, release payment/i);
    expect(prompt).toMatch(/Never return a URL, path, href, method, payload, or invoke action/i);
  });
});
