const { normalizeParalegalToolEvidence } = require("./paralegalEvidenceContract");
const {
  SUPPORTED_EXECUTED_ESCALATION_REASONS,
} = require("./paralegalResponseUiPolicy");

const MONTH_PATTERN =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const STATUS_VALUES = Object.freeze([
  "submitted",
  "viewed",
  "shortlisted",
  "accepted",
  "selected",
  "rejected",
  "declined",
  "revoked",
  "pending",
  "active",
  "assigned",
  "in progress",
  "paused",
  "disputed",
  "completed",
  "closed",
  "archived",
  "withdrawn",
  "released",
  "paid",
  "failed",
]);
const INTERNAL_FIELD_PATTERN =
  /\b(?:stripeAccountId|transferId|storageKey|clientSecret|paymentIntentId|attorneyId|paralegalId|caseDoc|rawProcessor|fraudSignal|internalNotes?)\b/i;
const RAW_EVIDENCE_PATTERN =
  /\b(?:verified information|tool evidence|selected evidence|results title|results answer|evidence facts?|capability(?:\s+id)?|policy_or_live_state)\s*:/i;
const LIMITATION_PATTERN =
  /\b(?:can['’]?t (?:access|verify|confirm)|could(?:\s+not|n['’]?t) (?:access|verify|confirm)|does(?:\s+not|n['’]?t) confirm|unable to (?:access|verify|confirm)|not authorized|not available right now|temporarily unavailable|which (?:matter|application|invitation)|need (?:the|a) (?:matter|application|invitation))\b/i;

function normalize(value = "") {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9$%./'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value = "") {
  return normalize(
    String(value ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[.[\]_-]+/g, " ")
  );
}

function normalizedEvidence(toolOutputs = []) {
  return (Array.isArray(toolOutputs) ? toolOutputs : []).map((entry) => ({
    name: String(entry?.name || ""),
    result: entry?.result || {},
    evidence: normalizeParalegalToolEvidence({
      toolName: entry?.name,
      result: entry?.result || {},
    }),
  }));
}

function evidenceFactsFor(toolOutputs = []) {
  return normalizedEvidence(toolOutputs).flatMap((entry) =>
    (entry.evidence.facts || []).map((fact) => ({
      ...fact,
      normalizedKey: normalizeKey(fact.key),
      normalizedValue: normalize(
        typeof fact.value === "object" ? JSON.stringify(fact.value) : fact.value
      ),
      toolName: entry.name,
      state: entry.evidence.state,
      authorized: entry.evidence.authorized,
    }))
  );
}

function evidenceTextFor(toolOutputs = []) {
  return evidenceFactsFor(toolOutputs)
    .map((fact) => `${fact.normalizedKey}:${fact.normalizedValue}`)
    .join(" ");
}

function extractMoneyClaims(text = "") {
  return [...String(text || "").matchAll(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g)].map((match) =>
    match[0].replace(/\s+/g, "").toLowerCase()
  );
}

function extractPercentClaims(text = "") {
  return [...String(text || "").matchAll(/\b\d+(?:\.\d+)?\s*%/g)].map((match) =>
    match[0].replace(/\s+/g, "")
  );
}

function normalizeDateClaim(value = "") {
  const cleaned = String(value || "").replace(/(\d)(?:st|nd|rd|th)\b/i, "$1");
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? normalize(cleaned) : parsed.toISOString().slice(0, 10);
}

function extractDateClaims(text = "") {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}(?=\D|$)/g,
    /\b\d{1,2}\/\d{1,2}\/\d{4}(?=\D|$)/g,
    new RegExp(`\\b${MONTH_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,)?\\s+\\d{4}\\b`, "gi"),
  ];
  return [...new Set(patterns.flatMap((pattern) =>
    (String(text || "").match(pattern) || []).map(normalizeDateClaim)
  ))];
}

function evidenceDateValues(facts = []) {
  const dates = new Set();
  for (const fact of facts) {
    extractDateClaims(String(fact.value || "")).forEach((date) => dates.add(date));
  }
  return dates;
}

function extractNamedClaims(reply = "") {
  const claims = [];
  const patterns = [
    /\b(?:attorney|lawyer)\s+(?:is|was|:)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3})/g,
    /\b([A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+){0,5})\s+(?:matter|case)\b/g,
    /\b(?:matter|case)\s+[“"]([^”"]{2,120})[”"]/g,
  ];
  patterns.forEach((pattern) => {
    for (const match of String(reply || "").matchAll(pattern)) {
      const claim = normalize(match[1]).replace(/^(?:the|this|that|your|my)\s+/, "");
      if (!["", "the", "this", "that", "your", "my"].includes(claim)) claims.push(claim);
    }
  });
  return [...new Set(claims.filter(Boolean))];
}

function factMatches(facts = [], keyPattern, expected) {
  return facts.some((fact) => {
    if (!keyPattern.test(fact.normalizedKey)) return false;
    if (typeof expected === "boolean") return fact.value === expected;
    if (Array.isArray(expected)) return expected.map(normalize).includes(fact.normalizedValue);
    return fact.normalizedValue === normalize(expected);
  });
}

function sentenceContaining(text = "", pattern) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => pattern.test(sentence));
}

function auditWorkflowClaims(reply = "", facts = []) {
  const errors = [];
  const checks = [
    {
      pattern: /\b(?:funds?|money|payout|payment)\s+(?:has|have|was|were|is|are)\s+(?:been\s+)?released\b/i,
      supported: () => factMatches(facts, /(?:payment released|current release payment released)$/, true),
      error: "unsupported_release_claim",
    },
    {
      pattern: /\b(?:funds?|money|payout|payment)\s+(?:has|have|was|were|is|are)\s+not\s+(?:been\s+)?released\b|\bnot released yet\b/i,
      supported: () => factMatches(facts, /(?:payment released|current release payment released)$/, false),
      error: "unsupported_release_claim",
    },
    {
      pattern: /\byou can (?:send a )?message\b|\bmessaging is (?:open|available)\b/i,
      supported: () => factMatches(facts, /(?:can send|allowed)$/, true),
      error: "unsupported_messaging_permission_claim",
    },
    {
      pattern: /\byou (?:can['’]?t|cannot) (?:send a )?message\b|\bmessaging is (?:closed|unavailable)\b/i,
      supported: () =>
        factMatches(facts, /(?:can send|allowed)$/, false) ||
        facts.some((fact) => /blockers?/.test(fact.normalizedKey) && fact.normalizedValue),
      error: "unsupported_messaging_permission_claim",
    },
    {
      pattern: /\bpayout setup is ready\b|\bpayout account is ready\b/i,
      supported: () => factMatches(facts, /(?:^| )(?:ready|stripe ready)$/, true),
      error: "unsupported_payout_readiness_claim",
    },
    {
      pattern: /\bpayout setup is not (?:ready|complete)\b|\bpayout account is not ready\b/i,
      supported: () => factMatches(facts, /(?:^| )(?:ready|stripe ready)$/, false),
      error: "unsupported_payout_readiness_claim",
    },
    {
      pattern: /\byou can (?:open|access) (?:the|this|that) (?:matter|workspace|case)\b/i,
      supported: () =>
        factMatches(facts, /(?:workspace allowed|access allowed|allowed)$/, true) ||
        factMatches(facts, /relationship$/, ["assigned"]),
      error: "unsupported_authorization_claim",
    },
    {
      pattern: /\byou (?:can['’]?t|cannot) (?:open|access) (?:the|this|that) (?:matter|workspace|case)\b/i,
      supported: () =>
        factMatches(facts, /(?:workspace allowed|access allowed|allowed)$/, false) ||
        facts.some((fact) => fact.authorized === false),
      error: "unsupported_authorization_claim",
    },
    {
      pattern: /\byou (?:were|are|have been) (?:hired|selected|assigned)\b/i,
      supported: () =>
        factMatches(facts, /relationship$/, ["assigned"]) ||
        factMatches(facts, /(?:application status|invitation status|matter status|status)$/, [
          "accepted",
          "selected",
          "assigned",
          "active",
          "in progress",
        ]),
      error: "unsupported_assignment_claim",
    },
    {
      pattern: /\byour (?:application|invitation) (?:was|is|has been) (?:accepted|selected|rejected|declined|revoked|pending)\b/i,
      supported: (sentence) => STATUS_VALUES.some((status) =>
        new RegExp(`\\b${status.replace(/\s+/g, "\\s+")}\\b`, "i").test(sentence) &&
        factMatches(facts, /(?:application status|invitation status|status)$/, status)
      ),
      error: "unsupported_application_or_invitation_claim",
    },
    {
      pattern: /\b(?:your )?resume (?:is|was) (?:uploaded|on file|available|recorded)\b/i,
      supported: () => factMatches(facts, /resume present$/, true),
      error: "unsupported_availability_claim",
    },
    {
      pattern: /\b(?:your )?resume (?:is not|isn['’]t|was not) (?:uploaded|on file|available|recorded)\b|\bno resume is recorded\b/i,
      supported: () => factMatches(facts, /resume present$/, false),
      error: "unsupported_availability_claim",
    },
    {
      pattern: /\b(?:your )?certificate (?:is|was) (?:uploaded|on file|available|recorded)\b/i,
      supported: () => factMatches(facts, /certificate present$/, true),
      error: "unsupported_availability_claim",
    },
    {
      pattern: /\b(?:your )?writing sample (?:is|was) (?:uploaded|on file|available|recorded)\b/i,
      supported: () => factMatches(facts, /writing sample present$/, true),
      error: "unsupported_availability_claim",
    },
    {
      pattern: /\b(?:your )?profile is hidden\b/i,
      supported: () => factMatches(facts, /profile hidden$/, true),
      error: "unsupported_visibility_claim",
    },
    {
      pattern: /\b(?:your )?profile is (?:visible|not hidden|searchable)\b/i,
      supported: () => factMatches(facts, /profile hidden$/, false),
      error: "unsupported_visibility_claim",
    },
    {
      pattern: /\btwo-factor authentication is enabled\b|\b2fa is enabled\b/i,
      supported: () => factMatches(facts, /two factor enabled$/, true),
      error: "unsupported_security_claim",
    },
    {
      pattern: /\btwo-factor authentication is not enabled\b|\b2fa is (?:off|disabled)\b/i,
      supported: () => factMatches(facts, /two factor enabled$/, false),
      error: "unsupported_security_claim",
    },
    {
      pattern: /\b(?:the )?archive is ready\b/i,
      supported: () =>
        factMatches(facts, /storage checked$/, true) &&
        facts.some((fact) => /archive ready at$/.test(fact.normalizedKey) && Boolean(fact.value)),
      error: "unsupported_availability_claim",
    },
  ];

  for (const check of checks) {
    for (const sentence of sentenceContaining(reply, check.pattern)) {
      if (!check.supported(sentence)) errors.push(check.error);
    }
  }
  return errors;
}

function extractStatusClaims(reply = "") {
  const claims = [];
  const subject =
    "(?:matter|case|application|invitation|invite|payout|payment|task|file|deliverable|profile)";
  for (const status of STATUS_VALUES) {
    const phrase = status.replace(/\s+/g, "\\s+");
    const patterns = [
      new RegExp(`\\b${subject}\\s+(?:is|was|remains?|has been)\\s+(?:currently\\s+|still\\s+)?${phrase}\\b`, "i"),
      new RegExp(`\\bstatus\\s+(?:is|was|remains?)\\s+${phrase}\\b`, "i"),
    ];
    if (patterns.some((pattern) => pattern.test(reply))) claims.push(status);
  }
  return [...new Set(claims)];
}

function statusSupported(status = "", facts = []) {
  const expected = normalize(status);
  return facts.some((fact) => {
    if (!/(?:status|state|relationship|payment released|finalized)$/.test(fact.normalizedKey)) return false;
    if (expected === "released" && fact.value === true && /payment released$/.test(fact.normalizedKey)) {
      return true;
    }
    return fact.normalizedValue === expected;
  });
}

function answerAddressesPlan(reply = "", evidencePlan = {}) {
  const normalized = normalize(reply);
  if (LIMITATION_PATTERN.test(reply)) return [];
  const topicPatterns = {
    case_overview: /\b(?:active|completed|assigned|matter|case|count)\b/i,
    workspace: /\b(?:matter|case|status|deadline|task|file|attorney|workspace|access|archive|dispute)\b/i,
    applications: /\b(?:application|applied|submitted|viewed|shortlisted|selected|rejected)\b/i,
    invitations: /\b(?:invitation|invite|invited|accept|decline|pending)\b/i,
    attention: /\b(?:attention|active|pending|deadline|payout)\b/i,
    payout_setup: /\b(?:payout|stripe|bank|setup|ready)\b/i,
    payout_history: /\b(?:payout|paid|released|history|total)\b/i,
    matter_financials: /\b(?:gross|fee|net|payout|amount)\b/i,
    account: /\b(?:profile|availability|resume|certificate|sample|preference|notification|two-factor|2fa|security)\b/i,
    deactivation: /\b(?:deactivat|close|blocker|eligible)\b/i,
    workflow: /\b(?:next|start|complete|release|withdraw|bank|business day|ready|require)\b/i,
    messages: /\b(?:message|reply|unread|send|respond)\b/i,
    navigation: /\b(?:open|go|page|settings|contact|cases|applications|payout|profile)\b/i,
    knowledge: /\b(?:lpc|platform|apply|application|fee|paralegal)\b/i,
  };
  return (evidencePlan.requirements || [])
    .map((requirement) => String(requirement.key || ""))
    .filter((key) => topicPatterns[key] && !topicPatterns[key].test(normalized));
}

function extractNavigationEvidence(toolOutputs = []) {
  return (Array.isArray(toolOutputs) ? toolOutputs : [])
    .filter((entry) =>
      entry?.name === "find_paralegal_navigation_destination" &&
      entry?.result?.ok === true &&
      entry?.result?.available === true
    )
    .map((entry) => ({
      ctaLabel: String(entry.result.ctaLabel || ""),
      ctaHref: String(entry.result.ctaHref || ""),
    }));
}

function auditParalegalSemanticResponse({
  reply = "",
  messageText = "",
  toolOutputs = [],
  evidencePlan = {},
  suggestions = [],
  navigation = null,
  reviewCard = null,
} = {}) {
  const text = String(reply || "").trim();
  const normalizedReply = normalize(text);
  const facts = evidenceFactsFor(toolOutputs);
  const evidenceText = evidenceTextFor(toolOutputs);
  const evidenceEntries = normalizedEvidence(toolOutputs);
  const errors = [];
  const factual =
    /\b(?:my|mine|this|that|paid|payout|application|invite|matter|case|profile|account|status|deadline)\b/i.test(
      `${messageText} ${reply}`
    );

  if (!text) errors.push("empty_answer");
  if (RAW_EVIDENCE_PATTERN.test(text)) errors.push("raw_evidence_leak");
  if (INTERNAL_FIELD_PATTERN.test(text)) errors.push("internal_field_leak");
  if (
    /\b(?:card ending|payment method|attorney charge|attorney platform fee)\b/i.test(text) &&
    !/\battorney (?:charge|platform fee)\b/i.test(`${messageText} ${evidenceText}`)
  ) {
    errors.push("attorney_financial_data_out_of_scope");
  }
  if (
    /\b(?:i (?:accepted|declined|withdrew|sent|uploaded|changed|completed)|i['’]m sending this to the team|I (?:opened|created) (?:a )?(?:ticket|case))\b/i.test(
      text
    )
  ) {
    errors.push("false_action_or_handoff_claim");
  }
  if (
    /\b(?:legal advice|you should file|legal strategy|final legal document|drafted (?:the|your))\b/i.test(text) &&
    !/\b(?:can(?:not|'t)|unable|don['’]t provide|won['’]t)\b/i.test(text)
  ) {
    errors.push("legal_boundary_violation");
  }
  const bankReceiptSentences = sentenceContaining(
    text,
    /\b(?:hit|reached|arrived in|is in|landed in)\b.{0,35}\b(?:your )?(?:bank|account)\b/i
  );
  if (!factMatches(facts, /bank receipt confirmed$/, true)) {
    for (const sentence of bankReceiptSentences) {
      const explicitlyLimited =
        LIMITATION_PATTERN.test(sentence) ||
        /\b(?:not confirmed|unconfirmed|unknown|whether|no (?:bank )?(?:receipt|deposit) confirmation)\b/i.test(
          sentence
        );
      if (!explicitlyLimited) errors.push("unsupported_bank_receipt_claim");
    }
  }

  for (const claim of extractMoneyClaims(text)) {
    const normalizedClaim = claim.replace(/[$,]/g, "");
    const supported = facts.some((fact) => {
      const value = String(fact.value || "").replace(/\s+/g, "").toLowerCase();
      return value === claim || value.replace(/[$,]/g, "") === normalizedClaim;
    });
    if (!supported) errors.push("unsupported_monetary_claim");
  }
  for (const claim of extractPercentClaims(text)) {
    const number = Number(claim.replace("%", ""));
    if (!facts.some((fact) =>
      /(?:fee|percent|percentage|rate)/.test(fact.normalizedKey) &&
      Number(fact.value) === number
    )) {
      errors.push("unsupported_fee_claim");
    }
  }
  const evidenceDates = evidenceDateValues(facts);
  for (const claim of extractDateClaims(text)) {
    if (!evidenceDates.has(claim)) errors.push("unsupported_date_claim");
  }
  if (/\b(?:today|tomorrow|yesterday)\b/i.test(text)) {
    errors.push("unsupported_relative_date_claim");
  }
  for (const claim of extractNamedClaims(text)) {
    if (!facts.some((fact) => fact.normalizedValue === claim)) errors.push("unsupported_name_claim");
  }
  for (const status of extractStatusClaims(text)) {
    if (!statusSupported(status, facts)) errors.push("unsupported_status_claim");
  }
  errors.push(...auditWorkflowClaims(text, facts));

  const states = evidenceEntries.map((entry) => normalize(entry.evidence.state));
  const hasVerifiedAuthorizedEvidence = evidenceEntries.some((entry) =>
    entry.result?.ok === true &&
    entry.evidence.authorized === true &&
    ["verified", "absent", "not applicable"].includes(normalize(entry.evidence.state))
  );
  if (
    states.includes("unauthorized") &&
    !/\b(?:can['’]?t access|not authorized|don['’]?t have access)\b/i.test(text)
  ) {
    errors.push("unauthorized_evidence_used_as_fact");
  }
  if (
    states.includes("temporarily unavailable") &&
    factual &&
    !hasVerifiedAuthorizedEvidence &&
    !LIMITATION_PATTERN.test(text)
  ) {
    errors.push("unavailable_evidence_used_as_fact");
  }
  if (
    factual &&
    evidencePlan.requirements?.length &&
    !hasVerifiedAuthorizedEvidence &&
    !LIMITATION_PATTERN.test(text)
  ) {
    errors.push("direct_factual_answer_without_successful_tool_evidence");
  }

  const missingAnswerSections = answerAddressesPlan(text, evidencePlan);
  missingAnswerSections.forEach((key) => errors.push(`missing_answer_section:${key}`));

  const safeSuggestions = Array.isArray(suggestions) ? suggestions.map(String).filter(Boolean) : [];
  if (safeSuggestions.length > 1) errors.push("too_many_suggestions");
  if (new Set(safeSuggestions.map(normalize)).size !== safeSuggestions.length) {
    errors.push("duplicate_suggestions");
  }
  if (navigation && safeSuggestions.length) errors.push("suggestion_with_navigation");
  if (safeSuggestions.some((item) => normalizedReply.includes(normalize(item)))) {
    errors.push("suggestion_repeats_answer");
  }

  const verifiedNavigation = extractNavigationEvidence(toolOutputs);
  if (
    navigation &&
    !verifiedNavigation.some((item) =>
      item.ctaHref === String(navigation.ctaHref || "") &&
      item.ctaLabel === String(navigation.ctaLabel || "")
    )
  ) {
    errors.push("unsupported_navigation");
  }
  if (
    navigation?.ctaHref &&
    (text.includes(navigation.ctaHref) ||
      new RegExp(`\\]\\([^)]*${String(navigation.ctaHref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^)]*\\)`, "i").test(text))
  ) {
    errors.push("duplicate_inline_and_button_link");
  }
  if (
    reviewCard &&
    !(
      SUPPORTED_EXECUTED_ESCALATION_REASONS.has(String(reviewCard.reason || "").toLowerCase()) &&
      Boolean(String(reviewCard.referenceId || "").trim())
    )
  ) {
    errors.push("manual_review_card_without_executed_escalation");
  }
  if (/\b(?:manual review|sending (?:this|it) to the team|team will review)\b/i.test(text)) {
    errors.push("phantom_manual_review");
  }

  const maximumSentences = Number(evidencePlan.responseShape?.maximumSentences || 5);
  const sentenceCount = text ? text.split(/(?<=[.!?])\s+/).filter(Boolean).length : 0;
  if (sentenceCount > maximumSentences) errors.push("answer_too_long");
  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount > Number(evidencePlan.responseShape?.maximumClarifyingQuestions ?? 1)) {
    errors.push("too_many_clarifying_questions");
  }
  return [...new Set(errors)];
}

function repairParalegalResponse(reply = "") {
  return String(reply || "")
    .replace(/\bVerified information:\s*/gi, "")
    .replace(/\b(?:results title|results answer):\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  LIMITATION_PATTERN,
  auditParalegalSemanticResponse,
  auditWorkflowClaims,
  evidenceFactsFor,
  evidenceTextFor,
  extractDateClaims,
  extractMoneyClaims,
  extractNamedClaims,
  extractPercentClaims,
  repairParalegalResponse,
};
