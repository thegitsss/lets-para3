process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_paralegal_support_agent_tools";

const Case = require("../models/Case");
const {
  PARALEGAL_TOOL_NAMES,
  buildParalegalApplicationRelationshipFilter,
  buildParalegalParticipationFilter,
  executeParalegalSupportTool,
  getParalegalNavigationDestination,
  getOwnParalegalInviteRecords,
  getWithdrawnAccessCutoff,
  getParalegalSupportToolDefinitions,
  isRecordVisibleAtCutoff,
  validateParalegalToolArguments,
} = require("../ai/paralegalSupportAgentTools");

describe("paralegal support agent tools", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("publishes a unique strict read-only tool set", () => {
    const definitions = getParalegalSupportToolDefinitions();
    expect(definitions).toHaveLength(14);
    expect(new Set(definitions.map((item) => item.name)).size).toBe(14);
    expect(definitions.every((item) => item.type === "function" && item.strict === true)).toBe(true);
    expect(PARALEGAL_TOOL_NAMES).toEqual(definitions.map((item) => item.name));
  });

  test("validates required, allowed, typed, and enumerated arguments", () => {
    expect(validateParalegalToolArguments("get_paralegal_case_workspace", {}))
      .toMatchObject({ valid: false, error: "missing_tool_argument" });
    expect(validateParalegalToolArguments("get_paralegal_case_workspace", { case_reference: 12 }))
      .toMatchObject({ valid: false, error: "invalid_tool_argument_type" });
    expect(validateParalegalToolArguments("get_paralegal_case_overview", { status_scope: "pending" }))
      .toMatchObject({ valid: false, error: "invalid_tool_argument_value" });
    expect(validateParalegalToolArguments("get_paralegal_payout_setup", { extra: true }))
      .toMatchObject({ valid: false, error: "unsupported_tool_argument" });
    expect(validateParalegalToolArguments("get_paralegal_payout_setup", {}))
      .toEqual({ valid: true });
  });

  test("scopes matter and application queries to the signed-in paralegal relationship", () => {
    expect(buildParalegalParticipationFilter("para-1")).toEqual({
      $or: [
        { paralegal: "para-1" },
        { paralegalId: "para-1" },
        { withdrawnParalegalId: "para-1" },
      ],
    });
    expect(buildParalegalApplicationRelationshipFilter("para-1")).toEqual({
      $or: [
        { "applicants.paralegalId": "para-1" },
        { "invites.paralegalId": "para-1" },
        { pendingParalegalId: "para-1" },
      ],
    });
  });

  test.each(["attorney", "admin"])("rejects a %s before any matter lookup", async (role) => {
    const find = jest.spyOn(Case, "find");
    const result = await executeParalegalSupportTool({
      name: "get_paralegal_case_overview",
      args: { status_scope: "all" },
      context: { user: { _id: `${role}-1`, role } },
    });
    expect(result).toMatchObject({
      available: false,
      authorized: false,
      evidenceState: "unauthorized",
      reason: "paralegal_role_required",
    });
    expect(find).not.toHaveBeenCalled();
  });

  test("returns unauthorized for an unrelated matter and scopes the lookup to the requesting paralegal", async () => {
    let observedQuery = null;
    const chain = {
      select: jest.fn(() => chain),
      sort: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      lean: jest.fn(async () => []),
    };
    jest.spyOn(Case, "find").mockImplementation((query) => {
      observedQuery = query;
      return chain;
    });
    const result = await executeParalegalSupportTool({
      name: "get_paralegal_case_workspace",
      args: { case_reference: "507f1f77bcf86cd799439011" },
      context: { user: { _id: "507f1f77bcf86cd799439012", role: "paralegal" } },
    });
    expect(result).toMatchObject({
      available: false,
      authorized: false,
      evidenceState: "unauthorized",
      reason: "matter_not_accessible",
    });
    expect(observedQuery).toEqual({
      $and: [
        {
          $or: [
            { paralegal: "507f1f77bcf86cd799439012" },
            { paralegalId: "507f1f77bcf86cd799439012" },
            { withdrawnParalegalId: "507f1f77bcf86cd799439012" },
          ],
        },
        { _id: "507f1f77bcf86cd799439011" },
      ],
    });
  });

  test("reconciles a legacy pending invitation when no modern invite row exists", () => {
    expect(getOwnParalegalInviteRecords({
      invites: [],
      pendingParalegalId: "para-1",
      pendingParalegalInvitedAt: "2026-07-01T00:00:00.000Z",
    }, "para-1")).toEqual([{
      paralegalId: "para-1",
      status: "pending",
      invitedAt: "2026-07-01T00:00:00.000Z",
      respondedAt: null,
      source: "legacy_pending",
    }]);
  });

  test("excludes work created after withdrawn access ended", () => {
    const cutoff = getWithdrawnAccessCutoff({
      paralegalAccessRevokedAt: "2026-07-10T12:00:00.000Z",
      pausedAt: "2026-07-09T12:00:00.000Z",
    }, "withdrawn");
    expect(cutoff.toISOString()).toBe("2026-07-10T12:00:00.000Z");
    expect(isRecordVisibleAtCutoff({ createdAt: "2026-07-10T11:59:00.000Z" }, cutoff)).toBe(true);
    expect(isRecordVisibleAtCutoff({ createdAt: "2026-07-10T12:01:00.000Z" }, cutoff)).toBe(false);
    expect(isRecordVisibleAtCutoff({}, cutoff)).toBe(false);
    expect(getWithdrawnAccessCutoff({}, "assigned")).toBeNull();
  });

  test("uses a role-safe navigation allowlist and returns only one CTA mechanism", async () => {
    expect(getParalegalNavigationDestination("payouts")).toEqual({
      available: true,
      ctaLabel: "Payout settings",
      ctaHref: "profile-settings.html",
    });
    expect(getParalegalNavigationDestination("billing")).toEqual({
      available: false,
      reason: "destination_not_available_for_paralegal",
    });
    const result = await executeParalegalSupportTool({
      name: "find_paralegal_navigation_destination",
      args: { destination: "contact" },
      context: { user: { _id: "para-1", role: "paralegal" } },
    });
    expect(result).toMatchObject({
      available: true,
      ctaLabel: "Contact Us",
      ctaHref: "contact.html",
    });
    expect(result.inlineLinkText).toBeUndefined();
  });
});
