const ATTORNEY_EVIDENCE_CAPABILITIES = Object.freeze({
  GENERAL_WORKFLOW: "general_workflow",
  POSTING: "posting",
  APPLICATIONS: "applications",
  HIRING: "hiring",
  FUNDING: "funding",
  POST_HIRE_WORKFLOW: "post_hire_workflow",
  WORKSPACE_ACCESS: "workspace_access",
  COMPLETION: "completion",
  PAYOUT_RELEASE: "payout_release",
  DEPOSIT_TIMING: "deposit_timing",
  MESSAGING_POLICY: "messaging_policy",
});

const WORKFLOW_CAPABILITY_IDS = Object.freeze({
  general_workflow: "A31_product_knowledge",
  posting: "A11_posting",
  applications: "A07_applications",
  hiring: "A10_hiring",
  funding: "A12_funding",
  post_hire_workflow: "A10_hiring",
  workspace_access: "A04_scope_tasks",
  completion: "A26_completion",
  payout_release: "A26_completion",
  deposit_timing: "A15_case_financials",
  messaging_policy: "A17_messages",
});

const TOOL_CAPABILITY_IDS = Object.freeze({
  get_my_case_overview: "A01_matter_overview",
  get_case_details: "A02_matter_details",
  get_attorney_case_workspace: "A02_matter_details",
  get_next_deadline: "A03_deadlines",
  get_attorney_application_activity: "A07_applications",
  get_attorney_matter_readiness: "A10_hiring",
  get_billing_snapshot: "A13_payment_method",
  get_attorney_billing_summary: "A14_billing_summary",
  get_attorney_case_financials: "A15_case_financials",
  get_attorney_receipt_history: "A16_receipts",
  get_attorney_message_activity: "A17_messages",
  get_messaging_state: "A17_messages",
  get_pending_paralegal_activity: "A18_pending_paralegal",
  get_attorney_attention_summary: "A19_attention",
  get_attorney_account_snapshot: "A20_profile",
  get_attorney_deactivation_eligibility: "A23_deactivation",
  find_navigation_destination: "A30_navigation",
  search_lpc_knowledge: "A31_product_knowledge",
});

const FAILURE_CLASSES = Object.freeze({
  PLANNER_NO_CAPABILITY: "planner_no_capability",
  PLANNER_WRONG_SOURCE: "planner_wrong_source",
  TOOL_AUTHORIZATION_DENIED: "tool_authorization_denied",
  TOOL_ERROR: "tool_error",
  EVIDENCE_EMPTY: "evidence_empty",
  EVIDENCE_MISSING_REQUIRED_FACT: "evidence_missing_required_fact",
  EVIDENCE_CONTRADICTION: "evidence_contradiction",
  GENERATION_UNSUPPORTED_CLAIM: "generation_unsupported_claim",
  GENERATION_POLICY_LIVE_STATE_CONFUSION: "generation_policy_live_state_confusion",
  GENERATION_PERMISSION_ERROR: "generation_permission_error",
  OPTIONAL_UI_INVALID: "optional_ui_invalid",
  STYLE_REPAIR_REQUIRED: "style_repair_required",
  VALIDATOR_INTERNAL_ERROR: "validator_internal_error",
});

function normalizeCapability(value = "") {
  const original = String(value || "").trim();
  if (/^A\d{2}_[a-z0-9_]+$/i.test(original)) return original;
  const normalized = original.toLowerCase();
  return Object.values(ATTORNEY_EVIDENCE_CAPABILITIES).includes(normalized)
    ? normalized
    : ATTORNEY_EVIDENCE_CAPABILITIES.GENERAL_WORKFLOW;
}

function capabilityIdFor({ toolName = "", capability = "" } = {}) {
  if (toolName === "get_attorney_workflow_readiness") {
    return WORKFLOW_CAPABILITY_IDS[normalizeCapability(capability)] || WORKFLOW_CAPABILITY_IDS.general_workflow;
  }
  return TOOL_CAPABILITY_IDS[toolName] || "";
}

function atomicFact(key, value, options = {}) {
  return {
    key,
    value,
    claimType: options.claimType || "fact",
    policyOrLiveState: options.policyOrLiveState || "live_state",
    subjectType: options.subjectType || "attorney_account",
    subjectId: options.subjectId || "",
    matterId: options.matterId || "",
    sourceRef: options.sourceRef || "",
  };
}

function workflowFacts(result = {}) {
  const requirements = result.requirements || {};
  const postHire = requirements.postHireWorkflow || {};
  const payout = requirements.paralegalPayoutTiming || {};
  const hireStage = result.stages?.hire_and_fund || {};
  const workflowStages = result.stages || {};
  const hiringSequence = [
    workflowStages.post_matter?.label,
    workflowStages.receive_applications?.label,
    workflowStages.invite_paralegal?.label,
    workflowStages.pre_engagement?.label,
    workflowStages.hire_and_fund?.label,
  ].filter(Boolean);
  const policy = { policyOrLiveState: "policy", subjectType: "lpc_workflow" };
  return [
    atomicFact("workflow.hiring_sequence", hiringSequence.length ? hiringSequence : undefined, policy),
    atomicFact("posting.payment_method_required", requirements.paymentMethodRequiredBeforePosting, policy),
    atomicFact("applications.payment_method_required", requirements.paymentMethodRequiredBeforeApplications, policy),
    atomicFact("hiring.payment_method_required", requirements.paymentMethodRequiredBeforeHiring, policy),
    atomicFact("hiring.minimum_matter_amount_cents", hireStage.minimumMatterAmountCents, policy),
    atomicFact("hiring.scope_task_required", hireStage.scopeTaskRequired, policy),
    atomicFact("hiring.paralegal_payout_setup_required", hireStage.paralegalPayoutSetupRequired, policy),
    atomicFact("hiring.required_processor_state", hireStage.requiredProcessorState, policy),
    atomicFact("hiring.charge_timing", requirements.chargeTiming, policy),
    atomicFact("hiring.resulting_matter_status", postHire.matterStatus, { ...policy, claimType: "lifecycle_transition" }),
    atomicFact("hiring.resulting_funding_status", postHire.fundingStatus, { ...policy, claimType: "lifecycle_transition" }),
    atomicFact("hiring.scope_tasks_locked", postHire.scopeTasksLocked, policy),
    atomicFact("hiring.next_stage", postHire.nextStage, { ...policy, claimType: "lifecycle_transition" }),
    atomicFact("workspace.participants", postHire.workspaceParticipants, { ...policy, claimType: "permission" }),
    atomicFact("workspace.supports", postHire.workspaceSupports, { ...policy, claimType: "permission" }),
    atomicFact("workspace.next_stage", postHire.completionStage, { ...policy, claimType: "lifecycle_transition" }),
    atomicFact("completion.actor", "attorney", { ...policy, claimType: "permission" }),
    atomicFact("completion.all_scope_tasks_required", payout.allScopeTasksCompleteRequired, policy),
    atomicFact("completion.verified_funding_required", payout.verifiedFundingRequired, policy),
    atomicFact("completion.paralegal_payout_setup_required", payout.paralegalPayoutSetupRequired, policy),
    atomicFact("completion.payout_release_trigger", payout.releaseTrigger, { ...policy, claimType: "lifecycle_transition" }),
    atomicFact("completion.resulting_matter_status", payout.resultingMatterStatus, { ...policy, claimType: "lifecycle_transition" }),
    atomicFact("completion.payment_released", payout.paymentReleased, { ...policy, claimType: "lifecycle_transition" }),
    atomicFact("payout.bank_deposit_estimate_business_days", payout.bankDepositEstimateBusinessDays, { ...policy, claimType: "time_estimate" }),
    atomicFact("payout.bank_deposit_timing_dependencies", payout.bankDepositTimingDependsOn, policy),
    atomicFact("account.payment_method_state_known", result.paymentMethod?.stateKnown, { policyOrLiveState: "live_state" }),
    atomicFact("account.payment_method_saved", result.paymentMethod?.saved, { policyOrLiveState: "live_state" }),
    atomicFact("account.payment_method_usable", result.paymentMethod?.usable, { policyOrLiveState: "live_state" }),
  ].filter((fact) => fact.value !== undefined && fact.value !== null && fact.value !== "");
}

function genericFacts(result = {}, metadata = {}) {
  const facts = [];
  const visit = (value, key, depth = 0) => {
    if (value === undefined || value === null || depth > 5) return;
    if (Array.isArray(value)) {
      if (value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
        facts.push(atomicFact(key, value, metadata));
      } else {
        value.slice(0, 8).forEach((item, index) => visit(item, `${key}.${index}`, depth + 1));
      }
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([childKey, childValue]) =>
        visit(childValue, key ? `${key}.${childKey}` : childKey, depth + 1)
      );
      return;
    }
    const claimType = /(?:^|\.)(?:status|state)$/i.test(key)
      ? "status"
      : /(?:deadline|date|At)$/i.test(key)
        ? "date"
        : /(?:allowed|permission|eligible|ready)$/i.test(key)
          ? "permission"
          : "fact";
    facts.push(atomicFact(key, value, { ...metadata, claimType }));
  };
  Object.entries(result)
    .filter(([key, value]) => !["evidence", "ok"].includes(key) && value !== undefined)
    .forEach(([key, value]) => visit(value, key));
  return facts;
}

function missingWorkflowFacts(capability, facts) {
  const keys = new Set(facts.map((fact) => fact.key));
  const requiredByCapability = {
    hiring: ["workflow.hiring_sequence", "hiring.charge_timing", "hiring.resulting_matter_status", "hiring.resulting_funding_status"],
    post_hire_workflow: ["hiring.resulting_matter_status", "hiring.resulting_funding_status", "hiring.next_stage", "workspace.participants", "workspace.supports", "workspace.next_stage"],
    payout_release: ["completion.payout_release_trigger", "completion.actor"],
    deposit_timing: ["completion.payout_release_trigger", "payout.bank_deposit_estimate_business_days"],
    workspace_access: ["workspace.participants", "workspace.supports"],
    messaging_policy: ["workspace.participants", "workspace.supports"],
    completion: ["completion.actor", "completion.all_scope_tasks_required", "completion.payout_release_trigger"],
  };
  return (requiredByCapability[capability] || []).filter((key) => !keys.has(key));
}

function normalizeAttorneyToolEvidence({ toolName = "", result = {}, args = {}, retrievedAt = new Date().toISOString() } = {}) {
  const capability = toolName === "get_attorney_workflow_readiness"
    ? normalizeCapability(args.capability)
    : capabilityIdFor({ toolName });
  const unauthorized = /access|required_for_role|not_available_for_role|unauthor/i.test(String(result.reason || result.error || ""));
  const authorized = !unauthorized;
  const policyTool = toolName === "get_attorney_workflow_readiness";
  const subjectId = String(result.userId || result.accountId || "");
  const matterId = String(result.caseId || result.matterId || result.case?._id || result.case?.caseId || "");
  const facts = policyTool
    ? workflowFacts(result)
    : genericFacts(result, { subjectId, matterId, subjectType: matterId ? "matter" : "attorney_account" });
  return {
    capability,
    capabilityId: capabilityIdFor({ toolName, capability }),
    sourceType: policyTool ? "executable_workflow_policy" : "authorized_tool_snapshot",
    policyOrLiveState: policyTool ? "mixed" : "live_state",
    subjectType: matterId ? "matter" : policyTool ? "lpc_workflow" : "attorney_account",
    subjectId,
    matterId,
    retrievedAt,
    authorized,
    facts,
    allowedActions: ["read", "explain", "navigate_when_authorized"],
    prohibitedActions: ["mutate_record", "complete_workflow_action", "access_other_user_data"],
    citations: [policyTool ? "attorneyWorkflowPolicy" : toolName],
    missingFacts: policyTool ? missingWorkflowFacts(capability, facts) : [],
  };
}

function factValue(evidence = {}, key = "") {
  return (evidence.facts || []).find((fact) => fact.key === key)?.value;
}

function findEvidenceContradictions(evidenceEnvelopes = []) {
  const valuesByScopeAndKey = new Map();
  const contradictions = [];
  for (const evidence of evidenceEnvelopes) {
    if (evidence?.authorized !== true) continue;
    for (const fact of evidence.facts || []) {
      const scope = `${fact.policyOrLiveState}|${fact.subjectType}|${fact.subjectId}|${fact.matterId}|${fact.key}`;
      const serialized = JSON.stringify(fact.value);
      if (valuesByScopeAndKey.has(scope) && valuesByScopeAndKey.get(scope) !== serialized) {
        contradictions.push(fact.key);
      } else {
        valuesByScopeAndKey.set(scope, serialized);
      }
    }
  }
  return [...new Set(contradictions)];
}

function renderAttorneyEvidenceAnswer({ capability = "", evidenceEnvelopes = [] } = {}) {
  const normalized = normalizeCapability(capability);
  const contradictions = findEvidenceContradictions(evidenceEnvelopes);
  if (contradictions.length) {
    return { ok: false, failureClass: FAILURE_CLASSES.EVIDENCE_CONTRADICTION, contradictions, reply: "" };
  }
  const evidence = evidenceEnvelopes.find((item) => item?.authorized === true && item?.capability === normalized) ||
    evidenceEnvelopes.find((item) => item?.authorized === true && item?.sourceType === "executable_workflow_policy");
  if (!evidence || !Array.isArray(evidence.facts) || evidence.facts.length === 0) {
    return { ok: false, failureClass: FAILURE_CLASSES.EVIDENCE_EMPTY, reply: "" };
  }
  const value = (key) => factValue(evidence, key);
  const missing = [];
  let reply = "";
  if (normalized === "hiring") {
    const sequence = value("workflow.hiring_sequence");
    const chargeTiming = value("hiring.charge_timing");
    const status = value("hiring.resulting_matter_status");
    const funding = value("hiring.resulting_funding_status");
    if (!Array.isArray(sequence) || !sequence.length) missing.push("workflow.hiring_sequence");
    const steps = Array.isArray(sequence) && sequence.length
      ? sequence.map((item) => String(item).replace(/_/g, " ").replace(/^(?:post|receive|invite|request|hire)\s+/i, "").toLowerCase())
      : [];
    const process = steps.length >= 5
      ? `Post a matter, review the applications, invite the paralegal you want, complete any required pre-engagement items, and then confirm the hire.`
      : "Choose a paralegal for your posted matter and complete the required hiring steps.";
    const outcome = chargeTiming === "charged_when_hire_is_confirmed"
      ? `LPC charges your saved payment method when you confirm; after payment succeeds, the matter is ${funding === "funded" ? "funded" : "ready for funding"}${status ? ` and moves to ${String(status).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}` : ""}.`
      : "Follow the confirmation screen to finish hiring and funding the matter.";
    reply = `${process} ${outcome}`;
  } else if (normalized === "post_hire_workflow") {
    const status = value("hiring.resulting_matter_status");
    const funding = value("hiring.resulting_funding_status");
    const supports = value("workspace.supports");
    if (!status) missing.push("hiring.resulting_matter_status");
    const first = status
      ? `After a successful hire${funding ? " and funding" : ""}, the matter moves to ${String(status).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}.`
      : "After a successful hire, the attorney and hired paralegal use the matter workspace.";
    const second = Array.isArray(supports) && supports.length
      ? `The workspace covers ${supports.map((item) => String(item).replace(/_/g, " ")).join(", ")}.`
      : "";
    reply = [first, second].filter(Boolean).join(" ");
  } else if (["payout_release", "deposit_timing", "completion"].includes(normalized)) {
    const trigger = value("completion.payout_release_trigger");
    const estimate = value("payout.bank_deposit_estimate_business_days");
    const dependencies = value("payout.bank_deposit_timing_dependencies");
    if (!trigger) missing.push("completion.payout_release_trigger");
    const release = trigger === "when_attorney_completes_matter"
      ? "The paralegal’s payout is released when the attorney marks the matter complete, after the required scope work, funding, and payout setup are ready."
      : "The payout-release trigger is not available in the verified policy evidence.";
    let deposit = "";
    if (normalized === "deposit_timing") {
      const minimum = Number(estimate?.minimum || 0);
      const maximum = Number(estimate?.maximum || 0);
      deposit = minimum > 0 && maximum >= minimum
        ? `Bank deposit is estimated at ${minimum}–${maximum} business days after release${Array.isArray(dependencies) && dependencies.length ? ", depending on Stripe and the paralegal’s bank" : ""}.`
        : "The current bank-deposit estimate is not available in the verified policy evidence.";
      if (!(minimum > 0 && maximum >= minimum)) missing.push("payout.bank_deposit_estimate_business_days");
    }
    reply = [release, deposit].filter(Boolean).join(" ");
  } else if (normalized === "workspace_access" || normalized === "messaging_policy") {
    const participants = value("workspace.participants");
    const supports = value("workspace.supports");
    if (!participants) missing.push("workspace.participants");
    reply = Array.isArray(participants) && participants.includes("attorney") && participants.includes("hired_paralegal")
      ? `After a successful hire and funding, the attorney and hired paralegal can use the matter workspace${Array.isArray(supports) ? ` for ${supports.map((item) => String(item).replace(/_/g, " ")).join(", ")}` : ""}.`
      : "The workspace-access policy is not fully available in the verified evidence.";
  } else if (normalized === "A01_matter_overview") {
    const scope = value("requestedScope");
    const count = scope === "completed" ? value("completedCount") : scope === "active" ? value("activeCount") : value("totalCount");
    if (!Number.isFinite(Number(count))) missing.push(scope === "completed" ? "completedCount" : scope === "active" ? "activeCount" : "totalCount");
    reply = Number.isFinite(Number(count))
      ? `You have ${Number(count)} ${scope === "completed" ? "completed" : scope === "active" ? "active" : "total"} matter${Number(count) === 1 ? "" : "s"}.`
      : "The requested matter count is not available in the verified account evidence.";
  } else if (normalized === "A13_payment_method") {
    const state = value("available");
    const valid = value("isValid");
    reply = state === true
      ? `You have a saved payment method${valid === false ? ", but it is not currently usable" : ""}.`
      : state === false
        ? "You do not have a saved payment method on file."
        : "The saved payment-method state is currently unavailable.";
  } else if (normalized === "A15_case_financials") {
    const charge = value("totalAttorneyCharge.formatted");
    const payout = value("netParalegalPayout.formatted");
    reply = [
      charge ? `The total attorney charge was ${charge}.` : "",
      payout ? `The net paralegal payout was ${payout}.` : "",
    ].filter(Boolean).join(" ");
    if (!reply) missing.push("totalAttorneyCharge", "netParalegalPayout");
  } else if (normalized === "A02_matter_details") {
    const title = value("title") || value("case.title");
    const status = value("status") || value("case.status");
    reply = status ? `${title || "The matter"} is ${String(status).replace(/_/g, " ")}.` : "";
    if (!reply) missing.push("status");
  } else if (normalized === "A03_deadlines") {
    const deadline = value("deadline") || value("case.deadline");
    reply = deadline ? `The next verified deadline is ${deadline}.` : "No upcoming deadline was present in the authorized evidence.";
  } else if (normalized === "A31_product_knowledge") {
    const answers = evidence.facts
      .filter((fact) => /(?:^|\.)answer$/i.test(fact.key) && typeof fact.value === "string")
      .map((fact) => String(fact.value || "").trim())
      .filter(Boolean);
    reply = answers[0] || "";
    if (!reply) return { ok: false, failureClass: FAILURE_CLASSES.EVIDENCE_MISSING_REQUIRED_FACT, reply: "" };
  } else {
    const excluded = /(?:^|\.)(?:available|found|accessible|role|source|reason|error|retryable|truncated|returnedCaseCount|evidenceState|.*Id|last4)$/i;
    const preferred = /(?:status|count|ready|eligible|saved|blockers?|title|summary|answer|content|text|deadline|amount|total|unread|pending)$/i;
    const presentable = evidence.facts
      .filter((fact) => !excluded.test(fact.key))
      .filter((fact) => ["string", "number", "boolean"].includes(typeof fact.value) ||
        (Array.isArray(fact.value) && fact.value.every((item) => ["string", "number", "boolean"].includes(typeof item))))
      .sort((left, right) => Number(preferred.test(right.key)) - Number(preferred.test(left.key)))
      .slice(0, 3);
    const display = (valueToDisplay) => Array.isArray(valueToDisplay)
      ? valueToDisplay.map((item) => String(item).replace(/_/g, " ")).join(", ")
      : typeof valueToDisplay === "boolean"
        ? valueToDisplay ? "yes" : "no"
        : String(valueToDisplay).replace(/_/g, " ");
    const naturalValues = presentable
      .filter((fact) => /(?:^|\.)(?:answer|summary|content|text)$/i.test(fact.key))
      .map((fact) => display(fact.value));
    reply = naturalValues[0] || "";
    if (!reply) return { ok: false, failureClass: FAILURE_CLASSES.EVIDENCE_MISSING_REQUIRED_FACT, reply: "" };
  }
  return {
    ok: Boolean(reply),
    reply,
    missingFacts: [...new Set([...missing, ...(evidence.missingFacts || [])])],
    failureClass: missing.length ? FAILURE_CLASSES.EVIDENCE_MISSING_REQUIRED_FACT : "",
    evidence,
  };
}

module.exports = {
  ATTORNEY_EVIDENCE_CAPABILITIES,
  FAILURE_CLASSES,
  WORKFLOW_CAPABILITY_IDS,
  capabilityIdFor,
  findEvidenceContradictions,
  factValue,
  normalizeAttorneyToolEvidence,
  normalizeCapability,
  renderAttorneyEvidenceAnswer,
};
