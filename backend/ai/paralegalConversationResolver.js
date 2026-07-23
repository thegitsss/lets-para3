const {
  isCorrectionReference,
  isParalegalAccountWideSubjectChange,
  isReferentialFollowUp,
  mergeVerifiedParalegalEntities,
  normalizeText,
  prepareParalegalConversationState,
  sanitizeParalegalEntity,
} = require("./paralegalConversationPolicy");

const REFERENCE_STOP_WORDS = new Set([
  "a",
  "about",
  "all",
  "and",
  "application",
  "case",
  "for",
  "invitation",
  "invite",
  "is",
  "matter",
  "my",
  "of",
  "on",
  "please",
  "status",
  "the",
  "this",
  "that",
  "what",
  "workspace",
]);

function normalizeEntityType(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "case") return "matter";
  return ["matter", "application", "invitation"].includes(normalized) ? normalized : "";
}

function factValue(evidence = {}, suffix = "") {
  const target = String(suffix || "").toLowerCase();
  const fact = (Array.isArray(evidence.facts) ? evidence.facts : []).find((entry) => {
    const key = String(entry?.key || "").toLowerCase();
    return key === target || key.endsWith(`.${target}`);
  });
  return fact?.value;
}

function verifiedToolResult(entry = {}) {
  const result = entry.result || {};
  const evidence = result.evidence || {};
  const state = String(result.evidenceState || evidence.state || "").toLowerCase();
  return result.ok === true &&
    result.available !== false &&
    evidence.authorized !== false &&
    state === "verified";
}

function matterEntityFromTool(entry = {}) {
  if (!verifiedToolResult(entry)) return null;
  const result = entry.result || {};
  const evidence = result.evidence || {};
  const id = String(
    result.matterId ||
    result.caseId ||
    evidence.matterId ||
    evidence.subjectId ||
    factValue(evidence, "matterId") ||
    ""
  );
  if (!id) return null;
  const name = String(
    result.title ||
    result.caseTitle ||
    factValue(evidence, "title") ||
    "Matter"
  );
  return sanitizeParalegalEntity({
    type: "matter",
    id,
    name,
    matterId: id,
    source: `tool:${String(entry.name || "unknown").slice(0, 100)}`,
  });
}

function applicationEntitiesFromTool(entry = {}) {
  if (entry.name !== "get_paralegal_application_activity" || !verifiedToolResult(entry)) return [];
  return (Array.isArray(entry.result?.items) ? entry.result.items : []).map((item) => {
    const id = String(item.applicationId || item.caseId || item.jobId || "");
    if (!id) return null;
    return sanitizeParalegalEntity({
      type: "application",
      id,
      name: String(item.title || "Matter application"),
      matterId: String(item.caseId || ""),
      source: `tool:${entry.name}`,
    });
  }).filter(Boolean);
}

function matterListEntitiesFromTool(entry = {}) {
  if (!["get_paralegal_case_overview", "get_paralegal_payout_history"].includes(entry.name) ||
      !verifiedToolResult(entry)) {
    return [];
  }
  return (Array.isArray(entry.result?.items) ? entry.result.items : []).map((item) => {
    const id = String(item.caseId || item.matterId || "");
    if (!id) return null;
    return sanitizeParalegalEntity({
      type: "matter",
      id,
      name: String(item.title || "Matter"),
      matterId: id,
      source: `tool:${entry.name}`,
    });
  }).filter(Boolean);
}

function invitationEntitiesFromTool(entry = {}) {
  if (entry.name !== "get_paralegal_invitation_activity" || !verifiedToolResult(entry)) return [];
  return (Array.isArray(entry.result?.items) ? entry.result.items : []).map((item) => {
    const caseId = String(item.caseId || "");
    if (!caseId) return null;
    return sanitizeParalegalEntity({
      type: "invitation",
      id: `invitation:${caseId}`,
      name: String(item.title || "Matter invitation"),
      matterId: caseId,
      source: `tool:${entry.name}`,
    });
  }).filter(Boolean);
}

function deriveVerifiedParalegalEntities(toolOutputs = []) {
  const entities = [];
  for (const entry of Array.isArray(toolOutputs) ? toolOutputs : []) {
    const matter = matterEntityFromTool(entry);
    if (matter) entities.push(matter);
    entities.push(...matterListEntitiesFromTool(entry));
    entities.push(...applicationEntitiesFromTool(entry));
    entities.push(...invitationEntitiesFromTool(entry));
  }
  return mergeVerifiedParalegalEntities(entities);
}

function tokenizeReference(value = "") {
  return normalizeText(value)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !REFERENCE_STOP_WORDS.has(token));
}

function matchVerifiedEntities(messageText = "", entities = [], expectedTypes = []) {
  const allowedTypes = new Set(
    (Array.isArray(expectedTypes) ? expectedTypes : [])
      .map(normalizeEntityType)
      .filter(Boolean)
  );
  const candidates = (Array.isArray(entities) ? entities : []).filter((entity) =>
    !allowedTypes.size || allowedTypes.has(normalizeEntityType(entity.type))
  );
  const tokens = tokenizeReference(messageText);
  if (!tokens.length) return [];
  return candidates
    .map((entity) => {
      const name = normalizeText(entity.name);
      const matches = tokens.filter((token) => name.includes(token));
      return { entity, score: matches.length };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
}

function oneClarification(entities = [], expectedTypes = []) {
  const names = [...new Set(
    (Array.isArray(entities) ? entities : [])
      .map((entity) => String(entity?.name || "").trim())
      .filter(Boolean)
  )].slice(0, 3);
  const label = expectedTypes.length === 1
    ? expectedTypes[0] === "matter"
      ? "matter"
      : expectedTypes[0]
    : "record";
  return names.length
    ? `Which ${label} do you mean: ${names.join(", ")}?`
    : `Which ${label} do you mean?`;
}

function resolveParalegalConversationReference({
  messageText = "",
  conversationState = {},
  pageContext = {},
  expectedTypes = [],
} = {}) {
  const state = prepareParalegalConversationState(messageText, conversationState);
  const normalizedTypes = (Array.isArray(expectedTypes) ? expectedTypes : [])
    .map(normalizeEntityType)
    .filter(Boolean);
  const allowed = (entity) =>
    entity && (!normalizedTypes.length || normalizedTypes.includes(normalizeEntityType(entity.type)));

  if (state.correctionAmbiguous) {
    const candidates = state.verifiedEntities.filter(allowed);
    return {
      status: "clarification_needed",
      entities: [],
      clarificationPrompt: oneClarification(candidates, normalizedTypes),
      state,
    };
  }

  const selectMany = /^(?:both|all|all of them|both of them)[?.!\s]*$/i.test(String(messageText || "").trim());
  if (selectMany) {
    const type = normalizeEntityType(state.activeEntity?.type);
    const entities = state.verifiedEntities.filter((entity) =>
      allowed(entity) && (!type || normalizeEntityType(entity.type) === type)
    );
    if (entities.length > 1) {
      return { status: "resolved_many", entities, clarificationPrompt: "", state };
    }
    if (entities.length === 1) {
      return { status: "resolved", entity: entities[0], entities, clarificationPrompt: "", state };
    }
    return {
      status: "verification_required",
      entities: [],
      clarificationPrompt: oneClarification([], normalizedTypes),
      state,
    };
  }

  if (isCorrectionReference(messageText) && allowed(state.activeEntity)) {
    return {
      status: "resolved",
      entity: state.activeEntity,
      entities: [state.activeEntity],
      clarificationPrompt: "",
      state,
    };
  }

  const matches = matchVerifiedEntities(messageText, state.verifiedEntities, normalizedTypes);
  if (matches.length) {
    const topScore = matches[0].score;
    const top = matches.filter((entry) => entry.score === topScore).map((entry) => entry.entity);
    if (top.length === 1) {
      return { status: "resolved", entity: top[0], entities: top, clarificationPrompt: "", state };
    }
    return {
      status: "clarification_needed",
      entities: [],
      clarificationPrompt: oneClarification(top, normalizedTypes),
      state,
    };
  }

  if (isReferentialFollowUp(messageText) && allowed(state.activeEntity)) {
    return {
      status: "resolved",
      entity: state.activeEntity,
      entities: [state.activeEntity],
      clarificationPrompt: "",
      state,
    };
  }

  const pageCandidates = [
    { type: "matter", id: pageContext.caseId },
    { type: "application", id: pageContext.applicationId },
    { type: "invitation", id: pageContext.invitationId },
  ].filter((candidate) => candidate.id && (!normalizedTypes.length || normalizedTypes.includes(candidate.type)));
  for (const candidate of pageCandidates) {
    const verified = state.verifiedEntities.find((entity) =>
      entity.type === candidate.type && entity.id === String(candidate.id)
    );
    if (verified) {
      return {
        status: "resolved",
        entity: verified,
        entities: [verified],
        clarificationPrompt: "",
        state,
        pageContextVerifiedByMemory: true,
      };
    }
  }

  const shouldVerify = Boolean(
    pageCandidates.length ||
    normalizedTypes.length ||
    /\b(?:matter|case|workspace|application|invitation|invite)\b/i.test(String(messageText || ""))
  );
  return {
    status: shouldVerify ? "verification_required" : "none",
    entities: [],
    clarificationPrompt: "",
    candidateReferences: pageCandidates.map((candidate) => ({ ...candidate, id: String(candidate.id) })),
    state,
  };
}

function buildParalegalConversationState({
  messageText = "",
  previousState = {},
  toolOutputs = [],
  capabilityIds = [],
  requestedDimensions = [],
} = {}) {
  const prepared = prepareParalegalConversationState(messageText, previousState);
  const derived = deriveVerifiedParalegalEntities(toolOutputs);
  const verifiedEntities = mergeVerifiedParalegalEntities(prepared.verifiedEntities, derived[0] || null)
    .concat(derived.slice(1))
    .reduce((all, entity) => mergeVerifiedParalegalEntities(all, entity), []);
  const newlyActive = isCorrectionReference(messageText) || isParalegalAccountWideSubjectChange(messageText)
    ? prepared.activeEntity
    : derived[0] || prepared.activeEntity;
  return {
    activeEntity: newlyActive || null,
    verifiedEntities,
    lastCapabilityIds: [...new Set((capabilityIds || []).map(String).filter(Boolean))].slice(0, 12),
    lastRequestedDimensions: [...new Set((requestedDimensions || []).map(String).filter(Boolean))].slice(0, 8),
    awaitingField: "",
    correctionReference: prepared.correctionReference === true,
    correctionAmbiguous: prepared.correctionAmbiguous === true,
    subjectChanged: prepared.subjectChanged === true,
  };
}

module.exports = {
  buildParalegalConversationState,
  deriveVerifiedParalegalEntities,
  factValue,
  matchVerifiedEntities,
  matterListEntitiesFromTool,
  normalizeEntityType,
  oneClarification,
  resolveParalegalConversationReference,
  tokenizeReference,
  verifiedToolResult,
};
