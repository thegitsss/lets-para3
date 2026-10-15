jest.mock("../models/SupportMessage", () => ({ find: jest.fn() }));
jest.mock("../ai/config", () => ({ AI_MODELS: { support: "gpt-5.6-terra" }, getOpenAIClient: () => null, isAiEnabled: () => false }));
jest.mock("../ai/supportAgentTools", () => ({
  executeSupportManagerTool: jest.fn(),
  getSupportManagerToolDefinitions: () => [{ type: "function", name: "get_my_case_overview", description: "Owned overview", parameters: { type: "object", properties: { status_scope: { type: "string", enum: ["all", "active", "completed"] } }, required: ["status_scope"], additionalProperties: false }, strict: true }],
}));

const { bindAccountOverviewToActor, aggregateCountClaims, supportedAccountOverviewSentence } = require("../ai/aggregateOverviewGrounding");
const { normalizeAttorneyToolEvidence } = require("../ai/attorneyEvidenceContract");
const { auditAttorneySemanticResponse, auditPolicyLiveStateConfusion } = require("../ai/attorneyResponseValidator");
const { auditParalegalSemanticResponse } = require("../ai/paralegalResponseValidator");
const { generateSupportManagerReply } = require("../ai/supportManagerAgent");
const OWNER = "a10000000000000000000001", FOREIGN = "a10000000000000000000002";
const USER = { id: OWNER, role: "attorney", status: "approved" };
const NOW = Date.parse("2026-10-15T22:00:00.000Z");

function overview({ active = 0, completed = 0, at = NOW, owner = USER } = {}) {
  const raw = { ok: true, available: true, role: "attorney", totalCount: active + completed, activeCount: active, completedCount: completed, byStatus: {}, requestedScope: "completed", recentCases: [], matchingCaseCount: completed, returnedCaseCount: 0, truncated: false };
  const observedAt = new Date(at).toISOString();
  const entry = { name: "get_my_case_overview", result: { ...raw, evidenceState: "verified", evidence: { ...normalizeAttorneyToolEvidence({ toolName: "get_my_case_overview", result: raw, retrievedAt: observedAt }), state: "verified", source: "get_my_case_overview", observedAt } } };
  return bindAccountOverviewToActor(entry, owner);
}
function errors(reply, outputs, accountOwnerId = OWNER, now = NOW) {
  return [
    ...auditAttorneySemanticResponse({ reply, messageText: "How many cases have I completed?", toolOutputs: outputs, activeTask: "FACT_LOOKUP", responseMode: "DIRECT_ANSWER", accountOwnerId, now }),
    ...auditPolicyLiveStateConfusion(reply, outputs, { accountOwnerId, now }),
  ];
}

describe("own-account aggregate count grounding without individual-Matter authority", () => {
  test.each([
    "You have 0 completed matters.", "You have completed 0 cases.", "You have no completed matters.",
    "You haven't completed any cases yet.", "You have not completed any matters yet.",
    "You have no completed matters yet.", "There are currently 0 completed matters.",
    "You’ve completed 0 matters.", "You've completed zero cases so far.",
    "You currently have no completed matters.", "You have currently completed no matters yet.",
    "There are currently no completed cases in your account.", "Your account has zero completed matters.",
    "You have 0 active and 0 completed matters.", "You have no active matters and no completed matters yet.",
    "You have zero active, zero completed, and zero total matters.",
    "There are 0 total matters, 0 active and 0 completed in your account.",
    "You have a total of 0 matters.", "You have 0 matters in total.", "You have no matters overall.",
  ])("accepts source-grounded zero-count wording: %s", reply => {
    const outputs = [overview()];
    expect(supportedAccountOverviewSentence(reply, outputs, { accountOwnerId: OWNER, now: NOW })).toBe(true);
    expect(errors(reply, outputs)).toEqual([]);
  });
  test.each([
    "You have 2 active and 1 completed matters.",
    "You have two active matters and one completed matter.",
    "There are currently 2 active, 1 completed, and 3 total matters.",
    "You have 3 matters in total, 2 active and 1 completed.",
    "Your account has 3 total matters and 1 completed matter.",
    "You've completed one matter so far.",
  ])("binds ordinary combined/nonzero counts to their exact measures: %s", reply => {
    const outputs = [overview({ active: 2, completed: 1 })];
    expect(supportedAccountOverviewSentence(reply, outputs, { accountOwnerId: OWNER, now: NOW })).toBe(true);
    expect(errors(reply, outputs)).toEqual([]);
  });
  test.each([
    "You have 2 completed matters.", "You have 7 total matters.", "You have 1 active matter.",
    "You've completed two matters.", "You have 3 total, 1 active and 2 completed matters.",
  ])("rejects invented or swapped counts through the real semantic audit: %s", reply => {
    expect(errors(reply, [overview({ active: 2, completed: 1 })])).toContain("unsupported_status_or_lifecycle_claim");
  });
  test.each([
    "Your matter is completed.", "You have 0 completed matters and your case is completed.",
    "You have 0 completed matters because your payment was released.",
    "You have 0 completed matters on August 3, 2026.", "You will have 0 completed matters.",
    "They have 0 completed matters.", "You have 0 completed matters for another attorney.",
    "You have 0 completed and 0 completed matters.", "You have 0 active and 0 completed tasks.",
    "You have 0 completed matters; your payout is released.",
    "You have -1 completed matters.", "You have 0.5 completed matters.",
  ])("does not parse arbitrary prose, other subjects, duplicate measures, or non-count claims: %s", reply => {
    expect(aggregateCountClaims(reply)).toEqual([]);
    expect(supportedAccountOverviewSentence(reply, [overview()], { accountOwnerId: OWNER, now: NOW })).toBe(false);
  });
  test("supports exact active/completed totals and rejects a wrong measure even when that number exists elsewhere", () => {
    const entry = overview({ active: 2, completed: 1 });
    expect(errors("You have 2 active and 1 completed matters.", [entry])).toEqual([]);
    expect(errors("You have 2 completed matters.", [entry])).toContain("unsupported_status_or_lifecycle_claim");
    expect(errors("You have completed 7 cases.", [entry])).toContain("live_status_without_live_evidence");
  });
  test.each([
    ["stale", e => { e.result.evidence.observedAt = new Date(NOW - 60001).toISOString(); }],
    ["future", e => { e.result.evidence.observedAt = new Date(NOW + 1).toISOString(); }],
    ["unverified", e => { e.result.evidenceState = "unknown"; }],
    ["unauthorized", e => { e.result.evidence.authorized = false; }],
    ["wrong declared account", e => { e.result.evidence.subjectId = FOREIGN; }],
    ["wrong role", e => { e.result.role = "paralegal"; }],
    ["corrupt count fact", e => { e.result.evidence.facts.find(f => f.key === "completedCount").value = 1; }],
    ["unsafe integer", e => { e.result.completedCount = Number.MAX_SAFE_INTEGER + 1; }],
  ])("does not admit an aggregate from %s evidence", (_name, change) => {
    const entry = overview(); change(entry);
    expect(errors("You have 0 completed matters.", [entry])).toContain("unsupported_status_or_lifecycle_claim");
  });
  test("requires the same authenticated actor and refuses a JSON-forged binding", () => {
    expect(errors("You have 0 completed matters.", [overview({ owner: { id: FOREIGN, role: "attorney" } })])).toContain("unsupported_status_or_lifecycle_claim");
    const forged = JSON.parse(JSON.stringify(overview())); forged.accountOwnerId = OWNER;
    expect(errors("You have 0 completed matters.", [forged])).toContain("unsupported_status_or_lifecycle_claim");
    expect(errors("You have 0 completed matters.", [overview()], FOREIGN)).toContain("unsupported_status_or_lifecycle_claim");
    expect(errors("You have 0 completed matters.", [])).toContain("unsupported_status_or_lifecycle_claim");
    const partial = bindAccountOverviewToActor({ name: "get_my_case_overview", result: { ok: true, available: true, completedCount: 0 } }, USER);
    expect(errors("You have 0 completed matters.", [partial])).toContain("unsupported_status_or_lifecycle_claim");
  });
  test("total-only count claims retain owner/freshness verification and inconsistent totals cannot support any aggregate", () => {
    expect(errors("You have 0 matters in total.", [overview({ at: NOW - 60001 })])).toContain("unsupported_status_or_lifecycle_claim");
    expect(errors("You have 0 total matters.", [overview()], FOREIGN)).toContain("unsupported_status_or_lifecycle_claim");
    const inconsistent = overview({ active: 2, completed: 1 });
    inconsistent.result.totalCount = 4;
    inconsistent.result.evidence.facts.find(f => f.key === "totalCount").value = 4;
    expect(errors("You have 2 active matters.", [inconsistent])).toContain("unsupported_status_or_lifecycle_claim");
  });
  test("an existing other-owner binding is immutable when a result is accidentally shared", () => {
    const foreign = overview({ owner: { id: FOREIGN, role: "attorney" } });
    bindAccountOverviewToActor(foreign, USER);
    expect(errors("You have 0 completed matters.", [foreign])).toContain("unsupported_status_or_lifecycle_claim");
  });
  test("rebinding an owner-scoped reused result preserves its original timestamp and cannot make it fresh", () => {
    const entry = overview({ at: NOW - 60001 }); entry.reused = true;
    const before = JSON.stringify(entry.result);
    bindAccountOverviewToActor(entry, USER);
    expect(JSON.stringify(entry.result)).toBe(before);
    expect(supportedAccountOverviewSentence("You have 0 completed matters.", [entry], { accountOwnerId: OWNER, now: NOW })).toBe(false);
  });
  test("aggregate evidence never authorizes a specific Matter status, payment, or date, including mixed replies", () => {
    const outputs = [overview()];
    expect(errors("Your matter is completed.", outputs)).toContain("live_status_without_live_evidence");
    expect(errors("Your matter was completed on August 3, 2026.", outputs)).toContain("unsupported_date_claim");
    expect(errors("You have 0 completed matters. Your payout is released.", outputs)).toContain("live_status_without_live_evidence");
    expect(errors("You have 0 completed matters and your case is completed.", outputs)).toContain("unsupported_status_or_lifecycle_claim");
  });
  test("binding has no enumerable field and does not alter provider-visible tool bytes", () => {
    const original = overview(), copied = JSON.parse(JSON.stringify(original));
    const before = JSON.stringify(copied.result);
    bindAccountOverviewToActor(copied, USER);
    expect(JSON.stringify(copied.result)).toBe(before);
    expect(JSON.stringify(copied)).not.toContain(OWNER);
    expect(errors("You have 0 completed matters.", [copied])).toEqual([]);
  });
  test("unchanged Paralegal first-prompt count forms pass while individual status/date guards still deny", () => {
    const outputs = [{ name: "get_paralegal_case_overview", result: { ok: true, available: true, authorized: true, evidenceState: "verified", totalCount: 0, activeCount: 0, completedCount: 0, requestedScope: "all", items: [], evidence: { capabilityId: "P01_assigned_overview", state: "verified", authorized: true, subjectType: "account", policyOrLiveState: "live_state", facts: [{ key: "totalCount", value: 0 }, { key: "activeCount", value: 0 }, { key: "completedCount", value: 0 }] } } }];
    const audit = reply => auditParalegalSemanticResponse({ reply, messageText: "How many assigned matters are active or completed?", toolOutputs: outputs });
    expect(audit("You have 0 active and 0 completed assigned matters.")).toEqual([]);
    expect(audit("Your matter is completed.")).toContain("unsupported_status_claim");
    expect(audit("Your matter deadline is August 3, 2026.")).toContain("unsupported_date_claim");
  });
  test("real manager tool/audit flow accepts the zero-count answer first time and sends no internal owner identity", async () => {
    const keys = ["OPENAI_SUPPORT_MANAGER_ENABLED", "OPENAI_ATTORNEY_MANAGER_ENABLED", "OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT", "OPENAI_ATTORNEY_MANAGER_ALLOWLIST", "OPENAI_SUPPORT_MANAGER_ROLES"];
    const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    Object.assign(process.env, { OPENAI_SUPPORT_MANAGER_ENABLED: "true", OPENAI_ATTORNEY_MANAGER_ENABLED: "true", OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "0", OPENAI_ATTORNEY_MANAGER_ALLOWLIST: OWNER, OPENAI_SUPPORT_MANAGER_ROLES: "attorney" });
    const entry = overview({ at: Date.now() });
    const rawBefore = JSON.stringify(entry.result);
    const parsed = { reply: "You have 0 completed matters.", suggestions: [], navigation: null, primaryAsk: "completed_case_count", activeTask: "FACT_LOOKUP", awaitingField: "", responseMode: "DIRECT_ANSWER", confidence: "high", detailLevel: "concise", evidenceCapability: "account_fact" };
    const parse = jest.fn().mockResolvedValueOnce({ id: "synthetic-call", model: "gpt-5.6-terra", usage: {}, output: [{ type: "function_call", name: "get_my_case_overview", call_id: "count-call", arguments: '{"status_scope":"completed"}' }] }).mockResolvedValueOnce({ id: "synthetic-answer", model: "gpt-5.6-terra", usage: {}, output: [], output_parsed: parsed });
    const executor = jest.fn(async (_name, _args, context) => { expect(context.user.id).toBe(OWNER); return entry.result; });
    try {
      const answer = await generateSupportManagerReply({ messageText: "How many cases have I completed?", user: USER, client: { responses: { parse } }, toolExecutor: executor });
      expect(answer?.reply).toBe(parsed.reply); expect(answer?.provider).toBe("openai_manager");
      expect(answer?.telemetry.validationRetries).toBe(0); expect(answer?.telemetry.validationFailures).toEqual([]);
      expect(parse).toHaveBeenCalledTimes(2); expect(executor).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(entry.result)).toBe(rawBefore);
      for (const [request] of parse.mock.calls) expect(JSON.stringify(request)).not.toContain(OWNER);
    } finally { for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  });
});
