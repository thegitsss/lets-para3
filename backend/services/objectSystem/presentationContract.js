const { z } = require("zod");

const { assertCanonicalObjectUrl, isSafeObjectUrl, parseExplicitObjectUrl } = require("./objectUrlPolicy");
const {
  MATTER_RELATIONSHIPS,
  MATTER_STATUS_CODES,
  TYPE_CONTRACTS,
  validateObjectProjection,
} = require("./objectContract");
const {
  ACTION_LABELS,
  ATTENTION_LABELS,
  COMMAND_REGISTRY,
  DISABLED_REASON_LABELS,
  FILE_CATEGORY_LABELS,
  PRESENTABLE_OBJECT_REGISTRY,
  PRESENTATION_SCHEMA_VERSION,
  RELATIONSHIP_LABELS,
} = require("./presentationRegistry");
const { getMatterAttentionPresentation } = require("./matterPresentationPolicy");

const PRESENTATION_KINDS = Object.freeze(["summary_row", "card", "contextual_panel", "full_page_header"]);
const COMMAND_CODES = Object.freeze(Object.keys(COMMAND_REGISTRY));
const ASSISTANT_CAPABILITIES = Object.freeze(["understand", "explain", "summarize", "navigate", "draft", "propose"]);
const PROHIBITED_ASSISTANT_ACTIONS = Object.freeze([
  "select", "assign", "fund", "refund", "release", "payout", "change_lifecycle",
  "change_access", "send_message", "mutate_file", "publish_review",
]);
const UNSAFE_PRESENTATION_KEY = /(?:^|_)(?:provider|stripe|payment_intent|charge|transfer|account|bank|storage|encryption|cipher|moderation|audit|idempotency|lease|fingerprint|secret|token|password|email|phone|notification_preference|security|raw_error|ip|ua|user_agent|object_ids?|record_ids?|user_ids?)(?:_|$)/i;
const UNSAFE_PRESENTATION_VALUE = /(?:^|\b)(?:pi|ch|tr|acct|pm|seti|cus|src|tok)_[a-z0-9_]+/i;
const SAFE_POLICY_KEYS = new Set(["idempotency_required"]);

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const iso = z.string().datetime({ offset: true });
const boundedText = (max) => z.string().trim().min(1).max(max);
const nullableText = (max) => boundedText(max).nullable();
const safeUrl = z.string().max(900).refine(isSafeObjectUrl);
const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
const detailRowSchema = z.object({ label: boundedText(80), value: boundedText(500) }).strict();
const actionSchema = z.object({
  code: boundedText(100),
  label: boundedText(140),
  enabled: z.boolean(),
  disabledReason: nullableText(260),
  href: safeUrl.nullable(),
}).strict();
const presentationSchema = z.object({
  schemaVersion: z.literal(PRESENTATION_SCHEMA_VERSION),
  source: z.literal("server_projection"),
  kind: z.enum(PRESENTATION_KINDS),
  objectType: z.enum(Object.keys(PRESENTABLE_OBJECT_REGISTRY)),
  object: z.object({ id: objectId, title: boundedText(300), canonicalUrl: safeUrl, version: iso }).strict(),
  status: z.object({ code: boundedText(100), label: boundedText(140), tone }).strict(),
  attention: z.object({ code: boundedText(100), label: boundedText(180), tone }).strict().nullable(),
  relationship: z.object({ code: boundedText(100), label: boundedText(180) }).strict(),
  readOnly: z.boolean(),
  actions: z.array(actionSchema).max(6),
  details: z.array(detailRowSchema).max(8),
  summary: nullableText(800),
  freshness: z.object({ state: z.literal("current"), sourceUpdatedAt: iso, projectedAt: iso }).strict(),
  links: z.object({ self: safeUrl }).strict(),
}).strict();

const commandSchema = z.object({
  schemaVersion: z.literal(1),
  code: z.enum(COMMAND_CODES),
  label: boundedText(140),
  capability: z.enum(["navigate", "refresh", "explain", "draft", "propose"]),
  enabled: z.boolean(),
  disabledReason: nullableText(260),
  href: safeUrl.nullable(),
  targetActionCode: boundedText(100).nullable(),
  executionPolicy: z.enum(["client_navigation", "read_only_server_refresh", "assistant_proposal_only", "proposal_only"]),
  confirmationRequired: z.boolean(),
  authoritativeRequirements: z.object({
    owningServiceRequired: z.boolean(),
    csrfRequired: z.boolean(),
    currentSourceVersionRequired: z.boolean(),
    idempotencyRequired: z.boolean(),
    userConfirmationRequired: z.boolean(),
  }).strict().nullable(),
}).strict();

const savedViewSchema = z.object({
  schemaVersion: z.literal(1),
  name: boundedText(80),
  objectTypes: z.array(z.enum(Object.keys(PRESENTABLE_OBJECT_REGISTRY))).min(1).max(5),
  filters: z.object({
    statusCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(12),
    relationshipCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(8),
    attentionCodes: z.array(z.enum(Object.keys(ATTENTION_LABELS))).max(5),
  }).strict(),
  sort: z.object({ field: z.enum(["updated_at", "title"]), direction: z.enum(["asc", "desc"]) }).strict(),
  presentation: z.object({ density: z.enum(["comfortable", "compact"]), defaultKind: z.enum(["summary_row", "card"]) }).strict(),
}).strict();

const assistantContextSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("assistant_context_projection"),
  objectType: z.enum(Object.keys(PRESENTABLE_OBJECT_REGISTRY)),
  object: z.object({ id: objectId, title: boundedText(300), version: iso, canonicalUrl: safeUrl }).strict(),
  relationshipCode: boundedText(100),
  statusCode: boundedText(100),
  facts: z.array(detailRowSchema).max(8),
  capabilities: z.array(z.enum(ASSISTANT_CAPABILITIES)).length(ASSISTANT_CAPABILITIES.length),
  proposedActionCodes: z.array(boundedText(100)).max(6),
  privacy: z.object({ classification: z.literal("authorized_object_context"), rawModelAccess: z.literal(false), privateOperationalEvidence: z.literal(false) }).strict(),
  execution: z.object({ authoritativeMutationAllowed: z.literal(false), owningServiceRequired: z.literal(true), explicitUserConfirmationRequired: z.literal(true) }).strict(),
  freshness: z.object({ sourceUpdatedAt: iso, projectedAt: iso }).strict(),
}).strict();

class PresentationContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "PresentationContractError";
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
function unsafeEvidence(value) {
  if (Array.isArray(value)) return value.some(unsafeEvidence);
  if (!value || typeof value !== "object") return typeof value === "string" && UNSAFE_PRESENTATION_VALUE.test(value);
  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    return (!SAFE_POLICY_KEYS.has(normalizedKey) && UNSAFE_PRESENTATION_KEY.test(normalizedKey)) || unsafeEvidence(child);
  });
}
function validatePresentation(input) {
  if (unsafeEvidence(input)) throw new PresentationContractError("unsafe_presentation_evidence");
  const parsed = presentationSchema.safeParse(input);
  if (!parsed.success) throw new PresentationContractError("presentation_invalid");
  if (parsed.data.object.canonicalUrl !== parsed.data.links.self || parsed.data.object.version !== parsed.data.freshness.sourceUpdatedAt) {
    throw new PresentationContractError("presentation_inconsistent");
  }
  try {
    const parsedUrl = parseExplicitObjectUrl(parsed.data.object.canonicalUrl);
    assertCanonicalObjectUrl({
      objectType: parsed.data.objectType,
      objectId: parsed.data.object.id,
      matterId: parsedUrl?.matterId || null,
      url: parsed.data.object.canonicalUrl,
    });
  } catch (_error) {
    throw new PresentationContractError("presentation_canonical_url_mismatch");
  }
  return deepFreeze(parsed.data);
}
function assertPresentationMatchesProjection(projection, presentation) {
  const matterId = projection.objectType === "matter"
    ? projection.object.id
    : projection.content?.matterId || null;
  try {
    assertCanonicalObjectUrl({
      objectType: projection.objectType,
      objectId: projection.object.id,
      matterId,
      url: projection.object.canonicalUrl,
    });
  } catch (_error) {
    throw new PresentationContractError("presentation_canonical_url_mismatch");
  }
  const expectedActions = projection.actions.map(mapAction);
  if (
    presentation.objectType !== projection.objectType ||
    presentation.object.id !== projection.object.id ||
    presentation.object.title !== projection.object.title ||
    presentation.object.canonicalUrl !== projection.object.canonicalUrl ||
    presentation.object.version !== projection.object.version ||
    presentation.status.code !== projection.status.code ||
    presentation.status.label !== projection.status.label ||
    presentation.status.tone !== projection.status.tone ||
    presentation.relationship.code !== projection.relationship.code ||
    presentation.freshness.sourceUpdatedAt !== projection.freshness.sourceUpdatedAt ||
    JSON.stringify(presentation.actions) !== JSON.stringify(expectedActions)
  ) {
    throw new PresentationContractError("presentation_projection_mismatch");
  }
  return presentation;
}
function identityEligible(projection) {
  const registration = PRESENTABLE_OBJECT_REGISTRY[projection.objectType];
  if (!registration || !registration.tiers.includes(projection.projectionTier)) return false;
  if (registration.identity === "canonical_only") return projection.content?.identityKind === "canonical";
  if (registration.identity === "matter_scoped_singleton") return projection.content?.identityKind === "matter_scoped_singleton";
  return true;
}
function stringify(value) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ").slice(0, 500) || null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).slice(0, 500);
}
function row(label, value) {
  const normalized = stringify(value);
  return normalized ? { label, value: normalized } : null;
}
function detailsFor(projection) {
  const content = projection.content || {};
  const matterFacts = content.facts || {};
  const byType = {
    matter: [
      row("Practice area", content.practiceArea || matterFacts.practiceArea),
      row("Funding", content.fundingState || matterFacts.fundingStatus),
      row("Location", matterFacts.location),
      row("Available sections", content.availableTabs || content.tabs?.filter((tab) => tab.available).map((tab) => tab.id)),
    ],
    profile: [row("Role", content.role), row("Location", content.location), row("Practice areas", content.practiceAreas)],
    application: [row("Candidate", content.candidateName), row("Applied", content.occurredAt || content.appliedAt)],
    invitation: [row("Candidate", content.candidateName), row("Invited", content.invitedAt), row("Responded", content.respondedAt)],
    assignment: [row("Assignment", content.assignmentKind), row("Matter status", content.matterStatus), row("Funding", content.fundingStatus)],
    file: [row("Category", FILE_CATEGORY_LABELS[content.category]), row("Version", content.version), row("Uploaded", content.uploadedAt)],
    message: [row("From", content.authorRelationship), row("Sent", content.sentAt), row("Preview", content.bodyPreview)],
    financial_summary: [row("Currency", content.currency?.toUpperCase()), row("Payout", content.payoutState), row("Reconciliation", content.reconciliationState)],
    conversation: [row("Messages", content.visibleCount), row("Unread", content.unreadCount), row("Last message", content.lastMessageAt)],
  };
  return (byType[projection.objectType] || []).filter(Boolean).slice(0, 8);
}
function summaryFor(projection) {
  const content = projection.content || {};
  if (projection.objectType === "matter") return stringify(content.summary || content.facts?.summary || content.practiceArea || content.facts?.practiceArea);
  if (projection.objectType === "profile") return stringify(content.summary || content.location);
  if (projection.objectType === "application") return stringify(content.candidateName ? `Application from ${content.candidateName}` : null);
  if (projection.objectType === "invitation") return stringify(content.candidateName ? `Invitation for ${content.candidateName}` : null);
  if (projection.objectType === "assignment") return stringify(content.assignmentKind ? `${content.assignmentKind} matter assignment` : "Matter assignment");
  if (projection.objectType === "file") return stringify(content.category ? `Current ${FILE_CATEGORY_LABELS[content.category] || "file"}` : null);
  if (projection.objectType === "message") return stringify(content.bodyPreview);
  if (projection.objectType === "financial_summary") return stringify(content.amounts?.find((entry) => entry.emphasis)?.code?.replace(/_/g, " "));
  if (projection.objectType === "conversation") return stringify(content.unreadCount ? `${content.unreadCount} unread` : "No unread messages");
  return null;
}
function mapAction(action) {
  const label = ACTION_LABELS[action.code];
  if (!label) throw new PresentationContractError("presentation_action_unregistered");
  const disabledReason = action.enabled ? null : DISABLED_REASON_LABELS[action.disabledReasonCode];
  if (!action.enabled && !disabledReason) throw new PresentationContractError("presentation_disabled_reason_unregistered");
  return { code: action.code, label, enabled: action.enabled, disabledReason, href: action.enabled ? action.href : null };
}
function attentionFor(projection) {
  const source = projection.content?.attention || (projection.objectType === "matter" && projection.content?.state?.attention
    ? { code: projection.content.state.attention, tone: null }
    : null);
  if (!source) return null;
  const label = ATTENTION_LABELS[source.code];
  if (!label) throw new PresentationContractError("presentation_attention_unregistered");
  const tone = source.tone || getMatterAttentionPresentation(source.code)?.tone;
  if (!tone) throw new PresentationContractError("presentation_attention_unregistered");
  return { code: source.code, label, tone };
}
function projectPresentation(projectionInput, { kind } = {}) {
  const projection = validateObjectProjection(projectionInput);
  if (!PRESENTATION_KINDS.includes(kind)) throw new PresentationContractError("presentation_kind_invalid");
  const requiredTier = kind === "contextual_panel" ? "contextual_panel" : kind === "full_page_header" ? "detail" : "summary";
  if (projection.projectionTier !== requiredTier) throw new PresentationContractError("presentation_tier_mismatch");
  if (!identityEligible(projection)) throw new PresentationContractError("presentation_identity_ineligible");
  const relationshipLabel = RELATIONSHIP_LABELS[projection.relationship.code];
  if (!relationshipLabel) throw new PresentationContractError("presentation_relationship_unregistered");
  const presentation = validatePresentation({
    schemaVersion: 1,
    source: "server_projection",
    kind,
    objectType: projection.objectType,
    object: { id: projection.object.id, title: projection.object.title, canonicalUrl: projection.object.canonicalUrl, version: projection.object.version },
    status: { code: projection.status.code, label: projection.status.label, tone: projection.status.tone },
    attention: attentionFor(projection),
    relationship: { code: projection.relationship.code, label: relationshipLabel },
    readOnly: !projection.actions.some((action) => action.enabled),
    actions: projection.actions.map(mapAction),
    details: detailsFor(projection),
    summary: summaryFor(projection),
    freshness: { state: "current", sourceUpdatedAt: projection.freshness.sourceUpdatedAt, projectedAt: projection.freshness.projectedAt },
    links: { self: projection.links.self },
  });
  return assertPresentationMatchesProjection(projection, presentation);
}

function validateCommand(input) {
  if (unsafeEvidence(input)) throw new PresentationContractError("unsafe_command_evidence");
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new PresentationContractError("command_invalid");
  const command = parsed.data;
  const registration = COMMAND_REGISTRY[command.code];
  if (!registration || registration.capability !== command.capability || registration.executionPolicy !== command.executionPolicy || registration.label !== command.label) {
    throw new PresentationContractError("command_registry_mismatch");
  }
  if (command.capability === "navigate" && (!command.href || command.targetActionCode)) throw new PresentationContractError("command_navigation_invalid");
  if (command.capability !== "navigate" && command.href) throw new PresentationContractError("command_href_forbidden");
  if (command.code === "propose_authorized_action") {
    if (!command.targetActionCode || !ACTION_LABELS[command.targetActionCode] || !command.authoritativeRequirements || command.confirmationRequired !== true ||
        Object.values(command.authoritativeRequirements).some((required) => required !== true)) {
      throw new PresentationContractError("command_proposal_invalid");
    }
  } else if (command.authoritativeRequirements || command.confirmationRequired !== false) {
    throw new PresentationContractError("command_requirements_forbidden");
  }
  return deepFreeze(command);
}
function commandFromRegistry(code, values = {}) {
  const policy = COMMAND_REGISTRY[code];
  return validateCommand({
    schemaVersion: 1,
    code,
    label: policy.label,
    capability: policy.capability,
    enabled: values.enabled !== false,
    disabledReason: values.enabled === false ? values.disabledReason || "This command is unavailable." : null,
    href: values.href || null,
    targetActionCode: values.targetActionCode || null,
    executionPolicy: policy.executionPolicy,
    confirmationRequired: code === "propose_authorized_action",
    authoritativeRequirements: code === "propose_authorized_action" ? {
      owningServiceRequired: true,
      csrfRequired: true,
      currentSourceVersionRequired: true,
      idempotencyRequired: true,
      userConfirmationRequired: true,
    } : null,
  });
}
function projectCommandCatalog(projectionInput) {
  const projection = validateObjectProjection(projectionInput);
  if (!identityEligible(projection)) throw new PresentationContractError("command_identity_ineligible");
  const commands = [
    commandFromRegistry("navigate_object", { href: projection.links.self }),
    commandFromRegistry("refresh_object"),
    commandFromRegistry("explain_object"),
    commandFromRegistry("draft_note"),
  ];
  const enabledAction = projection.actions.find((action) => action.enabled);
  if (enabledAction) commands.push(commandFromRegistry("propose_authorized_action", { targetActionCode: enabledAction.code }));
  return deepFreeze({ schemaVersion: 1, objectType: projection.objectType, objectVersion: projection.object.version, commands });
}

function validateSavedView(input) {
  if (unsafeEvidence(input)) throw new PresentationContractError("unsafe_saved_view_evidence");
  const parsed = savedViewSchema.safeParse(input);
  if (!parsed.success) throw new PresentationContractError("saved_view_invalid");
  const view = parsed.data;
  if (new Set(view.objectTypes).size !== view.objectTypes.length || Object.values(view.filters).some((list) => new Set(list).size !== list.length)) {
    throw new PresentationContractError("saved_view_duplicate_value");
  }
  const statuses = new Set();
  const relationships = new Set();
  for (const objectType of view.objectTypes) {
    const contract = objectType === "matter"
      ? { statuses: MATTER_STATUS_CODES, relationships: MATTER_RELATIONSHIPS }
      : TYPE_CONTRACTS[objectType];
    contract?.statuses?.forEach((code) => statuses.add(code));
    contract?.relationships?.forEach((code) => relationships.add(code));
  }
  if (view.filters.statusCodes.some((code) => !statuses.has(code)) ||
      view.filters.relationshipCodes.some((code) => !relationships.has(code)) ||
      (view.filters.attentionCodes.length && !view.objectTypes.includes("matter"))) {
    throw new PresentationContractError("saved_view_filter_unregistered");
  }
  return deepFreeze(view);
}

function assistantFacts(projection) {
  const content = projection.content || {};
  if (projection.objectType === "matter") return [row("Practice area", content.safeFacts?.practiceArea), row("Summary", content.safeFacts?.summary), row("Funding", content.safeFacts?.fundingState)].filter(Boolean);
  if (projection.objectType === "profile") return [row("Role", content.role), row("Location", content.location), row("Practice areas", content.practiceAreas)].filter(Boolean);
  if (projection.objectType === "application") return [row("Status", content.statusCode)].filter(Boolean);
  if (projection.objectType === "invitation") return [row("Status", content.statusCode)].filter(Boolean);
  if (projection.objectType === "assignment") return [row("Status", content.statusCode)].filter(Boolean);
  if (projection.objectType === "file") return [row("Category", content.category), row("Version", content.version)].filter(Boolean);
  if (projection.objectType === "message") return [row("From", content.authorRelationship), row("Sent", content.sentAt), row("Message", content.body)].filter(Boolean);
  if (projection.objectType === "financial_summary") return [row("Status", content.statusCode), row("Currency", content.currency?.toUpperCase()), row("Payout", content.payoutState)].filter(Boolean);
  if (projection.objectType === "conversation") return [row("Unread", content.unreadCount), row("Read only", content.readOnly)].filter(Boolean);
  return [];
}
function buildAssistantObjectContext(projectionInput) {
  const projection = validateObjectProjection(projectionInput);
  if (projection.projectionTier !== "assistant_context") throw new PresentationContractError("assistant_context_tier_required");
  if (!identityEligible(projection)) throw new PresentationContractError("assistant_context_identity_ineligible");
  const inputActions = Array.isArray(projection.content?.proposedActionCodes) ? projection.content.proposedActionCodes : [];
  const enabledActions = new Set(projection.actions.filter((action) => action.enabled).map((action) => action.code));
  if (inputActions.some((code) => !enabledActions.has(code))) throw new PresentationContractError("assistant_action_not_authorized");
  const parsed = assistantContextSchema.safeParse({
    schemaVersion: 1,
    source: "assistant_context_projection",
    objectType: projection.objectType,
    object: { id: projection.object.id, title: projection.object.title, version: projection.object.version, canonicalUrl: projection.object.canonicalUrl },
    relationshipCode: projection.relationship.code,
    statusCode: projection.status.code,
    facts: assistantFacts(projection),
    capabilities: [...ASSISTANT_CAPABILITIES],
    proposedActionCodes: inputActions,
    privacy: { classification: "authorized_object_context", rawModelAccess: false, privateOperationalEvidence: false },
    execution: { authoritativeMutationAllowed: false, owningServiceRequired: true, explicitUserConfirmationRequired: true },
    freshness: { sourceUpdatedAt: projection.freshness.sourceUpdatedAt, projectedAt: projection.freshness.projectedAt },
  });
  if (!parsed.success || unsafeEvidence(parsed.data)) throw new PresentationContractError("assistant_context_invalid");
  return deepFreeze(parsed.data);
}

module.exports = Object.freeze({
  ASSISTANT_CAPABILITIES,
  PRESENTATION_KINDS,
  PROHIBITED_ASSISTANT_ACTIONS,
  PresentationContractError,
  buildAssistantObjectContext,
  assertPresentationMatchesProjection,
  identityEligible,
  projectCommandCatalog,
  projectPresentation,
  validateCommand,
  validatePresentation,
  validateSavedView,
});
