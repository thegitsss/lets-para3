const {
  selectReusableSupportEvidence,
} = require("./supportEvidenceFreshness");

const REQUIREMENTS = Object.freeze({
  case_overview: Object.freeze({ key: "case_overview", anyOf: ["get_paralegal_case_overview"] }),
  workspace: Object.freeze({ key: "workspace", anyOf: ["get_paralegal_case_workspace"] }),
  applications: Object.freeze({ key: "applications", anyOf: ["get_paralegal_application_activity"] }),
  invitations: Object.freeze({ key: "invitations", anyOf: ["get_paralegal_invitation_activity"] }),
  attention: Object.freeze({ key: "attention", anyOf: ["get_paralegal_attention_summary"] }),
  payout_setup: Object.freeze({ key: "payout_setup", anyOf: ["get_paralegal_payout_setup"] }),
  payout_history: Object.freeze({ key: "payout_history", anyOf: ["get_paralegal_payout_history"] }),
  matter_financials: Object.freeze({ key: "matter_financials", anyOf: ["get_paralegal_case_financials"] }),
  account: Object.freeze({ key: "account", anyOf: ["get_paralegal_account_snapshot"] }),
  deactivation: Object.freeze({ key: "deactivation", anyOf: ["get_paralegal_deactivation_eligibility"] }),
  workflow: Object.freeze({ key: "workflow", anyOf: ["get_paralegal_workflow_readiness"] }),
  messages: Object.freeze({ key: "messages", anyOf: ["get_paralegal_messaging_state"] }),
  navigation: Object.freeze({ key: "navigation", anyOf: ["find_paralegal_navigation_destination"] }),
  knowledge: Object.freeze({ key: "knowledge", anyOf: ["search_lpc_knowledge"] }),
});

const TRUSTED_ENTITY_SOURCE = /^(?:tool:|server:|verified_(?:database|fixture|conversation_memory))/i;

const REQUIREMENT_TOPIC_PATTERNS = Object.freeze({
  case_overview: /\b(?:how many|count|overview|active work|completed matters?|assigned matters?)\b/i,
  workspace: /\b(?:status|deadline|tasks?|scope|files?|deliverables?|revisions?|workspace|attorney|disputes?|withdraw(?:al|n)?|withdrew|complete|finished|archives?|read-only|access)\b/i,
  applications: /\b(?:applications?|applied|shortlist|viewed|rejected)\b/i,
  invitations: /\b(?:invitations?|invites?|invited|accept|decline|revoke)\b/i,
  attention: /\b(?:attention|catch me up|priority|prioritize)\b/i,
  payout_setup: /\b(?:stripe|payout account|bank connected|payout setup|connect account)\b/i,
  payout_history: /\b(?:payout history|latest payout|been paid|earned|released yet|paid yet)\b/i,
  matter_financials: /\b(?:how much|gross|net|platform fee|fee|receive|payout amount|paid for)\b/i,
  account: /\b(?:profile|availability|visible|hidden|resume|certificate|writing sample|preferences?|notifications?|two[ -]?factor|2fa|security)\b/i,
  deactivation: /\b(?:deactivate|deactivation|close my account|disable my account)\b/i,
  workflow: /\b(?:what happens|what next|then what|when|how long|ready|can i|why can|finish|complete|release|paid|payout|bank|withdraw|start)\b/i,
  messages: /\b(?:message|messages|reply|respond|unread|chat|inbox)\b/i,
  navigation: /\b(?:go to|take me to|where|open)\b/i,
  knowledge: /\b(?:what is lpc|how does lpc|explain the platform|platform fee|how does applying work)\b/i,
});

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\b(?:paymnt|pymnt|paymet)\b/g, "payment")
    .replace(/\b(?:reciepts?|receitps?)\b/g, "receipts")
    .replace(/\b(?:mesages?|msgs?)\b/g, "messages")
    .replace(/\b(?:applicatons?|aplications?)\b/g, "applications")
    .replace(/\b(?:invitaitons?|invtes?)\b/g, "invitations")
    .replace(/\b(?:paralgl|paralgal|para)\b/g, "paralegal")
    .replace(/\b(?:complet|completd)\b/g, "complete")
    .replace(/\s+/g, " ");
}

function sanitizeParalegalPlanningScope(value = "") {
  return String(value || "")
    .replace(
      /\b(?:also|and)\s+(?:show|give|reveal|include|use)\b[^.!?]*(?:another|other)\s+(?:paralegal|attorney|user)(?:'s)?[^.!?]*/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function addRequirement(list, key, reason = "") {
  const requirement = REQUIREMENTS[key];
  if (!requirement || list.some((entry) => entry.key === requirement.key)) return;
  list.push({ ...requirement, reason });
}

function isReferentialFollowUp(text = "") {
  return /^(?:and\s+)?(?:then|what about|how about|did|does|is|was|were|has|have|can|could|why|when|where|who|which|both|all|that|it|this|them|her|him)\b/i.test(
    String(text || "").trim()
  );
}

function isCorrectionReference(text = "") {
  return /\b(?:i meant|not that|the other|instead|actually|no[,]?\s+the)\b/i.test(String(text || ""));
}

function sanitizeParalegalEntity(entity = {}, { requireTrustedSource = true } = {}) {
  const id = String(entity?.id || "").trim().slice(0, 120);
  const rawType = String(entity?.type || "").trim().toLowerCase();
  const type = rawType === "case" ? "matter" : rawType;
  const source = String(entity?.source || "").trim().slice(0, 120);
  if (!id || !["matter", "application", "invitation"].includes(type)) return null;
  if (requireTrustedSource && !TRUSTED_ENTITY_SOURCE.test(source)) return null;
  return {
    id,
    type,
    name: String(entity?.name || entity?.label || "").trim().slice(0, 240),
    source: source || "verified_conversation_memory",
    matterId: String(entity?.matterId || (type === "matter" ? id : "")).trim().slice(0, 120),
  };
}

function mergeVerifiedParalegalEntities(existing = [], activeEntity = null) {
  const merged = [];
  const add = (entity) => {
    const safe = sanitizeParalegalEntity(entity);
    if (!safe) return;
    const duplicate = merged.findIndex((entry) => entry.type === safe.type && entry.id === safe.id);
    if (duplicate >= 0) merged.splice(duplicate, 1);
    merged.unshift(safe);
  };
  (Array.isArray(existing) ? existing : []).slice().reverse().forEach(add);
  add(activeEntity);
  return merged.slice(0, 8);
}

function isParalegalAccountWideSubjectChange(messageText = "") {
  const text = normalizeText(messageText);
  if (!text || isReferentialFollowUp(text)) return false;
  return /\b(?:all (?:my )?(?:cases|matters|applications|invitations|messages|payouts)|how many (?:cases|matters)|my profile|my account|account settings|notification settings|payout history|payout setup|platform fee|how does lpc|what is lpc)\b/i.test(text);
}

function prepareParalegalConversationState(messageText = "", state = {}) {
  const activeEntity = sanitizeParalegalEntity(state.activeEntity || {});
  const verifiedEntities = mergeVerifiedParalegalEntities(state.verifiedEntities || [], activeEntity);
  const base = {
    ...state,
    activeEntity,
    verifiedEntities,
    correctionReference: false,
    correctionAmbiguous: false,
    subjectChanged: false,
  };
  if (isCorrectionReference(messageText)) {
    const alternatives = verifiedEntities.filter((entity) =>
      (!activeEntity || entity.type === activeEntity.type) &&
      (!activeEntity || entity.id !== activeEntity.id)
    );
    return {
      ...base,
      activeEntity: alternatives.length === 1 ? alternatives[0] : null,
      correctionReference: true,
      correctionAmbiguous: alternatives.length !== 1,
      clarificationOptions: alternatives.slice(0, 3).map((entity) => entity.name || entity.id),
    };
  }
  if (isParalegalAccountWideSubjectChange(messageText)) {
    return { ...base, activeEntity: null, subjectChanged: Boolean(activeEntity) };
  }
  return base;
}

function hasMatterReference(text = "", state = {}) {
  const normalized = normalizeText(text);
  return Boolean(
    /\b(?:matter|case|workspace|project)\b/i.test(normalized) ||
    state?.activeEntity?.type === "case" ||
    state?.activeEntity?.type === "matter"
  );
}

function orderParalegalRequirements(requirements = [], messageText = "") {
  const text = normalizeText(messageText);
  return requirements
    .map((requirement, originalIndex) => {
      const match = REQUIREMENT_TOPIC_PATTERNS[requirement.key]?.exec(text);
      return {
        requirement,
        originalIndex,
        position: match ? match.index : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((left, right) => left.position - right.position || left.originalIndex - right.originalIndex)
    .map((entry) => entry.requirement);
}

function requestedDimensions(text = "") {
  const normalized = normalizeText(text);
  const dimensions = [];
  if (/\b(?:status|state|in progress|complete|finished)\b/i.test(normalized)) dimensions.push("status");
  if (/\b(?:amount|how much|gross|net|fee|paid|payout)\b/i.test(normalized)) dimensions.push("amount");
  if (/\b(?:when|date|deadline|timing|how long)\b/i.test(normalized)) dimensions.push("timing");
  if (/\b(?:who|attorney|participant|assigned)\b/i.test(normalized)) dimensions.push("participant");
  if (/\b(?:tasks?|work|scope|left|remaining)\b/i.test(normalized)) dimensions.push("tasks");
  if (/\b(?:files?|deliverables?|revisions?|approved)\b/i.test(normalized)) dimensions.push("files");
  return [...new Set(dimensions)];
}

function buildParalegalEvidencePlan({
  messageText = "",
  conversationHistory = [],
  conversationState = {},
} = {}) {
  const current = normalizeText(messageText);
  const preparedState = prepareParalegalConversationState(current, conversationState);
  const historyText = (conversationHistory || [])
    .slice(-6)
    .map((entry) => normalizeText(entry?.content || entry?.text || ""))
    .filter(Boolean)
    .join(" ");
  const followUp = isReferentialFollowUp(current);
  const contextText = sanitizeParalegalPlanningScope(
    followUp ? `${historyText} ${current}`.trim() : current
  );
  const matterContext = hasMatterReference(contextText, preparedState);
  const lastCapabilities = new Set(
    (Array.isArray(preparedState.lastCapabilityIds) ? preparedState.lastCapabilityIds : [])
      .map((value) => String(value || ""))
  );
  const requirements = [];
  const accountWideMatterCount =
    /\b(?:how many|count|overview)\b/i.test(contextText) &&
    /\b(?:active|completed|assigned|matters?|cases?|work)\b/i.test(contextText);

  if (
    /\b(?:how many|count|overview|active work|assigned matters?)\b/i.test(contextText) ||
    /\b(?:all|my)\s+completed matters?\b|\bcompleted matters?\s+count\b/i.test(contextText)
  ) {
    addRequirement(requirements, "case_overview", "account-wide assigned matter state");
  }
  if (/\b(?:applications?|applied|shortlist|viewed my|rejected my)\b/i.test(contextText)) {
    addRequirement(requirements, "applications", "own application activity");
  }
  if (/\b(?:invitations?|invites?|invited|accept|decline|revoke)\b/i.test(contextText)) {
    addRequirement(requirements, "invitations", "own invitation activity");
  }
  if (/\b(?:what needs my attention|catch me up|what should i handle|priority|prioritize)\b/i.test(contextText)) {
    addRequirement(requirements, "attention", "account attention summary");
  }
  if (/\b(?:stripe|payout account|bank connected|payout setup|connect account)\b/i.test(contextText)) {
    addRequirement(requirements, "payout_setup", "own payout setup state");
  }
  if (/\b(?:payout history|latest payout|what have i been paid|how much have i earned)\b/i.test(contextText)) {
    addRequirement(requirements, "payout_history", "own payout history");
  }
  const payoutLifecycleTopic =
    /\b(?:pay|paid|payout|money|funds?|release|released|bank|deposit)\b/i.test(contextText) &&
    /\b(?:when|how long|did|does|has|have|get|got|yet|hit|arrive|land)\b/i.test(contextText);
  if (payoutLifecycleTopic) {
    addRequirement(requirements, "workflow", "completion, release, and bank timing policy");
    const asksForCurrentPayoutState =
      /\b(?:did|has|have|is|was)\s+(?:mine|my payout|this payout|that payout|it)\b/i.test(contextText) ||
      /\b(?:mine|my payout|this payout|that payout|it)\s+(?:get|got|been|released|paid|arrive|land|hit)\b/i.test(contextText);
    if (matterContext || asksForCurrentPayoutState) {
      addRequirement(requirements, "payout_history", "current payout evidence");
    }
  }
  if (
    matterContext &&
    /\b(?:how much|gross|net|platform fee|fee|receive|payout amount|paid for)\b/i.test(contextText)
  ) {
    addRequirement(requirements, "matter_financials", "authorized matter payout breakdown");
  }
  if (
    matterContext &&
    !accountWideMatterCount &&
    (
      /\b(?:status|active|in progress|paused|completed|closed|deadline|tasks?|scope|files?|deliverables?|revisions?|workspace|disputes?|withdraw(?:al|n)?|withdrew|complete|finished|archives?|read-only|access)\b/i.test(contextText) ||
      /\b(?:who|which)\b.{0,30}\battorney\b|\battorney\b.{0,30}\b(?:is|was|assigned)\b/i.test(contextText)
    )
  ) {
    addRequirement(requirements, "workspace", "authorized assigned matter state");
  }
  if (
    matterContext &&
    (
      /\b(?:apply|eligible to apply|leave this matter|what happens if i leave|finish\b.{0,30}\btasks?|what happens when i finish|selected|officially hired|start working|when can i start|pre-engagement|conflicts|confidentiality)\b/i.test(contextText) ||
      /\b(?:can|could|may|eligible to)\b.{0,25}\bwithdraw\b/i.test(contextText)
    )
  ) {
    addRequirement(requirements, "workflow", "paralegal workflow readiness");
  }
  if (
    followUp &&
    [...lastCapabilities].some((capabilityId) =>
      ["P08_invitations", "P09_pre_engagement", "P10_assignment_start", "P19_withdrawal_eligibility", "P21_completion_release"]
        .includes(capabilityId)
    )
  ) {
    addRequirement(requirements, "workflow", "continue the verified workflow from conversation state");
  }
  if (/\b(?:message|messages|reply|respond|unread|chat|inbox)\b/i.test(contextText)) {
    addRequirement(requirements, "messages", "authorized matter messaging state");
  }
  if (
    /\b(?:profile|availability|hidden|resume|certificate|writing sample|preferences?|notifications?|two[ -]?factor|2fa|security)\b/i.test(contextText) ||
    /\b(?:visible|visibility|searchable)\b.{0,30}\b(?:profile|attorneys?)\b|\bprofile\b.{0,30}\b(?:visible|visibility|searchable)\b/i.test(contextText)
  ) {
    addRequirement(requirements, "account", "own account and profile state");
  }
  if (/\b(?:deactivate|deactivation|close my account|disable my account)\b/i.test(contextText)) {
    addRequirement(requirements, "deactivation", "own deactivation eligibility");
  }
  if (
    /\b(?:go to|take me to|where|open)\b/i.test(current) &&
    /\b(?:cases?|applications?|payout|profile|settings|messages?|support|contact|dashboard|work)\b/i.test(current)
  ) {
    addRequirement(requirements, "navigation", "authorized paralegal navigation");
  }
  if (
    /\b(?:human|representative|real person|support (?:person|agent|team)|someone (?:at|from) lpc|speak|talk)\b/i.test(current) &&
    /\b(?:human|representative|person|agent|team|someone|speak|talk)\b/i.test(current)
  ) {
    addRequirement(requirements, "navigation", "verified Contact Us destination");
  }
  if (
    (
      /\b(?:what is lpc|how does lpc|explain the platform|platform fee)\b/i.test(current) ||
      /\bhow(?:\s+does)?\b.{0,40}\bapplying\b.{0,40}\bworks?\b/i.test(current)
    ) &&
    !matterContext
  ) {
    addRequirement(requirements, "knowledge", "approved LPC explanation");
  }

  const orderedRequirements = orderParalegalRequirements(requirements, current);
  const currentDimensions = requestedDimensions(current);
  const dimensions = currentDimensions.length
    ? currentDimensions
    : followUp && Array.isArray(preparedState.lastRequestedDimensions)
      ? preparedState.lastRequestedDimensions.map(String).slice(0, 8)
      : [];
  return {
    requirements: orderedRequirements,
    answerOrder: orderedRequirements.map((requirement) => requirement.key),
    compound: orderedRequirements.length > 1,
    followUp,
    correction: isCorrectionReference(current),
    hasMatterContext: matterContext,
    requestedDimensions: [...new Set(dimensions)],
    conversationState: preparedState,
    historyAuthority: "topic_only",
    pageContextAuthority: "candidate_only",
    refreshRequested: /\b(?:refresh|check again|recheck|updated now|latest right now)\b/i.test(current),
    responseShape: {
      orderedSections: orderedRequirements.map((requirement) => requirement.key),
      maximumSentences: Math.max(2, Math.min(orderedRequirements.length + 1, 5)),
      maximumClarifyingQuestions: 1,
    },
  };
}

function evidenceToolNamesForParalegalPlan(plan = {}) {
  return [...new Set((plan.requirements || []).flatMap((requirement) => requirement.anyOf || []))];
}

function expectedParalegalEntityTypesForPlan(plan = {}) {
  const keys = new Set((plan.requirements || []).map((requirement) => requirement.key));
  const types = [];
  if (keys.has("applications")) types.push("application");
  if (keys.has("invitations")) types.push("invitation");
  if (["workspace", "matter_financials", "workflow", "messages"].some((key) => keys.has(key))) {
    types.push("matter");
  }
  return [...new Set(types)];
}

function auditParalegalToolTrace(plan = {}, toolOutputs = []) {
  const outputs = Array.isArray(toolOutputs) ? toolOutputs : [];
  const successful = outputs.filter((entry) => entry?.result?.ok === true);
  const missing = (plan.requirements || []).filter(
    (requirement) => !successful.some((entry) => requirement.anyOf.includes(entry.name))
  );
  const allowed = new Set(evidenceToolNamesForParalegalPlan(plan));
  const unrelated = plan.requirements?.length
    ? successful.filter((entry) => !allowed.has(entry.name)).map((entry) => entry.name)
    : [];
  const seen = new Set();
  const repeated = [];
  const subjectKey = (entry = {}) => {
    const evidence = entry.result?.evidence || {};
    const evidenceSubject = String(evidence.matterId || evidence.subjectId || "").trim();
    if (evidenceSubject) return `subject:${evidenceSubject}`;
    const args = entry.args && typeof entry.args === "object" ? entry.args : {};
    for (const key of ["case_reference", "application_id", "invitation_id", "job_id"]) {
      const value = String(args[key] || "").trim().toLowerCase();
      if (value) return `${key}:${value}`;
    }
    return "account";
  };
  const sufficientCurrentEvidence = (entry = {}) => {
    const result = entry.result || {};
    const evidence = result.evidence || {};
    const state = String(result.evidenceState || evidence.state || "").toLowerCase();
    return result.ok === true &&
      result.available !== false &&
      result.clarificationNeeded !== true &&
      evidence.authorized !== false &&
      !["unknown", "temporarily_unavailable", "unauthorized"].includes(state) &&
      Array.isArray(evidence.facts) &&
      evidence.facts.length > 0 &&
      (!Array.isArray(evidence.missingFacts) || evidence.missingFacts.length === 0);
  };
  for (const entry of outputs) {
    const key = `${entry.name}|${subjectKey(entry)}`;
    if (seen.has(key)) repeated.push(entry.name);
    if (sufficientCurrentEvidence(entry)) seen.add(key);
  }
  return {
    sufficient: missing.length === 0,
    missing,
    unrelated: [...new Set(unrelated)],
    repeated: [...new Set(repeated)],
    successful,
  };
}

function selectReusableParalegalEvidence(
  plan = {},
  priorToolOutputs = [],
  { now = Date.now(), activeEntity = null } = {}
) {
  return selectReusableSupportEvidence(
    evidenceToolNamesForParalegalPlan(plan),
    priorToolOutputs,
    {
      now,
      activeEntity: activeEntity || plan.conversationState?.activeEntity || null,
      refreshRequested: plan.refreshRequested === true,
      subjectChanged: plan.conversationState?.subjectChanged === true,
    }
  );
}

module.exports = {
  REQUIREMENTS,
  auditParalegalToolTrace,
  buildParalegalEvidencePlan,
  evidenceToolNamesForParalegalPlan,
  expectedParalegalEntityTypesForPlan,
  hasMatterReference,
  isParalegalAccountWideSubjectChange,
  isCorrectionReference,
  isReferentialFollowUp,
  mergeVerifiedParalegalEntities,
  normalizeText,
  orderParalegalRequirements,
  prepareParalegalConversationState,
  requestedDimensions,
  sanitizeParalegalPlanningScope,
  sanitizeParalegalEntity,
  selectReusableParalegalEvidence,
};
