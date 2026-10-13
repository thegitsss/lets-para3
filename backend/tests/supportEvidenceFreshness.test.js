const {
  EVIDENCE_FRESHNESS_MS,
  evidenceFreshnessClass,
  priorToolEvidenceFromMessages,
  selectReusableSupportEvidence,
} = require("../ai/supportEvidenceFreshness");

function evidence(name, observedAt, overrides = {}) {
  return {
    name,
    args: overrides.args || {},
    result: {
      ok: true,
      available: true,
      evidenceState: "verified",
      evidence: {
        authorized: true,
        state: "verified",
        observedAt,
        facts: [{ key: "status", value: "current" }],
        missingFacts: [],
        ...(overrides.evidence || {}),
      },
      ...(overrides.result || {}),
    },
  };
}

describe("assistant evidence freshness", () => {
  const now = Date.parse("2026-07-23T12:00:00.000Z");
  const ago = (milliseconds) => new Date(now - milliseconds).toISOString();

  test("uses longer policy, shorter live-data, and shortest volatile windows", () => {
    expect(EVIDENCE_FRESHNESS_MS).toEqual({
      policy: 15 * 60 * 1000,
      live: 60 * 1000,
      volatile: 10 * 1000,
    });
    expect(evidenceFreshnessClass("search_lpc_knowledge")).toBe("policy");
    expect(evidenceFreshnessClass("find_navigation_destination")).toBe("policy");
    expect(evidenceFreshnessClass("get_attorney_workflow_readiness")).toBe("volatile");
    expect(evidenceFreshnessClass("get_paralegal_workflow_readiness")).toBe("volatile");
    expect(evidenceFreshnessClass("get_paralegal_case_workspace")).toBe("live");
    expect(evidenceFreshnessClass("get_attorney_account_snapshot")).toBe("live");
    expect(evidenceFreshnessClass("get_attorney_message_activity")).toBe("volatile");
    expect(evidenceFreshnessClass("get_paralegal_payout_history")).toBe("volatile");
    expect(evidenceFreshnessClass("unregistered_future_tool")).toBe("volatile");
  });

  test("reuses each evidence type only inside its applicable window", () => {
    const required = [
      "search_lpc_knowledge",
      "get_attorney_case_workspace",
      "get_attorney_message_activity",
    ];
    const selected = selectReusableSupportEvidence(required, [
      evidence("search_lpc_knowledge", ago(14 * 60 * 1000)),
      evidence("get_attorney_case_workspace", ago(59 * 1000)),
      evidence("get_attorney_message_activity", ago(9 * 1000)),
    ], { now });
    expect(selected.requiredToolNames).toEqual([]);

    const expired = selectReusableSupportEvidence(required, [
      evidence("search_lpc_knowledge", ago(15 * 60 * 1000 + 1)),
      evidence("get_attorney_case_workspace", ago(60 * 1000 + 1)),
      evidence("get_attorney_message_activity", ago(10 * 1000 + 1)),
    ], { now });
    expect(expired.requiredToolNames).toEqual(required);
  });

  test("forces fresh retrieval for refreshes, subject changes, failures, gaps, and authorization problems", () => {
    const name = "get_paralegal_case_workspace";
    const current = evidence(name, ago(1000), {
      evidence: { matterId: "matter-1" },
    });
    expect(selectReusableSupportEvidence([name], [current], {
      now,
      activeEntity: { id: "matter-1" },
      refreshRequested: true,
    }).requiredToolNames).toEqual([name]);
    expect(selectReusableSupportEvidence([name], [current], {
      now,
      activeEntity: { id: "matter-1" },
      subjectChanged: true,
    }).requiredToolNames).toEqual([name]);
    expect(selectReusableSupportEvidence([name], [current], {
      now,
      activeEntity: { id: "matter-2" },
    }).requiredToolNames).toEqual([name]);

    const incomplete = evidence(name, ago(1000), {
      evidence: { missingFacts: ["status"] },
    });
    const unauthorized = evidence(name, ago(1000), {
      evidence: { authorized: false },
    });
    const failed = evidence(name, ago(1000), {
      result: { ok: false },
    });
    for (const entry of [incomplete, unauthorized, failed]) {
      expect(selectReusableSupportEvidence([name], [entry], { now }).requiredToolNames)
        .toEqual([name]);
    }
  });

  test("collects the newest stored evidence for each tool from assistant messages", () => {
    const olderWorkspace = evidence("get_attorney_case_workspace", ago(20_000));
    const newerWorkspace = evidence("get_attorney_case_workspace", ago(5_000));
    const policy = evidence("search_lpc_knowledge", ago(60_000));
    const result = priorToolEvidenceFromMessages([
      {
        sender: "assistant",
        metadata: { supportFacts: { toolEvidence: [olderWorkspace, policy] } },
      },
      { sender: "user", metadata: {} },
      {
        sender: "assistant",
        metadata: { supportFacts: { toolEvidence: [newerWorkspace] } },
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(newerWorkspace);
    expect(result[1]).toBe(policy);
  });
});
