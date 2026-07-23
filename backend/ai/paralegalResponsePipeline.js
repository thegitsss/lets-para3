const {
  normalizeParalegalToolEvidence,
  renderParalegalEvidenceAnswer,
} = require("./paralegalEvidenceContract");
const {
  auditParalegalSemanticResponse,
} = require("./paralegalResponseValidator");
const {
  sanitizeParalegalResponseUi,
  verifiedNavigationFrom,
} = require("./paralegalResponseUiPolicy");

const MAX_CORRECTION_ATTEMPTS = 2;

function normalizeCandidate(candidate = {}) {
  if (typeof candidate === "string") {
    return {
      reply: candidate,
      suggestions: [],
      navigation: null,
      clarification: null,
      escalation: null,
      primaryAsk: "",
      activeTask: "",
      awaitingField: "",
      responseMode: "",
      confidence: "",
      detailLevel: "",
    };
  }
  return {
    reply: String(candidate?.reply || ""),
    suggestions: Array.isArray(candidate?.suggestions) ? candidate.suggestions : [],
    navigation: candidate?.navigation && typeof candidate.navigation === "object"
      ? candidate.navigation
      : null,
    clarification: candidate?.clarification && typeof candidate.clarification === "object"
      ? candidate.clarification
      : null,
    escalation: candidate?.escalation && typeof candidate.escalation === "object"
      ? candidate.escalation
      : null,
    primaryAsk: String(candidate?.primaryAsk || "").slice(0, 80),
    activeTask: String(candidate?.activeTask || "").slice(0, 40),
    awaitingField: String(candidate?.awaitingField || "").slice(0, 120),
    responseMode: String(candidate?.responseMode || "").slice(0, 40),
    confidence: String(candidate?.confidence || "").slice(0, 20),
    detailLevel: String(candidate?.detailLevel || "").slice(0, 20),
  };
}

function evidenceBrief(toolOutputs = []) {
  return (Array.isArray(toolOutputs) ? toolOutputs : []).map((entry) => {
    const evidence = normalizeParalegalToolEvidence({
      toolName: entry?.name,
      result: entry?.result || {},
    });
    return {
      toolName: String(entry?.name || ""),
      capabilityId: evidence.capabilityId,
      state: evidence.state,
      authorized: evidence.authorized,
      subjectType: evidence.subjectType,
      subjectId: evidence.subjectId,
      facts: evidence.facts,
      missingFacts: evidence.missingFacts,
    };
  });
}

function buildParalegalGenerationInstructions({
  messageText = "",
  evidencePlan = {},
  toolOutputs = [],
  validationErrors = [],
} = {}) {
  return {
    role: "paralegal_support_assistant",
    userMessage: String(messageText || ""),
    answerOrder: [...(evidencePlan.answerOrder || [])],
    requestedDimensions: [...(evidencePlan.requestedDimensions || [])],
    responseShape: {
      maximumSentences: Number(evidencePlan.responseShape?.maximumSentences || 5),
      maximumClarifyingQuestions: Number(
        evidencePlan.responseShape?.maximumClarifyingQuestions ?? 1
      ),
      maximumSuggestions: 1,
      maximumActions: 1,
    },
    evidence: evidenceBrief(toolOutputs),
    correction: validationErrors.length
      ? {
          required: true,
          failureClasses: [...new Set(validationErrors.map(String))],
        }
      : { required: false, failureClasses: [] },
    rules: [
      "Answer the paralegal's question directly and concisely.",
      "Use only the supplied authorized evidence for factual claims.",
      "Do not repeat evidence labels, field names, tool names, or raw evidence.",
      "Keep matter gross, paralegal platform fee, calculated net, finalized payout, LPC release, processor timing, and confirmed bank receipt distinct.",
      "Do not claim a mutation, message, handoff, ticket, or staff review occurred.",
      "Return zero or one relevant suggestion. Return no suggestion when an action is present.",
      "Use only a supplied verified navigation destination and do not repeat its link in the answer.",
      "Ask at most one clarification when the selected evidence cannot identify the subject.",
    ],
  };
}

function resultForRequirement(requirement = {}, toolOutputs = []) {
  return (Array.isArray(toolOutputs) ? toolOutputs : []).find((entry) =>
    (requirement.anyOf || []).includes(entry?.name)
  ) || null;
}

function truthfulLimitationFor(evidence = {}) {
  if (evidence.authorized === false || evidence.state === "unauthorized") {
    return "I can’t access that information from this paralegal account.";
  }
  if (evidence.state === "absent") {
    return "There isn’t a matching record available for this account.";
  }
  if (evidence.state === "unknown") {
    return "I need the specific matter, application, or invitation before I can verify that.";
  }
  return "I can’t verify that information right now. Please try again shortly.";
}

function buildParalegalEvidenceFallback({
  messageText = "",
  evidencePlan = {},
  toolOutputs = [],
} = {}) {
  const replies = [];
  const seen = new Set();
  for (const requirement of evidencePlan.requirements || []) {
    const output = resultForRequirement(requirement, toolOutputs);
    if (!output) continue;
    const evidence = normalizeParalegalToolEvidence({
      toolName: output.name,
      result: output.result || {},
    });
    const rendered = renderParalegalEvidenceAnswer(evidence.capabilityId, evidence);
    const reply = rendered.reply || truthfulLimitationFor(evidence);
    const key = reply.toLowerCase();
    if (reply && !seen.has(key)) {
      seen.add(key);
      replies.push(reply);
    }
  }
  if (!replies.length) {
    const first = (Array.isArray(toolOutputs) ? toolOutputs : [])[0];
    if (first) {
      const evidence = normalizeParalegalToolEvidence({
        toolName: first.name,
        result: first.result || {},
      });
      replies.push(truthfulLimitationFor(evidence));
    }
  }
  if (!replies.length) replies.push("I can’t verify that information right now. Please try again shortly.");

  const navigation = verifiedNavigationFrom(toolOutputs);
  const presentation = sanitizeParalegalResponseUi({
    reply: replies.join(" "),
    messageText,
    toolOutputs,
    navigation,
    suggestions: [],
  });
  return {
    ...presentation,
    provider: "openai_manager_paralegal_safe_fallback",
    grounded: replies.some((reply) => !/^I can’t verify/i.test(reply)),
  };
}

async function runParalegalResponsePipeline({
  generate,
  messageText = "",
  evidencePlan = {},
  toolOutputs = [],
} = {}) {
  if (typeof generate !== "function") throw new TypeError("generate must be a function");
  const attempts = [];
  let validationErrors = [];

  for (let attempt = 0; attempt <= MAX_CORRECTION_ATTEMPTS; attempt += 1) {
    let generated;
    try {
      generated = await generate(buildParalegalGenerationInstructions({
        messageText,
        evidencePlan,
        toolOutputs,
        validationErrors,
      }));
    } catch (_error) {
      validationErrors = ["generation_failed"];
      attempts.push({
        attempt: attempt + 1,
        errors: validationErrors,
        accepted: false,
      });
      continue;
    }
    const candidate = normalizeCandidate(generated);
    const presentation = sanitizeParalegalResponseUi({
      ...candidate,
      messageText,
      toolOutputs,
    });
    validationErrors = auditParalegalSemanticResponse({
      ...presentation,
      messageText,
      toolOutputs,
      evidencePlan,
    });
    attempts.push({
      attempt: attempt + 1,
      errors: validationErrors,
      uiWarnings: presentation.warnings,
      accepted: validationErrors.length === 0,
    });
    if (!validationErrors.length) {
      return {
        ...candidate,
        ...presentation,
        provider: "openai_manager_paralegal",
        grounded: true,
        validation: {
          correctionAttempts: attempt,
          exhausted: false,
          retryOutcome: attempt === 0 ? "not_needed" : "corrected",
          attempts,
        },
      };
    }
  }

  const fallback = buildParalegalEvidenceFallback({
    messageText,
    evidencePlan,
    toolOutputs,
  });
  const fallbackErrors = auditParalegalSemanticResponse({
    ...fallback,
    messageText,
    evidencePlan,
    toolOutputs,
  });
  const validatedFallback = fallbackErrors.length
    ? {
        reply: "I can’t verify that information right now. Please try again shortly.",
        navigation: null,
        suggestions: [],
        reviewCard: null,
        warnings: [...(fallback.warnings || []), "evidence_fallback_rejected"],
        provider: "openai_manager_paralegal_safe_fallback",
        grounded: false,
      }
    : fallback;
  return {
    ...validatedFallback,
    validation: {
      correctionAttempts: MAX_CORRECTION_ATTEMPTS,
      exhausted: true,
      retryOutcome: "safe_fallback",
      failureClasses: [...new Set(validationErrors)],
      fallbackFailureClasses: fallbackErrors,
      attempts,
    },
  };
}

module.exports = {
  MAX_CORRECTION_ATTEMPTS,
  buildParalegalEvidenceFallback,
  buildParalegalGenerationInstructions,
  evidenceBrief,
  normalizeCandidate,
  runParalegalResponsePipeline,
};
