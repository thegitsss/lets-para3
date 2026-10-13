const EVIDENCE_FRESHNESS_MS = Object.freeze({
  policy: 15 * 60 * 1000,
  live: 60 * 1000,
  volatile: 10 * 1000,
});

const POLICY_TOOLS = new Set([
  "search_lpc_knowledge",
  "find_navigation_destination",
  "find_paralegal_navigation_destination",
]);

const VOLATILE_TOOLS = new Set([
  "get_attorney_case_financials",
  "get_attorney_receipt_history",
  "get_attorney_message_activity",
  "get_billing_snapshot",
  "get_attorney_billing_summary",
  "get_payout_snapshot",
  "get_messaging_state",
  "get_attorney_workflow_readiness",
  "get_paralegal_payout_setup",
  "get_paralegal_payout_history",
  "get_paralegal_case_financials",
  "get_paralegal_workflow_readiness",
  "get_paralegal_messaging_state",
]);

const LIVE_TOOLS = new Set([
  "get_my_case_overview",
  "get_case_details",
  "get_attorney_case_workspace",
  "get_attorney_account_snapshot",
  "get_next_deadline",
  "get_pending_paralegal_activity",
  "get_attorney_application_activity",
  "get_attorney_attention_summary",
  "get_attorney_matter_readiness",
  "get_attorney_deactivation_eligibility",
  "get_paralegal_case_overview",
  "get_paralegal_case_workspace",
  "get_paralegal_application_activity",
  "get_paralegal_invitation_activity",
  "get_paralegal_attention_summary",
  "get_paralegal_account_snapshot",
  "get_paralegal_deactivation_eligibility",
]);

function evidenceFreshnessClass(toolName = "") {
  const normalized = String(toolName || "").trim();
  if (POLICY_TOOLS.has(normalized)) return "policy";
  if (LIVE_TOOLS.has(normalized)) return "live";
  if (VOLATILE_TOOLS.has(normalized)) return "volatile";
  return "volatile";
}

function evidenceFreshnessMs(toolName = "") {
  return EVIDENCE_FRESHNESS_MS[evidenceFreshnessClass(toolName)];
}

function evidenceObservedAt(entry = {}) {
  const result = entry?.result && typeof entry.result === "object" ? entry.result : {};
  const evidence = result.evidence && typeof result.evidence === "object"
    ? result.evidence
    : {};
  return Date.parse(
    String(
      evidence.observedAt ||
      result.observedAt ||
      entry.observedAt ||
      ""
    )
  );
}

function evidenceSubjectId(entry = {}) {
  const result = entry?.result && typeof entry.result === "object" ? entry.result : {};
  const evidence = result.evidence && typeof result.evidence === "object"
    ? result.evidence
    : {};
  const args = entry?.args && typeof entry.args === "object" ? entry.args : {};
  return String(
    evidence.matterId ||
    evidence.subjectId ||
    evidence.caseId ||
    result.caseId ||
    result.matterId ||
    result.case?.caseId ||
    args.case_id ||
    args.matter_id ||
    args.caseId ||
    args.matterId ||
    ""
  ).trim();
}

function isCompleteAuthorizedEvidence(entry = {}) {
  const result = entry?.result && typeof entry.result === "object" ? entry.result : {};
  const evidence = result.evidence && typeof result.evidence === "object"
    ? result.evidence
    : {};
  const state = String(result.evidenceState || evidence.state || "").toLowerCase();
  return result.ok === true &&
    result.available !== false &&
    result.clarificationNeeded !== true &&
    evidence.authorized !== false &&
    !["unknown", "temporarily_unavailable", "unauthorized"].includes(state) &&
    Array.isArray(evidence.facts) &&
    evidence.facts.length > 0 &&
    (!Array.isArray(evidence.missingFacts) || evidence.missingFacts.length === 0);
}

function selectReusableSupportEvidence(
  requiredToolNames = [],
  priorToolOutputs = [],
  {
    now = Date.now(),
    activeEntity = null,
    refreshRequested = false,
    subjectChanged = false,
  } = {}
) {
  const required = new Set(
    (Array.isArray(requiredToolNames) ? requiredToolNames : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  if (refreshRequested === true || subjectChanged === true) {
    return { reusable: [], requiredToolNames: [...required] };
  }

  const activeId = String(activeEntity?.id || "").trim();
  const reusable = [];
  for (const entry of Array.isArray(priorToolOutputs) ? priorToolOutputs : []) {
    const name = String(entry?.name || "").trim();
    if (!required.has(name) || !isCompleteAuthorizedEvidence(entry)) continue;
    const observedAt = evidenceObservedAt(entry);
    const ageMs = now - observedAt;
    const current =
      Number.isFinite(observedAt) &&
      ageMs >= 0 &&
      ageMs <= evidenceFreshnessMs(name);
    const subjectId = evidenceSubjectId(entry);
    const subjectMatches = !activeId || !subjectId || subjectId === activeId;
    if (current && subjectMatches) reusable.push(entry);
  }

  const reusableNames = new Set(reusable.map((entry) => String(entry.name || "")));
  return {
    reusable,
    requiredToolNames: [...required].filter((name) => !reusableNames.has(name)),
  };
}

function priorToolEvidenceFromMessages(messages = [], limit = 24) {
  const collected = [];
  const seen = new Set();
  const newestFirst = [...(Array.isArray(messages) ? messages : [])].reverse();
  for (const message of newestFirst) {
    if (message?.sender !== "assistant") continue;
    const evidence = message?.metadata?.supportFacts?.toolEvidence;
    if (!Array.isArray(evidence)) continue;
    for (const entry of evidence) {
      const name = String(entry?.name || "").trim();
      if (
        !name ||
        seen.has(name) ||
        !entry?.result ||
        typeof entry.result !== "object"
      ) {
        continue;
      }
      collected.push(entry);
      seen.add(name);
      if (collected.length >= limit) return collected;
    }
  }
  return collected;
}

module.exports = {
  EVIDENCE_FRESHNESS_MS,
  evidenceFreshnessClass,
  evidenceFreshnessMs,
  evidenceObservedAt,
  evidenceSubjectId,
  isCompleteAuthorizedEvidence,
  priorToolEvidenceFromMessages,
  selectReusableSupportEvidence,
};
