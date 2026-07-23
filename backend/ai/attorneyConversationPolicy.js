const ENTITY_FOLLOW_UP = /^(?:and\s+)?(?:it|that|this|there|they|them|he|she|both|yes|no|why|how much|what about that|same one|same case|same matter)[?.!\s]*$/i;
const CORRECTION_REFERENCE = /\b(?:i meant|not that|the other|other case|other matter|instead)\b/i;

const REQUIREMENTS = Object.freeze({
  matter_financials: ["get_attorney_case_financials"],
  receipt_history: ["get_attorney_receipt_history"],
  workspace: ["get_attorney_case_workspace"],
  matter_readiness: ["get_attorney_matter_readiness"],
  workflow_readiness: ["get_attorney_workflow_readiness"],
  billing_method: ["get_billing_snapshot"],
  billing_summary: ["get_attorney_billing_summary"],
  case_overview: ["get_my_case_overview"],
  case_details: ["get_case_details"],
  next_deadline: ["get_next_deadline"],
  applications: ["get_attorney_application_activity"],
  messages: ["get_attorney_message_activity"],
  pending_paralegal: ["get_pending_paralegal_activity"],
  attention: ["get_attorney_attention_summary"],
  account: ["get_attorney_account_snapshot"],
  deactivation: ["get_attorney_deactivation_eligibility"],
  knowledge: ["search_lpc_knowledge"],
  navigation: ["find_navigation_destination"],
  messaging_state: ["get_messaging_state"],
});

// A deterministic plan establishes the minimum evidence that must be fetched.
// Some live questions span a record snapshot and the executable workflow that
// explains what the record means. Keep those adjacent sources available to the
// model without making the planner depend on exact user wording.
const SUPPLEMENTAL_EVIDENCE_TOOLS = Object.freeze({
  matter_financials: ["get_attorney_workflow_readiness", "get_attorney_matter_readiness"],
  workspace: ["get_attorney_workflow_readiness", "get_attorney_matter_readiness"],
  matter_readiness: ["get_attorney_workflow_readiness"],
});

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\b(?:paymnt|pymnt|paymet)\b/g, "payment")
    .replace(/\b(?:reciepts?|receitps?)\b/g, "receipts")
    .replace(/\b(?:mesages?|msgs?)\b/g, "messages")
    .replace(/\b(?:applicatons?|aplicants?)\b/g, "applications")
    .replace(/\b(?:paralgl|paralgal|para)\b/g, "paralegal")
    .replace(/\b(?:complet|completd)\b/g, "complete")
    .replace(/\bbfore\b/g, "before");
}

function sanitizeEntity(entity = {}) {
  const id = String(entity?.id || "").trim().slice(0, 120);
  const type = String(entity?.type || "").trim().toLowerCase().slice(0, 80);
  if (!id || !type) return null;
  return {
    id,
    type,
    name: String(entity?.name || entity?.label || "").trim().slice(0, 240),
    source: String(entity?.source || "verified_conversation_memory").trim().slice(0, 120),
  };
}

function mergeVerifiedEntities(existing = [], activeEntity = null) {
  const merged = [];
  const add = (entity) => {
    const safe = sanitizeEntity(entity);
    if (!safe) return;
    const duplicate = merged.findIndex((entry) => entry.type === safe.type && entry.id === safe.id);
    if (duplicate >= 0) merged.splice(duplicate, 1);
    merged.unshift(safe);
  };
  (Array.isArray(existing) ? existing : []).slice().reverse().forEach(add);
  add(activeEntity);
  return merged.slice(0, 6);
}

function isCorrectionReference(messageText = "") {
  return CORRECTION_REFERENCE.test(String(messageText || ""));
}

function isReferentialFollowUp(messageText = "") {
  const text = String(messageText || "").trim();
  return ENTITY_FOLLOW_UP.test(text) || /\b(?:it|that|this|there|they|them|he|she|same (?:case|matter|one))\b/i.test(text);
}

function isAccountWideSubjectChange(messageText = "") {
  const text = normalizeText(messageText);
  if (!text || isReferentialFollowUp(text)) return false;
  return /\b(?:all (?:my )?(?:cases|matters|receipts|messages|applications)|how many (?:cases|matters)|my profile|my account|account settings|notification settings|billing summary|payment method|platform fee|how does lpc|what is lpc)\b/i.test(text);
}

function prepareConversationState(messageText = "", state = {}) {
  const activeEntity = sanitizeEntity(state.activeEntity || {});
  const verifiedEntities = mergeVerifiedEntities(state.verifiedEntities || [], activeEntity);
  const base = {
    ...state,
    activeEntity,
    verifiedEntities,
    correctionReference: false,
    correctionAmbiguous: false,
    subjectChanged: false,
  };
  if (isCorrectionReference(messageText)) {
    const alternatives = verifiedEntities.filter(
      (entity) => !activeEntity || entity.type !== activeEntity.type || entity.id !== activeEntity.id
    );
    return {
      ...base,
      activeEntity: alternatives.length === 1 ? alternatives[0] : null,
      verifiedEntities,
      correctionReference: true,
      correctionAmbiguous: alternatives.length !== 1,
    };
  }
  if (isAccountWideSubjectChange(messageText)) {
    return { ...base, activeEntity: null, subjectChanged: Boolean(activeEntity) };
  }
  return base;
}

function addRequirement(list, key, reason) {
  if (!REQUIREMENTS[key] || list.some((entry) => entry.key === key)) return;
  list.push({ key, anyOf: [...REQUIREMENTS[key]], reason });
}

function evidenceToolNamesForPlan(plan = {}) {
  const requirements = Array.isArray(plan.requirements) ? plan.requirements : [];
  return [...new Set(requirements.flatMap((requirement) => [
    ...(requirement.anyOf || []),
    ...(SUPPLEMENTAL_EVIDENCE_TOOLS[requirement.key] || []),
  ]).filter(Boolean))];
}

function buildAttorneyEvidencePlan({
  messageText = "",
  conversationHistory = [],
  conversationState = {},
} = {}) {
  const current = normalizeText(messageText);
  const recent = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .slice(-4)
    .map((entry) => normalizeText(entry?.content))
    .filter(Boolean)
    .join(" ");
  const lastCapabilities = new Set(
    (Array.isArray(conversationState.lastCapabilityIds) ? conversationState.lastCapabilityIds : [])
      .map((value) => String(value || ""))
  );
  const followUp = isReferentialFollowUp(current) || /^(?:both|yes|no|why)$/i.test(current);
  const contextual = followUp ? `${recent} ${current}`.trim() : current;
  const hasMatterContext = Boolean(conversationState.activeEntity?.id) ||
    /\b(?:case|matter|workspace|this|that|it|same one)\b/i.test(contextual) ||
    /\b(?:when is|what is|what's|whats) .+\b(?:due|status)\b/i.test(contextual);
  const requirements = [];

  const asksMatterMoney =
    (/\b(?:how much|amount|charged|charge|fee|payout|paid|gross|net|refund|released)\b/i.test(contextual) && hasMatterContext) ||
    (followUp && /\b(?:amount|charged|charge|payout|paid|gross|net)\b/i.test(contextual)) ||
    (followUp && lastCapabilities.has("A15_case_financials"));
  if (asksMatterMoney && !/\bbilling summary\b/i.test(current)) {
    addRequirement(requirements, "matter_financials", "matter-specific financial answer");
  }

  if (/\b(?:receipts?|invoices?)\b/i.test(current)) {
    addRequirement(requirements, "receipt_history", "account-wide receipt answer");
  }

  const workspaceTopic = /\b(?:tasks?|files?|deliverables?|applicants?|applied|deadlines?|due|due dates?|invitations?|invites?|pre[ -]?engagement|disputes?|termination|withdrawal|relist|archive|purge|zoom|moderation|flagged|participants?)\b/i.test(contextual);
  if (workspaceTopic && hasMatterContext) {
    addRequirement(requirements, "workspace", "complete matter workspace answer");
  }

  const matterEligibility = /\b(?:can i|ready|blocked|blocker|why can(?:not|'t|’t)|what (?:do i|needs to) (?:do|happen)|eligible)\b/i.test(current) &&
    /\b(?:invite|pre[ -]?engagement|hire|fund(?:ing|ed)?|workspace|message|complete|release|withdraw|terminate|relist|archive|download)\b/i.test(contextual) &&
    hasMatterContext;
  if (matterEligibility) addRequirement(requirements, "matter_readiness", "matter workflow eligibility");

  const workflowPrerequisite = /\b(?:need|needed|required|requirement|prerequisite|before|first|ready|can i|have to|must|why can(?:not|'t|’t))\b/i.test(current) &&
    /\b(?:payment method|billing method|saved card|card on file|post(?:ing)?|publish(?:ing)?|applications?|hiring?|funding?)\b/i.test(contextual) &&
    !matterEligibility;
  if (workflowPrerequisite) addRequirement(requirements, "workflow_readiness", "platform workflow prerequisite");

  if (/\b(?:do i have|is there|have i got|on file|saved)\b.*\b(?:payment(?: method)?|card|billing method)\b|\b(?:payment(?: method)?|card|billing method)\b.*\b(?:saved|on file)\b/i.test(current)) {
    addRequirement(requirements, "billing_method", "current account payment-method state");
  }
  if (/\b(?:billing summary|total (?:spent|funded)|how much have i spent|pending funding|export (?:my )?billing|billing histor(?:y|ies))\b/i.test(current)) {
    addRequirement(requirements, "billing_summary", "account-wide billing aggregate");
  }
  if (/\b(?:how many|count|break down)\b.*\b(?:cases|matters)|\b(?:completed|active|open) (?:case|matter) count\b/i.test(current)) {
    addRequirement(requirements, "case_overview", "account-wide matter count");
  }
  if (/\b(?:status|who is assigned|assigned paralegal)\b/i.test(current) && hasMatterContext && !workspaceTopic) {
    addRequirement(requirements, "case_details", "named matter state");
  }
  if (/\b(?:next deadline|anything overdue|upcoming deadline)\b/i.test(current) && !hasMatterContext) {
    addRequirement(requirements, "next_deadline", "account-wide deadline");
  }
  if (/\b(?:who applied|new applicants?|applications? waiting|pending applications?)\b/i.test(current) && !hasMatterContext) {
    addRequirement(requirements, "applications", "account-wide application activity");
  }
  if (/\b(?:unread messages?|who needs a reply|messages? waiting|message activity)\b/i.test(current) && !hasMatterContext) {
    addRequirement(requirements, "messages", "account-wide message activity");
  }
  if (/\b(?:can i|able to|allowed to)\b.*\bmessage\b/i.test(current) && hasMatterContext) {
    addRequirement(requirements, "messaging_state", "matter messaging permission");
  }
  if (/\b(?:waiting on|owe me|pending from)\b.*\bparalegal\b|\bparalegal\b.*\b(?:waiting|pending|reply)\b/i.test(current)) {
    addRequirement(requirements, "pending_paralegal", "explicitly attributable paralegal activity");
  }
  if (/\b(?:what needs my attention|catch me up|what should i handle|priorit(?:y|ize))\b/i.test(current)) {
    addRequirement(requirements, "attention", "account attention summary");
  }
  if (/\b(?:profile|onboarding|preferences?|notifications?|two[ -]?factor|2fa|security settings)\b/i.test(current)) {
    addRequirement(requirements, "account", "account/profile state");
  }
  if (/\b(?:deactivate|deactivation|disable my account|close my account)\b/i.test(current)) {
    addRequirement(requirements, "deactivation", "account deactivation eligibility");
  }
  if (/\b(?:what is lpc|how does lpc|explain (?:lpc|the platform))\b/i.test(current) ||
      (/\bplatform fee\b/i.test(current) && !hasMatterContext)) {
    addRequirement(requirements, "knowledge", "general approved product explanation");
  }
  if (
    /\b(?:go to|take me to|where(?:\s+(?:is|are))?|navigate)\b/i.test(current) ||
    /\bopen\b.*\b(?:billing|cases?|profile|settings|messages?|support|dashboard)\b/i.test(current)
  ) {
    addRequirement(requirements, "navigation", "authorized navigation");
  }

  const plannedKeys = new Set(requirements.map((requirement) => requirement.key));
  if (plannedKeys.has("matter_financials") && plannedKeys.has("workspace")) {
    addRequirement(
      requirements,
      "workflow_readiness",
      "explain the relationship between live work state and payment state"
    );
  }

  return {
    requirements,
    compound: requirements.length > 1,
    followUp,
    correction: isCorrectionReference(current),
    hasMatterContext,
    refreshRequested: /\b(?:refresh|check again|recheck|updated now|latest right now)\b/i.test(current),
    conversationState: prepareConversationState(current, conversationState),
  };
}

function selectReusableAttorneyEvidence(
  plan = {},
  priorToolOutputs = [],
  { now = Date.now(), activeEntity = null } = {}
) {
  return selectReusableSupportEvidence(
    evidenceToolNamesForPlan(plan),
    priorToolOutputs,
    {
      now,
      activeEntity: activeEntity || plan.conversationState?.activeEntity || null,
      refreshRequested: plan.refreshRequested === true,
      subjectChanged: plan.conversationState?.subjectChanged === true,
    }
  );
}

function auditAttorneyToolTrace(plan = {}, toolOutputs = []) {
  const outputs = Array.isArray(toolOutputs) ? toolOutputs : [];
  const successful = outputs.filter((entry) => entry?.result?.ok === true);
  const missing = (plan.requirements || []).filter(
    (requirement) => !successful.some((entry) => requirement.anyOf.includes(entry.name))
  );
  const repeated = [];
  const allowed = new Set(evidenceToolNamesForPlan(plan));
  const unrelated = plan.requirements?.length
    ? successful.filter((entry) => !allowed.has(entry.name)).map((entry) => entry.name)
    : [];
  const sufficientByToolAndSubject = new Set();
  const subjectKey = (entry = {}) => {
    const evidenceMatterId = String(entry?.result?.evidence?.matterId || "").trim();
    if (evidenceMatterId) return `matter:${evidenceMatterId}`;
    const args = entry?.args && typeof entry.args === "object" ? entry.args : {};
    for (const key of ["case_reference", "case_id", "matter_reference", "matter_id", "application_id", "job_id"]) {
      const value = String(args[key] || "").trim().toLowerCase();
      if (value) return `${key}:${value}`;
    }
    return "shared";
  };
  const hasSufficientCurrentEvidence = (entry = {}) => {
    const result = entry?.result || {};
    const evidence = result.evidence || {};
    const state = String(result.evidenceState || evidence.state || "").toLowerCase();
    return result.ok === true &&
      result.available !== false &&
      result.clarificationNeeded !== true &&
      evidence.authorized !== false &&
      !["unknown", "temporarily_unavailable", "unauthorized"].includes(state) &&
      Array.isArray(evidence.facts) && evidence.facts.length > 0 &&
      (!Array.isArray(evidence.missingFacts) || evidence.missingFacts.length === 0);
  };
  for (const entry of outputs) {
    const name = String(entry?.name || "");
    const key = `${name}|${subjectKey(entry)}`;
    if (name && sufficientByToolAndSubject.has(key)) repeated.push(name);
    if (name && hasSufficientCurrentEvidence(entry)) sufficientByToolAndSubject.add(key);
  }
  return {
    sufficient: missing.length === 0,
    missing,
    repeated: [...new Set(repeated.filter(Boolean))],
    unrelated: [...new Set(unrelated.filter(Boolean))],
    successful,
  };
}

module.exports = {
  REQUIREMENTS,
  auditAttorneyToolTrace,
  buildAttorneyEvidencePlan,
  evidenceToolNamesForPlan,
  isAccountWideSubjectChange,
  isCorrectionReference,
  isReferentialFollowUp,
  mergeVerifiedEntities,
  prepareConversationState,
  sanitizeEntity,
  selectReusableAttorneyEvidence,
};
const {
  selectReusableSupportEvidence,
} = require("./supportEvidenceFreshness");
