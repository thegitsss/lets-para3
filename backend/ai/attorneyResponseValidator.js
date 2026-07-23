const MONTH_PATTERN = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const STATUS_CLAIMS = Object.freeze([
  "open",
  "in progress",
  "paused",
  "disputed",
  "completed",
  "closed",
  "archived",
  "funded",
  "released",
  "refunded",
  "canceled",
  "cancelled",
  "failed",
  "pending",
  "active",
  "paid out",
  "settled",
  "withdrawn",
  "terminated",
  "relisted",
  "overdue",
]);

const TOPIC_PATTERNS = Object.freeze({
  task: /\b(?:task|scope item|work item)s?\b/i,
  file: /\b(?:file|document|deliverable)s?\b/i,
  deadline: /\b(?:deadline|due date|due|overdue)\b/i,
  status: /\b(?:status|open|in progress|paused|disputed|completed|closed|archived)\b/i,
  charge: /\b(?:charged|total attorney charge|attorney charge)\b/i,
  matter_amount: /\bmatter amount\b/i,
  attorney_fee: /\battorney platform fee\b/i,
  paralegal_fee: /\bparalegal platform fee\b/i,
  payout: /\bparalegal\b.*\b(?:received|net|payout)\b|\b(?:received|net|payout)\b.*\bparalegal\b/i,
  payment_method: /\b(?:payment method|saved card|card on file|billing method)\b/i,
  requirement: /\b(?:required|need(?:ed)?|must|before|prerequisite)\b/i,
  receipt: /\b(?:receipt|invoice)s?\b/i,
  application: /\b(?:application|applicant)s?\b/i,
  invitation: /\b(?:invitation|invite)s?\b/i,
  message: /\b(?:message|reply|unread|thread)s?\b/i,
  profile: /\b(?:profile|onboarding|firm|practice area)s?\b/i,
  archive: /\b(?:archive|purge|download)s?\b/i,
});

function normalize(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9$%./'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenEvidence(toolOutputs = []) {
  return normalize(JSON.stringify((Array.isArray(toolOutputs) ? toolOutputs : []).map((entry) =>
    entry?.result?.evidence || entry?.result || {}
  )));
}

function extractDateClaims(value = "") {
  const text = String(value || "");
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}(?=\D|$)/g,
    /\b\d{1,2}\/\d{1,2}\/\d{4}(?=\D|$)/g,
    new RegExp(`\\b${MONTH_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,)?\\s+\\d{4}\\b`, "gi"),
  ];
  const claims = patterns.flatMap((pattern) => text.match(pattern) || []);
  return [...new Set(claims.map((claim) => {
    const cleaned = claim.replace(/(\d)(?:st|nd|rd|th)\b/i, "$1");
    const parsed = new Date(cleaned);
    return Number.isNaN(parsed.getTime()) ? normalize(cleaned) : parsed.toISOString().slice(0, 10);
  }))];
}

function collectEvidenceDates(value, dates = new Set(), depth = 0) {
  if (value === null || value === undefined || depth > 7) return dates;
  if (value instanceof Date) {
    dates.add(value.toISOString().slice(0, 10));
    return dates;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectEvidenceDates(entry, dates, depth + 1));
    return dates;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((entry) => collectEvidenceDates(entry, dates, depth + 1));
    return dates;
  }
  if (typeof value === "string") extractDateClaims(value).forEach((date) => dates.add(date));
  return dates;
}

function extractNamedClaims(reply = "") {
  const text = String(reply || "");
  const claims = [];
  for (const match of text.matchAll(/[“"]([^”"]{2,120})[”"]/g)) claims.push(match[1]);
  const participantPatterns = [
    /\b(?:assigned\s+)?(?:attorney|paralegal)\s+(?:is|was|:)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3})/g,
    /\b(?:attorney|paralegal)\s+on\s+.+?\s+is\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3})/g,
    /\b(?:attorney|paralegal)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3})/g,
  ];
  participantPatterns.forEach((pattern) => {
    for (const match of text.matchAll(pattern)) claims.push(match[1]);
  });
  const unquotedTitlePatterns = [
    /\b([A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+){1,5})\s+(?:matter|case)\b/g,
    /\b((?:The|Your)\s+[A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+){1,5})\s+(?:is|was|has|had)\b/g,
    /\b([A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+){1,5})\s+(?:is|was|has|had)\b/g,
  ];
  unquotedTitlePatterns.forEach((pattern) => {
    for (const match of text.matchAll(pattern)) {
      claims.push(String(match[1] || "").replace(/^(?:The|Your|This|That)\s+/i, ""));
    }
  });
  return [...new Set(claims.map(normalize).filter(Boolean))];
}

function statusSupported(status = "", evidenceText = "") {
  const normalizedStatus = normalize(status);
  if (evidenceText.includes(normalizedStatus)) return true;
  const compact = evidenceText.replace(/[ _-]+/g, "");
  if (normalizedStatus === "funded") return /escrowstatusfunded|fundingreadytrue/.test(compact);
  if (normalizedStatus === "released") {
    return /paymentreleasedtrue|paidoutat|payoutreleasetrigger|releasetriggerwhenattorneycompletesmatter/.test(compact);
  }
  if (normalizedStatus === "paid out") return /paymentreleasedtrue|paidoutat/.test(compact);
  if (normalizedStatus === "refunded") return /refund(?:ed|amount|status)/.test(compact);
  if (["canceled", "cancelled"].includes(normalizedStatus)) return /cancel(?:ed|led)/.test(compact);
  if (normalizedStatus === "settled") return /settlement|settled/.test(compact);
  if (normalizedStatus === "withdrawn") return /withdrawal|withdrawn/.test(compact);
  if (normalizedStatus === "terminated") return /termination|terminated/.test(compact);
  if (normalizedStatus === "relisted") return /relist/.test(compact);
  if (normalizedStatus === "overdue") return /overduetrue|isoverduetrue/.test(compact);
  return false;
}

function extractStatusClaims(reply = "") {
  const text = String(reply || "");
  const subjects = "(?:case|matter|payment|payout|refund|application|invitation|task|file|deliverable|dispute|workspace)s?";
  return STATUS_CLAIMS.filter((status) => {
    const phrase = status.replace(/\s+/g, "\\s+");
    return [
      new RegExp(`\\b${subjects}\\s+(?:is|are|was|were|remains?|looks?)\\s+(?:currently\\s+|still\\s+)?${phrase}\\b`, "i"),
      new RegExp(`\\b(?:is|are|was|were|remains?|currently|still)\\s+${phrase}\\b`, "i"),
      new RegExp(`\\b${phrase}\\s+${subjects}\\b`, "i"),
      new RegExp(`\\bstatus\\s+(?:is|was|remains?)\\s+${phrase}\\b`, "i"),
      new RegExp(`\\b(?:has|had)\\s+been\\s+${phrase}\\b`, "i"),
      new RegExp(`\\b${subjects}\\s+(?:became|entered|moved\\s+to)\\s+${phrase}\\b`, "i"),
    ].some((pattern) => pattern.test(text));
  });
}

function normalizedEvidenceFacts(toolOutputs = []) {
  return (toolOutputs || []).flatMap((entry) => Array.isArray(entry?.result?.evidence?.facts)
    ? entry.result.evidence.facts
    : []);
}

function statusClaimSupportedByFacts(status = "", sentence = "", toolOutputs = [], legacyEvidenceText = "") {
  const facts = normalizedEvidenceFacts(toolOutputs);
  if (!facts.length) return statusSupported(status, legacyEvidenceText);
  const expected = normalize(status);
  const policyTransition = /\b(?:after|when|once|if|moves? to|transitions? to|becomes?)\b/i.test(sentence) &&
    !/\b(?:your|this|that|my)\s+(?:case|matter|payment|payout)\b/i.test(sentence);
  const liveAssertion = /\b(?:your|this|that|my)\s+(?:case|matter|payment|payout)\b/i.test(sentence);
  return facts.some((fact) => {
    const values = Array.isArray(fact.value) ? fact.value : [fact.value];
    const booleanTransitionMatches =
      expected === "released" &&
      fact.value === true &&
      /(?:^|\.)(?:payment_released|paymentReleased)$/.test(String(fact.key || ""));
    const valueMatches = booleanTransitionMatches || values.some((value) => normalize(value) === expected);
    if (!valueMatches) return false;
    if (policyTransition) {
      return fact.claimType === "lifecycle_transition" && fact.policyOrLiveState === "policy";
    }
    if (liveAssertion) {
      return fact.policyOrLiveState === "live_state" && ["status", "lifecycle_transition"].includes(fact.claimType);
    }
    return ["status", "lifecycle_transition"].includes(fact.claimType);
  });
}

function isTruthfulLimitation(reply = "") {
  return /\b(?:temporarily unavailable|could not access|couldn't access|couldn’t access|unable to access|could not verify|couldn't verify|couldn’t verify|not represented|not available right now|try again|which (?:matter|case))\b/i.test(
    String(reply || "")
  );
}

function buildQuestionObligations(messageText = "") {
  const text = String(messageText || "");
  const obligations = [];
  const add = (key) => {
    if (!obligations.includes(key)) obligations.push(key);
  };
  if (/\b(?:task|scope item|work item)s?\b/i.test(text)) add("task");
  if (/\b(?:file|document|deliverable)s?\b/i.test(text)) add("file");
  if (/\b(?:deadlines?|due|overdue)\b/i.test(text)) add("deadline");
  if (/\bstatus\b/i.test(text)) add("status");
  if (/\b(?:what (?:was|were) i charged|how much (?:was i|were we) charged|total (?:attorney )?charge)\b/i.test(text)) add("charge");
  if (/\b(?:matter amount|case amount|matter value|budget)\b/i.test(text)) add("matter_amount");
  if (/\battorney (?:platform )?fee\b/i.test(text)) add("attorney_fee");
  if (/\bparalegal (?:platform )?fee\b/i.test(text)) add("paralegal_fee");
  if (/\b(?:what did the paralegal receive|paralegal (?:net )?payout|how much did the paralegal)\b/i.test(text)) add("payout");
  if (/\b(?:payment method|saved card|card on file|billing method)\b/i.test(text)) add("payment_method");
  if (/\b(?:need|required|before|first|prerequisite|must)\b/i.test(text)) add("requirement");
  if (/\b(?:receipt|invoice)s?\b/i.test(text)) add("receipt");
  if (/\b(?:application|applicant)s?\b/i.test(text)) add("application");
  if (/\b(?:invitation|invite)s?\b/i.test(text)) add("invitation");
  if (/\b(?:message|reply|unread|thread)s?\b/i.test(text)) add("message");
  if (/\b(?:profile|onboarding|firm|practice area)s?\b/i.test(text)) add("profile");
  if (/\b(?:archive|purge|download)s?\b/i.test(text)) add("archive");
  return obligations;
}

function tokenizeRelevant(value = "") {
  const stop = new Set([
    "about", "again", "answer", "check", "could", "from", "have", "help", "here", "into", "more",
    "open", "please", "show", "that", "their", "there", "these", "this", "view", "what", "when", "where",
    "which", "with", "would", "your",
  ]);
  return new Set(normalize(value).split(/\s+/).filter((token) => token.length >= 4 && !stop.has(token)));
}

function auditSuggestions(suggestions = [], { reply = "", messageText = "", simpleFact = false } = {}) {
  const values = (Array.isArray(suggestions) ? suggestions : []).map((value) => String(value || "").trim()).filter(Boolean);
  const errors = [];
  const normalized = values.map(normalize);
  if (new Set(normalized).size !== normalized.length) errors.push("duplicate_suggestions");
  if (simpleFact && values.length > 2) errors.push("too_many_suggestions_for_simple_answer");
  const answer = normalize(reply);
  if (normalized.some((suggestion) => suggestion.length >= 4 && answer.includes(suggestion))) {
    errors.push("suggestion_repeats_answer");
  }
  const contextTokens = tokenizeRelevant(`${messageText} ${reply}`);
  for (const suggestion of values) {
    const suggestionTokens = tokenizeRelevant(suggestion);
    if (suggestionTokens.size && ![...suggestionTokens].some((token) => contextTokens.has(token))) {
      errors.push("irrelevant_suggestion");
      break;
    }
  }
  return errors;
}

function sanitizeSuggestions(suggestions = [], options = {}) {
  const accepted = [];
  const rejected = [];
  for (const raw of Array.isArray(suggestions) ? suggestions : []) {
    const suggestion = String(raw || "").trim();
    if (!suggestion) continue;
    const duplicate = accepted.some((item) => normalize(item) === normalize(suggestion));
    const errors = duplicate ? ["duplicate_suggestions"] : auditSuggestions([suggestion], options);
    if (errors.length) rejected.push({ value: suggestion, errors });
    else accepted.push(suggestion);
  }
  const limit = options.simpleFact ? 2 : 3;
  accepted.slice(limit).forEach((value) => rejected.push({ value, errors: ["too_many_suggestions_for_simple_answer"] }));
  return { accepted: accepted.slice(0, limit), rejected };
}

function auditMonetaryClaims(reply = "", evidenceText = "") {
  const text = String(reply || "");
  const unsupportedZeroState = /\b(?:no|zero|waived|free)\s+(?:attorney\s+|paralegal\s+|platform\s+)?(?:fee|charge|payout)s?\b|\b(?:fee|charge|payout)s?\s+(?:is|are|was|were)\s+(?:waived|free|zero|none)\b/i.test(text);
  if (!unsupportedZeroState) return [];
  const evidenceConfirmsZero = /\b(?:waived|free)\b/i.test(evidenceText) ||
    /(?:fee|charge|payout)[a-z]*\s+(?:0|0\.00)\b/i.test(evidenceText);
  return evidenceConfirmsZero ? [] : ["unsupported_fee_charge_or_payout_claim"];
}

function collectPromptLikeRecordValues(value, values = new Set(), depth = 0) {
  if (!value || depth > 8) return values;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPromptLikeRecordValues(entry, values, depth + 1));
    return values;
  }
  if (typeof value !== "object") return values;
  if (value.contentTrust === "prompt_like_untrusted") {
    ["title", "name", "text", "content", "description"].forEach((key) => {
      const candidate = normalize(value[key]);
      if (candidate.length >= 8) values.add(candidate);
    });
  }
  Object.values(value).forEach((entry) => collectPromptLikeRecordValues(entry, values, depth + 1));
  return values;
}

function collectIncompleteSafeTaskTitles(toolOutputs = []) {
  const titles = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    if (
      Object.prototype.hasOwnProperty.call(value, "completed") &&
      value.completed !== true &&
      value.contentTrust !== "prompt_like_untrusted" &&
      typeof value.title === "string"
    ) {
      const title = normalize(value.title);
      if (title.length >= 3) titles.add(title);
    }
    Object.values(value).forEach((entry) => visit(entry, depth + 1));
  };
  visit((toolOutputs || []).map((entry) => entry?.result));
  return titles;
}

function auditAttorneySemanticResponse({
  reply = "",
  messageText = "",
  toolOutputs = [],
  activeTask = "",
  responseMode = "",
  suggestions = [],
  detailLevel = "concise",
  evidencePlan = {},
  includeOptionalUi = true,
} = {}) {
  const errors = [];
  const evidenceText = flattenEvidence(toolOutputs);
  const factual = ["FACT_LOOKUP", "TROUBLESHOOT", "EXPLAIN"].includes(String(activeTask || ""));
  const limitation = isTruthfulLimitation(reply) || responseMode === "CLARIFY_ONCE";

  if (
    /\bverified information\s*:/i.test(reply) ||
    /\bresults?(?:\s+\d+)?\s+(?:title|answer|supporting points?|source key|score)\s*:/i.test(reply) ||
    /\b(?:evidence state|capability id|source ref|policy or live state)\s*:/i.test(reply)
  ) {
    errors.push("raw_evidence_fields_exposed");
  }

  const normalizedReply = normalize(reply);
  if ([...collectPromptLikeRecordValues((toolOutputs || []).map((entry) => entry?.result))]
    .some((value) => normalizedReply.includes(value))) {
    errors.push("untrusted_instruction_content_echoed");
  }

  if (factual && !limitation) {
    const evidenceDates = collectEvidenceDates((toolOutputs || []).map((entry) => entry?.result?.evidence || entry?.result || {}));
    for (const date of extractDateClaims(reply)) {
      if (!evidenceDates.has(date)) errors.push("unsupported_date_claim");
    }
    if (/\b(?:today|tomorrow|yesterday|next week|last week)\b/i.test(reply) &&
        !/\b(?:today|tomorrow|yesterday|next week|last week)\b/i.test(evidenceText)) {
      errors.push("unsupported_relative_date_claim");
    }
    for (const claim of extractNamedClaims(reply)) {
      if (!evidenceText.includes(claim)) errors.push("unsupported_name_or_title_claim");
    }
    for (const sentence of splitSentences(reply)) {
      for (const status of extractStatusClaims(sentence)) {
        if (!statusClaimSupportedByFacts(status, sentence, toolOutputs, evidenceText)) {
          errors.push("unsupported_status_or_lifecycle_claim");
          break;
        }
      }
      if (errors.includes("unsupported_status_or_lifecycle_claim")) break;
    }
    if (/\breceipt\b.*\b(?:ready|available|downloadable|retrievable)\b|\b(?:ready|available|downloadable|retrievable)\b.*\breceipt\b/i.test(reply)) {
      const retrievalVerified = /(?:retrievable|downloadready|objectexists)\s*(?:true|:\s*true)/i.test(evidenceText.replace(/[ _-]+/g, ""));
      if (!retrievalVerified) errors.push("unsupported_receipt_readiness_claim");
    }
  }

  const requiredStates = (Array.isArray(toolOutputs) ? toolOutputs : [])
    .map((entry) => String(entry?.result?.evidenceState || entry?.result?.evidence?.state || ""))
    .filter(Boolean);
  if (requiredStates.includes("unauthorized") && !limitation) errors.push("unauthorized_evidence_used_as_fact");
  if (requiredStates.length && requiredStates.every((state) => ["unknown", "temporarily_unavailable", "unauthorized"].includes(state)) && !limitation) {
    errors.push("unverified_evidence_presented_as_verified");
  }
  errors.push(...auditMonetaryClaims(reply, evidenceText));

  if (!limitation) {
    for (const obligation of buildQuestionObligations(messageText)) {
      if (!TOPIC_PATTERNS[obligation]?.test(reply)) errors.push(`missing_answer_part:${obligation}`);
    }
  }

  const asksForTaskIdentity = /\b(?:what|which)\s+(?:specific\s+)?(?:task|scope item|work item)s?\b|\b(?:task|scope item|work item)s?\s+(?:is|are|remains?|remain|needs?|need)\b/i.test(messageText);
  if (asksForTaskIdentity) {
    const incompleteTaskTitles = collectIncompleteSafeTaskTitles(toolOutputs);
    if (incompleteTaskTitles.size && ![...incompleteTaskTitles].some((title) => normalizedReply.includes(title))) {
      errors.push("missing_requested_task_identity");
    }
  }

  const requestedTopics = new Set(buildQuestionObligations(messageText));
  const planKeys = new Set((evidencePlan.requirements || []).map((requirement) => requirement.key));
  if (factual && !requestedTopics.has("payment_method") && !requestedTopics.has("charge") && !requestedTopics.has("payout") &&
      !planKeys.has("billing_summary") && !planKeys.has("matter_financials") &&
      /\b(?:billing|payment method|post a case|post a matter)\b/i.test(reply) &&
      !/\b(?:billing|payment method|post a case|post a matter)\b/i.test(`${messageText} ${evidenceText}`)) {
    errors.push("unrelated_billing_or_posting_content");
  }

  if (includeOptionalUi) {
    errors.push(...auditSuggestions(suggestions, {
      reply,
      messageText,
      simpleFact: detailLevel === "concise" && !evidencePlan.compound,
    }));
  }
  return [...new Set(errors)];
}

function hasLiveMatterEvidence(toolOutputs = []) {
  return (toolOutputs || []).some((entry) => {
    const evidence = entry?.result?.evidence || {};
    return evidence.authorized === true && evidence.policyOrLiveState === "live_state" &&
      (evidence.subjectType === "matter" || Boolean(evidence.matterId));
  });
}

function auditPolicyLiveStateConfusion(reply = "", toolOutputs = []) {
  const assertsCompletedLiveState = /\b(?:your|this|that)\s+(?:case|matter|payment|payout)\s+(?:is|was|has been|already)\b/i.test(reply) ||
    /\b(?:you|your paralegal)\s+(?:have|has|were|was)\s+(?:been\s+)?(?:paid|funded|completed|released)\b/i.test(reply);
  if (!assertsCompletedLiveState || hasLiveMatterEvidence(toolOutputs)) return [];
  const hasPolicy = (toolOutputs || []).some((entry) =>
    (entry?.result?.evidence?.facts || []).some((fact) => fact.policyOrLiveState === "policy")
  );
  return hasPolicy ? ["policy_presented_as_live_state"] : ["live_status_without_live_evidence"];
}

function splitSentences(value = "") {
  return String(value || "").split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
}

function repairUnsupportedSecondaryClaims(reply = "", auditOptions = {}) {
  const sentences = splitSentences(reply);
  if (sentences.length < 2) return { reply, repaired: false, removed: [] };
  const removed = [];
  const kept = [];
  sentences.forEach((sentence, index) => {
    const errors = auditAttorneySemanticResponse({
      ...auditOptions,
      reply: sentence,
      messageText: "",
      suggestions: [],
      includeOptionalUi: false,
    }).filter((error) => /unsupported_(?:date|relative_date|name_or_title|status_or_lifecycle|receipt_readiness)_claim/.test(error));
    const material = /\$|\b(?:charged|fee|payout amount|permission|allowed|completed for you|released for you)\b/i.test(sentence);
    if (index > 0 && errors.length && !material) removed.push({ sentence, errors });
    else kept.push(sentence);
  });
  return kept.length && removed.length
    ? { reply: kept.join(" "), repaired: true, removed }
    : { reply, repaired: false, removed: [] };
}

module.exports = {
  auditAttorneySemanticResponse,
  auditPolicyLiveStateConfusion,
  auditMonetaryClaims,
  auditSuggestions,
  buildQuestionObligations,
  collectEvidenceDates,
  extractDateClaims,
  extractNamedClaims,
  extractStatusClaims,
  isTruthfulLimitation,
  repairUnsupportedSecondaryClaims,
  sanitizeSuggestions,
};
