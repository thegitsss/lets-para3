const { z } = require("zod");

const {
  isSafeObjectUrl,
  isSafeMatterWorkspaceUrl,
  MATTER_WORKSPACE_TABS,
} = require("./objectUrlPolicy");

const OBJECT_CONTRACT_SCHEMA_VERSION = 1;
const OBJECT_TYPES = Object.freeze([
  "matter",
  "application",
  "invitation",
  "profile",
  "assignment",
  "financial_summary",
  "file",
  "message",
  "conversation",
]);
const OBJECT_PROJECTION_TIERS = Object.freeze([
  "summary",
  "detail",
  "contextual_panel",
  "search_result",
  "assistant_context",
]);
const MATTER_RELATIONSHIPS = Object.freeze([
  "owner_attorney",
  "assigned_paralegal",
  "candidate_paralegal",
  "withdrawn_paralegal",
  "admin",
]);
const MATTER_STATUS_CODES = Object.freeze([
  "archived",
  "under_administrative_review",
  "under_dispute_review",
  "withdrawal_review",
  "relisted_replacement_selection",
  "paused",
  "closed",
  "completed_release_pending",
  "completed_payment_released",
  "in_progress",
  "funding_required",
  "selection_in_progress",
  "open_for_applications",
]);
const MATTER_ACTION_CODES = Object.freeze([
  "complete_preengagement",
  "complete_and_release",
  "continue_selection",
  "continue_work",
  "download_archive",
  "inspect_matter",
  "invite_paralegal",
  "open_messages",
  "respond_invitation",
  "resolve_withdrawal",
  "review_applications",
  "review_preengagement",
  "select_replacement",
  "verify_replacement_funding",
  "view_application",
  "view_applications",
  "view_files",
  "view_financials",
  "view_matter",
  "view_payout",
  "view_review_status",
]);
const MATTER_PERMISSION_CODES = Object.freeze([
  "viewMatter",
  "viewApplications",
  "manageApplications",
  "viewWork",
  "updateTaskCompletion",
  "viewFiles",
  "uploadFiles",
  "deleteFiles",
  "viewMessages",
  "sendMessages",
  "viewActivity",
  "viewFinancials",
  "completeMatter",
  "manageWithdrawal",
  "relistMatter",
  "selectParalegal",
  "downloadArchive",
]);
const MATTER_DISABLED_REASON_CODES = Object.freeze([
  "action_unavailable",
  "attorney_ownership_required",
  "hire_required",
  "incomplete_scope_tasks",
  "payout_already_finalized",
  "scope_task_required",
  "completion_unavailable",
  "verification_required",
  "verified_funding_required",
  "withdrawal_resolution_unavailable",
  "withdrawal_state_required",
  "workspace_not_active",
]);
const MATTER_LIFECYCLE_CODES = Object.freeze([
  "open", "in_progress", "paused", "completed", "disputed", "closed",
]);
const MATTER_ASSIGNMENT_CODES = Object.freeze([
  "unassigned", "candidate_pending", "assigned", "withdrawn", "replacement_pending",
]);
const MATTER_FUNDING_CODES = Object.freeze([
  "unfunded", "verification_required", "funding_in_progress", "funded", "reconciling",
  "held", "released", "refunded", "disputed",
]);
const MATTER_WORKSPACE_CODES = Object.freeze(["unavailable", "active", "read_only", "blocked"]);
const MATTER_ATTENTION_CODES = Object.freeze([
  "none", "attorney_action", "paralegal_action", "payment_attention", "administrative_review",
]);
const PRESENTATION_TONES = Object.freeze(["neutral", "info", "success", "warning", "danger"]);

const UNSAFE_FIELD_PATTERN = /(?:^|_)(?:stripe|provider|payment_intent|charge_id|transfer_id|account_id|storage_key|encryption|cipher|moderation|audit|idempotency|lease|fingerprint|internal|secret|password|email|phone|notification|preference|security|blocked|bank|ip_address|user_agent|request_path|request_method)(?:_|$)/i;
const UNSAFE_VALUE_PATTERN = /(?:^|\b)(?:pi|ch|tr|acct|pm|seti|cus|src|tok)_[a-z0-9_]+/i;

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, "malformed_object_id");
const isoSchema = z.string().datetime({ offset: true });
const nullableIsoSchema = isoSchema.nullable();
const boundedText = (maximum) => z.string().trim().min(1).max(maximum);
const nullableText = (maximum) => boundedText(maximum).nullable();
const safeUrlSchema = z.string().max(900).refine(isSafeMatterWorkspaceUrl, "unsafe_object_url");
const safeObjectUrlSchema = z.string().max(900).refine(isSafeObjectUrl, "unsafe_object_url");
const toneSchema = z.enum(PRESENTATION_TONES);

const statusSchema = z.object({
  code: z.enum(MATTER_STATUS_CODES),
  label: boundedText(120),
  tone: toneSchema,
  reasonCode: z.literal(null),
}).strict();

const relationshipSchema = z.object({
  code: z.enum(MATTER_RELATIONSHIPS),
  candidateKind: z.enum(["application", "invitation"]).nullable(),
}).strict();

const actionSchema = z.object({
  code: z.enum(MATTER_ACTION_CODES),
  labelCode: z.string().regex(/^matter_action_[a-z0-9_]+$/).max(120),
  targetTab: z.enum(MATTER_WORKSPACE_TABS),
  enabled: z.boolean(),
  disabledReasonCode: z.enum(MATTER_DISABLED_REASON_CODES).nullable(),
  href: safeUrlSchema.nullable(),
}).strict().superRefine((action, context) => {
  if (action.enabled && !action.href) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "enabled_action_requires_href" });
  }
  if (action.enabled && action.disabledReasonCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "enabled_action_has_disabled_reason" });
  }
  if (!action.enabled && !action.disabledReasonCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "disabled_action_requires_reason" });
  }
  if (!action.enabled && action.href) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "disabled_action_must_not_have_href" });
  }
});

const attentionSchema = z.object({
  code: z.enum(MATTER_ATTENTION_CODES),
  tone: toneSchema,
}).strict();

const taskProgressSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict().refine((value) => value.completed <= value.total, "invalid_task_progress");

const personSchema = z.object({
  id: objectIdSchema.nullable(),
  name: nullableText(160),
}).strict();

const factsSchema = z.object({
  summary: nullableText(500),
  description: nullableText(20_000),
  location: nullableText(200),
  deadline: nullableIsoSchema,
  compensationCents: z.number().int().nonnegative().nullable(),
  currency: z.string().regex(/^[a-z]{3}$/),
  attorney: personSchema.nullable(),
  paralegal: personSchema.nullable(),
  taskProgress: taskProgressSchema.nullable(),
  fundingStatus: z.enum(MATTER_FUNDING_CODES),
  applicationCount: z.number().int().nonnegative().optional(),
  candidate: z.object({
    kind: z.enum(["application", "invitation"]).nullable(),
    status: nullableText(80),
    preEngagementStatus: nullableText(80),
  }).strict().optional(),
  withdrawal: z.object({
    payoutFinalizedAt: nullableIsoSchema,
    disputeDeadlineAt: nullableIsoSchema,
  }).strict().optional(),
}).strict();

const stateSchema = z.object({
  lifecycle: z.enum(MATTER_LIFECYCLE_CODES),
  assignment: z.enum(MATTER_ASSIGNMENT_CODES),
  funding: z.enum(MATTER_FUNDING_CODES),
  workspace: z.enum(MATTER_WORKSPACE_CODES),
  attention: z.enum(MATTER_ATTENTION_CODES),
  displayStatus: z.enum(MATTER_STATUS_CODES),
}).strict();

const tabSchema = z.object({
  id: z.enum(MATTER_WORKSPACE_TABS),
  labelCode: z.string().regex(/^matter_tab_[a-z0-9_]+$/).max(120),
  available: z.boolean(),
  readOnly: z.boolean(),
  reasonCode: nullableText(120),
}).strict();

const baseEnvelopeSchema = z.object({
  schemaVersion: z.literal(OBJECT_CONTRACT_SCHEMA_VERSION),
  objectType: z.literal("matter"),
  projectionTier: z.enum(OBJECT_PROJECTION_TIERS),
  object: z.object({
    id: objectIdSchema,
    title: boundedText(300),
    canonicalUrl: safeUrlSchema,
    version: isoSchema,
    updatedAt: isoSchema,
  }).strict(),
  status: statusSchema,
  relationship: relationshipSchema,
  permissions: z.array(z.enum(MATTER_PERMISSION_CODES)).max(MATTER_PERMISSION_CODES.length)
    .refine((values) => new Set(values).size === values.length, "duplicate_permission"),
  actions: z.array(actionSchema).max(6)
    .refine((values) => new Set(values.map((item) => item.code)).size === values.length, "duplicate_action"),
  links: z.object({ self: safeUrlSchema }).strict(),
  freshness: z.object({
    state: z.literal("current"),
    projectedAt: isoSchema,
    sourceUpdatedAt: isoSchema,
    staleAfter: nullableIsoSchema,
  }).strict(),
  timelineSummary: z.object({
    latestVisibleEventAt: z.literal(null),
    visibleEventCount: z.literal(null),
  }).strict(),
}).strict();

const summaryContentSchema = z.object({
  practiceArea: nullableText(160),
  attention: attentionSchema,
  fundingState: z.enum(MATTER_FUNDING_CODES),
  lastMeaningfulUpdateAt: isoSchema,
  primaryActionCode: z.enum(MATTER_ACTION_CODES).nullable(),
}).strict();

const detailContentSchema = z.object({
  state: stateSchema,
  facts: factsSchema,
  tabs: z.array(tabSchema).length(MATTER_WORKSPACE_TABS.length),
}).strict();

const panelContentSchema = z.object({
  practiceArea: nullableText(160),
  summary: nullableText(500),
  attention: attentionSchema,
  fundingState: z.enum(MATTER_FUNDING_CODES),
  availableTabs: z.array(z.enum(MATTER_WORKSPACE_TABS)).max(MATTER_WORKSPACE_TABS.length),
  primaryActionCode: z.enum(MATTER_ACTION_CODES).nullable(),
}).strict();

const searchContentSchema = z.object({
  subtitle: nullableText(240),
  attentionCode: z.enum(MATTER_ATTENTION_CODES),
  lastMeaningfulUpdateAt: isoSchema,
}).strict();

const assistantContentSchema = z.object({
  state: stateSchema,
  attentionCode: z.enum(MATTER_ATTENTION_CODES),
  safeFacts: z.object({
    summary: nullableText(500),
    practiceArea: nullableText(160),
    location: nullableText(200),
    deadline: nullableIsoSchema,
    taskProgress: taskProgressSchema.nullable(),
    fundingState: z.enum(MATTER_FUNDING_CODES),
  }).strict(),
  proposedActionCodes: z.array(z.enum(MATTER_ACTION_CODES)).max(6),
}).strict();

const matterProjectionSchema = z.discriminatedUnion("projectionTier", [
  baseEnvelopeSchema.extend({ projectionTier: z.literal("summary"), content: summaryContentSchema }),
  baseEnvelopeSchema.extend({ projectionTier: z.literal("detail"), content: detailContentSchema }),
  baseEnvelopeSchema.extend({ projectionTier: z.literal("contextual_panel"), content: panelContentSchema }),
  baseEnvelopeSchema.extend({ projectionTier: z.literal("search_result"), content: searchContentSchema }),
  baseEnvelopeSchema.extend({ projectionTier: z.literal("assistant_context"), content: assistantContentSchema }),
]);

function freezeTypeContract(contract) {
  return Object.freeze(Object.fromEntries(Object.entries(contract).map(([key, value]) => [
    key,
    Array.isArray(value) ? Object.freeze(value) : value,
  ])));
}

const TYPE_CONTRACTS = Object.freeze({
  application: freezeTypeContract({
    statuses: ["pending", "submitted", "viewed", "shortlisted", "accepted", "rejected", "declined", "expired"],
    relationships: ["owner_attorney", "candidate_paralegal", "admin"],
    permissions: ["viewApplication", "manageApplication"],
    actions: ["review_candidate", "view_application", "respond_application"],
    disabledReasons: ["action_unavailable", "application_not_actionable", "application_read_only"],
    statusReasons: ["application_status_unavailable"],
  }),
  invitation: freezeTypeContract({
    statuses: ["pending", "accepted", "declined", "revoked", "expired", "superseded"],
    relationships: ["inviter_attorney", "invited_paralegal", "admin"],
    permissions: ["viewInvitation", "respondInvitation"],
    actions: ["respond_invitation", "view_invitation"],
    disabledReasons: ["action_unavailable", "invitation_not_actionable", "invitation_read_only"],
    statusReasons: ["invitation_status_unavailable"],
  }),
  profile: freezeTypeContract({
    statuses: ["active", "pending_approval", "denied", "hidden", "unavailable"],
    relationships: ["self", "public", "relationship", "administrator", "assistant_context"],
    permissions: ["viewProfile", "viewRelationshipProfile", "viewAdministrativeProfileSummary"],
    actions: ["view_profile"],
    disabledReasons: ["action_unavailable", "profile_link_unavailable", "profile_not_visible"],
    statusReasons: ["profile_not_visible"],
  }),
  assignment: freezeTypeContract({
    statuses: [
      "assigned", "replacement_pending", "pending_funding", "active",
      "withdrawal_pending", "withdrawn", "replaced", "completed", "revoked", "cancelled",
    ],
    relationships: ["owner_attorney", "assigned_paralegal", "withdrawn_paralegal", "admin"],
    permissions: ["viewAssignment", "viewPayout"],
    actions: ["view_assignment", "view_payout"],
    disabledReasons: ["action_unavailable", "assignment_read_only", "payout_not_available"],
    statusReasons: ["assignment_read_only"],
  }),
  financial_summary: freezeTypeContract({
    statuses: ["funded", "funding_pending", "verification_required", "reconciling", "held", "disputed", "partially_refunded", "refunded", "release_pending", "released", "payout_pending", "administratively_blocked"],
    relationships: ["owner_attorney", "assigned_paralegal", "withdrawn_paralegal", "admin"],
    permissions: ["viewFinancialSummary", "downloadReceipt"],
    actions: ["download_receipt"],
    disabledReasons: ["action_unavailable", "receipt_not_available", "financials_read_only"],
    statusReasons: ["currency_mismatch", "financial_evidence_mismatch", "administrative_review_required"],
  }),
  file: freezeTypeContract({
    statuses: ["pending_review", "approved", "attorney_revision", "unavailable"],
    relationships: ["owner_attorney", "assigned_paralegal", "admin"],
    permissions: ["viewFile", "downloadFile"],
    actions: ["download_file", "view_file"],
    disabledReasons: ["action_unavailable", "file_not_downloadable", "file_compatibility_only"],
    statusReasons: ["file_compatibility_only"],
  }),
  message: freezeTypeContract({
    statuses: ["sent"],
    relationships: ["owner_attorney", "assigned_paralegal"],
    permissions: ["viewMessage"],
    actions: ["view_message"],
    disabledReasons: ["action_unavailable"],
    statusReasons: ["message_read_only"],
  }),
  conversation: freezeTypeContract({
    statuses: ["active", "read_only"],
    relationships: ["owner_attorney", "assigned_paralegal"],
    permissions: ["viewConversation", "sendMessage"],
    actions: ["view_conversation"],
    disabledReasons: ["action_unavailable", "conversation_read_only"],
    statusReasons: ["conversation_read_only"],
  }),
});

const identityKindSchema = z.enum([
  "canonical",
  "legacy_compatibility",
  "split_source_compatibility",
  "matter_compatibility",
  "matter_scoped_singleton",
]);
const matterIdField = { matterId: objectIdSchema };
const safeStringList = (maximum = 12) => z.array(boundedText(160)).max(maximum);

const applicationTierSchemas = Object.freeze({
  summary: z.object({ ...matterIdField, candidateId: objectIdSchema, identityKind: identityKindSchema, sourceKind: z.enum(["standalone", "embedded", "split"]), occurredAt: nullableIsoSchema }).strict(),
  detail: z.object({ ...matterIdField, candidateId: objectIdSchema, candidateName: boundedText(160), identityKind: identityKindSchema, sourceKind: z.enum(["standalone", "embedded", "split"]), appliedAt: nullableIsoSchema, preEngagementStatus: nullableText(80) }).strict(),
  contextual_panel: z.object({ ...matterIdField, candidateName: boundedText(160), identityKind: identityKindSchema, occurredAt: nullableIsoSchema }).strict(),
  search_result: z.object({ ...matterIdField, candidateName: boundedText(160), identityKind: identityKindSchema, occurredAt: nullableIsoSchema }).strict(),
  assistant_context: z.object({ ...matterIdField, candidateId: objectIdSchema, identityKind: identityKindSchema, statusCode: z.enum(TYPE_CONTRACTS.application.statuses), proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.application.actions)).max(3) }).strict(),
});
const invitationTierSchemas = Object.freeze({
  summary: z.object({ ...matterIdField, candidateId: objectIdSchema, identityKind: identityKindSchema, invitedAt: nullableIsoSchema }).strict(),
  detail: z.object({ ...matterIdField, candidateId: objectIdSchema, candidateName: boundedText(160), identityKind: identityKindSchema, invitedAt: nullableIsoSchema, respondedAt: nullableIsoSchema }).strict(),
  contextual_panel: z.object({ ...matterIdField, candidateName: boundedText(160), identityKind: identityKindSchema, invitedAt: nullableIsoSchema }).strict(),
  search_result: z.object({ ...matterIdField, candidateName: boundedText(160), identityKind: identityKindSchema, invitedAt: nullableIsoSchema }).strict(),
  assistant_context: z.object({ ...matterIdField, candidateId: objectIdSchema, identityKind: identityKindSchema, statusCode: z.enum(TYPE_CONTRACTS.invitation.statuses), proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.invitation.actions)).max(2) }).strict(),
});

const profileStateAxesSchema = z.object({
  approval: z.enum(["approved", "pending", "denied", "unknown"]),
  visibility: z.enum(["visible", "hidden", "self_only", "unknown"]),
  availability: z.enum(["available", "unavailable", "unknown"]),
  readiness: z.enum(["ready", "needs_attention", "unknown"]),
  payoutReadiness: z.enum(["ready", "not_ready", "not_applicable", "unknown"]),
}).strict();
const profileTierSchemas = Object.freeze({
  summary: z.object({ role: z.enum(["attorney", "paralegal"]), location: nullableText(200), practiceAreas: safeStringList() }).strict(),
  detail: z.object({ role: z.enum(["attorney", "paralegal"]), name: boundedText(160), location: nullableText(200), summary: nullableText(4000), practiceAreas: safeStringList(), specialties: safeStringList(), yearsExperience: z.number().int().min(0).max(80).nullable(), availability: nullableText(200), stateAxes: profileStateAxesSchema }).strict(),
  contextual_panel: z.object({ role: z.enum(["attorney", "paralegal"]), location: nullableText(200), summary: nullableText(500), practiceAreas: safeStringList(6) }).strict(),
  search_result: z.object({ role: z.enum(["attorney", "paralegal"]), subtitle: nullableText(240), practiceAreas: safeStringList(6) }).strict(),
  assistant_context: z.object({ role: z.enum(["attorney", "paralegal"]), location: nullableText(200), practiceAreas: safeStringList(), availability: nullableText(200), stateAxes: profileStateAxesSchema, proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.profile.actions)).max(1) }).strict(),
});

const assignmentTierSchemas = Object.freeze({
  summary: z.object({ ...matterIdField, paralegalId: objectIdSchema.nullable(), identityKind: identityKindSchema, lastMeaningfulUpdateAt: isoSchema }).strict(),
  detail: z.object({ ...matterIdField, paralegalId: objectIdSchema.nullable(), identityKind: identityKindSchema, assignmentKind: z.enum(["initial", "replacement"]), matterStatus: z.enum(MATTER_STATUS_CODES), fundingStatus: z.enum(MATTER_FUNDING_CODES) }).strict(),
  contextual_panel: z.object({ ...matterIdField, paralegalId: objectIdSchema.nullable(), identityKind: identityKindSchema, matterStatus: z.enum(MATTER_STATUS_CODES) }).strict(),
  search_result: z.object({ searchable: z.literal(false), identityKind: z.literal("legacy_compatibility") }).strict(),
  assistant_context: z.object({ ...matterIdField, paralegalId: objectIdSchema.nullable(), identityKind: identityKindSchema, statusCode: z.enum(TYPE_CONTRACTS.assignment.statuses), proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.assignment.actions)).max(2) }).strict(),
});

const FINANCIAL_AMOUNT_CODES = Object.freeze([
  "matter_compensation", "attorney_platform_fee", "total_charge", "refunded",
  "remaining_funded_balance", "withdrawal_gross", "gross_compensation",
  "paralegal_platform_fee", "expected_payout", "paid", "original_principal",
  "original_attorney_fee", "original_total_charge", "verified_refunded",
  "verified_available_principal", "active_replacement_allocation", "recorded_payout",
  "recorded_platform_income",
]);
const FINANCIAL_RECONCILIATION_STATES = Object.freeze([
  "not_applicable", "unreconciled", "reconciling", "verified", "review_required",
]);
const financialAmountSchema = z.object({
  code: z.enum(FINANCIAL_AMOUNT_CODES),
  cents: z.number().int().nonnegative(),
  emphasis: z.boolean(),
}).strict();
const financialTierSchemas = Object.freeze({
  summary: z.object({ ...matterIdField, identityKind: identityKindSchema, currency: z.string().regex(/^[a-z]{3}$/), amounts: z.array(financialAmountSchema).max(10), payoutState: z.enum(["complete", "pending", "not_started"]), reconciliationState: z.enum(FINANCIAL_RECONCILIATION_STATES) }).strict(),
  detail: z.object({ ...matterIdField, identityKind: identityKindSchema, currency: z.string().regex(/^[a-z]{3}$/), amounts: z.array(financialAmountSchema).max(10), payoutState: z.enum(["complete", "pending", "not_started"]), paidAt: nullableIsoSchema, reconciliationState: z.enum(FINANCIAL_RECONCILIATION_STATES), receiptAvailable: z.boolean() }).strict(),
  contextual_panel: z.object({ ...matterIdField, identityKind: identityKindSchema, currency: z.string().regex(/^[a-z]{3}$/), emphasizedAmounts: z.array(financialAmountSchema).max(4), payoutState: z.enum(["complete", "pending", "not_started"]) }).strict(),
  search_result: z.object({ searchable: z.literal(false), identityKind: z.literal("matter_compatibility") }).strict(),
  assistant_context: z.object({ ...matterIdField, identityKind: identityKindSchema, currency: z.string().regex(/^[a-z]{3}$/), statusCode: z.enum(TYPE_CONTRACTS.financial_summary.statuses), payoutState: z.enum(["complete", "pending", "not_started"]), proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.financial_summary.actions)).max(1) }).strict(),
});

const FILE_CATEGORIES = Object.freeze(["pdf", "image", "spreadsheet", "presentation", "text", "document", "other"]);
const FILE_AVAILABILITY_STATES = Object.freeze([
  "reconciliation_required", "recorded_unverified", "invalid_storage_reference",
  "legacy_record_only", "missing",
]);
const FILE_UPLOADER_RELATIONSHIPS = Object.freeze(["owner_attorney", "assigned_paralegal", "unknown"]);
const fileTierSchemas = Object.freeze({
  summary: z.object({ ...matterIdField, identityKind: identityKindSchema, versionIdentity: z.literal("current_file_metadata"), category: z.enum(FILE_CATEGORIES), version: z.number().int().positive(), uploadedAt: nullableIsoSchema }).strict(),
  detail: z.object({ ...matterIdField, identityKind: identityKindSchema, versionIdentity: z.literal("current_file_metadata"), name: boundedText(300), category: z.enum(FILE_CATEGORIES), size: z.number().int().nonnegative().nullable(), version: z.number().int().positive(), replacementState: z.enum(["current", "versioned"]), availability: z.enum(FILE_AVAILABILITY_STATES), uploaderRelationship: z.enum(FILE_UPLOADER_RELATIONSHIPS), uploadedAt: nullableIsoSchema }).strict(),
  contextual_panel: z.object({ ...matterIdField, identityKind: identityKindSchema, versionIdentity: z.literal("current_file_metadata"), category: z.enum(FILE_CATEGORIES), version: z.number().int().positive(), uploadedAt: nullableIsoSchema }).strict(),
  search_result: z.object({ searchable: z.literal(false), identityKind: identityKindSchema, versionIdentity: z.literal("current_file_metadata") }).strict(),
  assistant_context: z.object({ ...matterIdField, identityKind: identityKindSchema, versionIdentity: z.literal("current_file_metadata"), statusCode: z.enum(TYPE_CONTRACTS.file.statuses), category: z.enum(FILE_CATEGORIES), version: z.number().int().positive(), proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.file.actions)).max(2) }).strict(),
});

const MESSAGE_AUTHOR_RELATIONSHIPS = Object.freeze(["owner_attorney", "assigned_paralegal", "system"]);
const messageTierSchemas = Object.freeze({
  summary: z.object({ ...matterIdField, authorRelationship: z.enum(MESSAGE_AUTHOR_RELATIONSHIPS), direction: z.enum(["incoming", "outgoing"]), type: z.enum(["text", "file", "audio", "system"]), sentAt: isoSchema, hasAttachment: z.boolean() }).strict(),
  detail: z.object({ ...matterIdField, authorRelationship: z.enum(MESSAGE_AUTHOR_RELATIONSHIPS), authorName: boundedText(160), direction: z.enum(["incoming", "outgoing"]), type: z.enum(["text", "file", "audio", "system"]), body: z.string().max(2000), sentAt: isoSchema, editedAt: nullableIsoSchema, readByViewer: z.boolean(), readByCounterpart: z.boolean(), attachment: z.object({ name: boundedText(300), size: z.number().int().nonnegative().nullable(), mimeType: nullableText(150) }).strict().nullable() }).strict(),
  contextual_panel: z.object({ ...matterIdField, authorRelationship: z.enum(MESSAGE_AUTHOR_RELATIONSHIPS), bodyPreview: z.string().max(240), sentAt: isoSchema }).strict(),
  search_result: z.object({ searchable: z.literal(false) }).strict(),
  assistant_context: z.object({ ...matterIdField, authorRelationship: z.enum(MESSAGE_AUTHOR_RELATIONSHIPS), body: z.string().max(2000), sentAt: isoSchema, proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.message.actions)).max(2) }).strict(),
});

const conversationTierSchemas = Object.freeze({
  summary: z.object({ ...matterIdField, identityKind: identityKindSchema, visibleCount: z.number().int().nonnegative(), unreadCount: z.number().int().nonnegative(), lastMessageAt: nullableIsoSchema }).strict(),
  detail: z.object({ ...matterIdField, identityKind: identityKindSchema, visibleCount: z.number().int().nonnegative(), unreadCount: z.number().int().nonnegative(), readOnly: z.boolean(), hasMore: z.boolean(), lastMessageAt: nullableIsoSchema }).strict(),
  contextual_panel: z.object({ ...matterIdField, identityKind: identityKindSchema, unreadCount: z.number().int().nonnegative(), lastMessageAt: nullableIsoSchema }).strict(),
  search_result: z.object({ searchable: z.literal(false), identityKind: z.literal("matter_compatibility") }).strict(),
  assistant_context: z.object({ ...matterIdField, identityKind: identityKindSchema, unreadCount: z.number().int().nonnegative(), readOnly: z.boolean(), proposedActionCodes: z.array(z.enum(TYPE_CONTRACTS.conversation.actions)).max(1) }).strict(),
});

const TYPE_TIER_SCHEMAS = Object.freeze({
  application: applicationTierSchemas,
  invitation: invitationTierSchemas,
  profile: profileTierSchemas,
  assignment: assignmentTierSchemas,
  financial_summary: financialTierSchemas,
  file: fileTierSchemas,
  message: messageTierSchemas,
  conversation: conversationTierSchemas,
});

const emptyTimelineSummarySchema = z.object({
  latestVisibleEventAt: z.literal(null),
  visibleEventCount: z.literal(null),
}).strict();
const TYPE_TIMELINE_SCHEMAS = Object.freeze({
  application: emptyTimelineSummarySchema,
  invitation: emptyTimelineSummarySchema,
  profile: emptyTimelineSummarySchema,
  assignment: emptyTimelineSummarySchema,
  financial_summary: emptyTimelineSummarySchema,
  file: emptyTimelineSummarySchema,
  message: z.object({ latestVisibleEventAt: isoSchema, visibleEventCount: z.literal(1) }).strict(),
  conversation: z.object({ latestVisibleEventAt: nullableIsoSchema, visibleEventCount: z.literal(null) }).strict(),
});

function typeProjectionSchema(objectType) {
  const contract = TYPE_CONTRACTS[objectType];
  const relationship = z.object({ code: z.enum(contract.relationships), candidateKind: z.enum(["application", "invitation"]).nullable() }).strict();
  const action = z.object({
    code: z.enum(contract.actions),
    labelCode: z.string().regex(new RegExp(`^${objectType}_action_[a-z0-9_]+$`)).max(120),
    targetTab: z.enum(MATTER_WORKSPACE_TABS).nullable(),
    enabled: z.boolean(),
    disabledReasonCode: z.enum(contract.disabledReasons).nullable(),
    href: safeObjectUrlSchema.nullable(),
  }).strict().superRefine((value, context) => {
    if (value.enabled && (!value.href || value.disabledReasonCode)) context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_enabled_action" });
    if (!value.enabled && (value.href || !value.disabledReasonCode)) context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_disabled_action" });
  });
  const base = z.object({
    schemaVersion: z.literal(OBJECT_CONTRACT_SCHEMA_VERSION),
    objectType: z.literal(objectType),
    projectionTier: z.enum(OBJECT_PROJECTION_TIERS),
    object: z.object({ id: objectIdSchema, title: boundedText(300), canonicalUrl: safeObjectUrlSchema, version: isoSchema, updatedAt: isoSchema }).strict(),
    status: z.object({ code: z.enum(contract.statuses), label: boundedText(120), tone: toneSchema, reasonCode: z.enum(contract.statusReasons).nullable() }).strict(),
    relationship,
    permissions: z.array(z.enum(contract.permissions)).max(contract.permissions.length).refine((values) => new Set(values).size === values.length, "duplicate_permission"),
    actions: z.array(action).max(6).refine((values) => new Set(values.map((item) => item.code)).size === values.length, "duplicate_action"),
    links: z.object({ self: safeObjectUrlSchema }).strict(),
    freshness: z.object({ state: z.literal("current"), projectedAt: isoSchema, sourceUpdatedAt: isoSchema, staleAfter: nullableIsoSchema }).strict(),
    timelineSummary: TYPE_TIMELINE_SCHEMAS[objectType],
  }).strict();
  return z.discriminatedUnion("projectionTier", OBJECT_PROJECTION_TIERS.map((tier) =>
    base.extend({ projectionTier: z.literal(tier), content: TYPE_TIER_SCHEMAS[objectType][tier] })
  ));
}

const projectionSchema = z.union([
  matterProjectionSchema,
  ...Object.keys(TYPE_CONTRACTS).map(typeProjectionSchema),
]);

const OBJECT_PROJECTION_SHAPES = Object.freeze({
  common: Object.freeze([
    "schemaVersion", "objectType", "projectionTier", "object", "status", "relationship",
    "permissions", "actions", "links", "freshness", "timelineSummary", "content",
  ]),
  tiers: Object.freeze({
    summary: Object.freeze(["practiceArea", "attention", "fundingState", "lastMeaningfulUpdateAt", "primaryActionCode"]),
    detail: Object.freeze(["state", "facts", "tabs"]),
    contextual_panel: Object.freeze(["practiceArea", "summary", "attention", "fundingState", "availableTabs", "primaryActionCode"]),
    search_result: Object.freeze(["subtitle", "attentionCode", "lastMeaningfulUpdateAt"]),
    assistant_context: Object.freeze(["state", "attentionCode", "safeFacts", "proposedActionCodes"]),
  }),
  objectTypes: Object.freeze(Object.fromEntries(
    Object.entries(TYPE_TIER_SCHEMAS).map(([objectType, schemas]) => [
      objectType,
      Object.freeze(Object.keys(schemas)),
    ])
  )),
});

class ObjectContractError extends Error {
  constructor(code, issues = []) {
    super(code);
    this.name = "ObjectContractError";
    this.code = code;
    this.issues = issues;
  }
}

function findUnsafeEvidence(value, path = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findUnsafeEvidence(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      const current = `${path}.${key}`;
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      const findings = UNSAFE_FIELD_PATTERN.test(normalizedKey) ? [current] : [];
      return findings.concat(findUnsafeEvidence(child, current));
    });
  }
  if (typeof value === "string" && UNSAFE_VALUE_PATTERN.test(value)) return [path];
  return [];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function validateObjectProjection(input) {
  const unsafe = findUnsafeEvidence(input);
  if (unsafe.length) throw new ObjectContractError("unsafe_object_evidence", unsafe);
  const result = projectionSchema.safeParse(input);
  if (!result.success) {
    throw new ObjectContractError("invalid_object_projection", result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })));
  }
  const value = result.data;
  const consistencyIssues = [];
  if (value.object.canonicalUrl !== value.links.self) {
    consistencyIssues.push({ path: "links.self", message: "canonical_url_mismatch" });
  }
  if (
    value.object.version !== value.object.updatedAt ||
    value.object.updatedAt !== value.freshness.sourceUpdatedAt
  ) {
    consistencyIssues.push({ path: "freshness.sourceUpdatedAt", message: "object_version_mismatch" });
  }
  if (
    value.timelineSummary.latestVisibleEventAt &&
    Date.parse(value.timelineSummary.latestVisibleEventAt) > Date.parse(value.object.updatedAt)
  ) {
    consistencyIssues.push({ path: "timelineSummary.latestVisibleEventAt", message: "timeline_after_object_version" });
  }
  if (consistencyIssues.length) {
    throw new ObjectContractError("inconsistent_object_projection", consistencyIssues);
  }
  return deepFreeze(value);
}

function safeValidateObjectProjection(input) {
  try {
    return Object.freeze({ valid: true, value: validateObjectProjection(input), errors: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({
      valid: false,
      value: null,
      errors: Object.freeze(error instanceof ObjectContractError ? [error.code, ...error.issues] : ["invalid_object_projection"]),
    });
  }
}

module.exports = {
  FILE_AVAILABILITY_STATES,
  FILE_CATEGORIES,
  FILE_UPLOADER_RELATIONSHIPS,
  FINANCIAL_AMOUNT_CODES,
  FINANCIAL_RECONCILIATION_STATES,
  MATTER_ACTION_CODES,
  MATTER_ASSIGNMENT_CODES,
  MATTER_ATTENTION_CODES,
  MATTER_DISABLED_REASON_CODES,
  MATTER_FUNDING_CODES,
  MATTER_LIFECYCLE_CODES,
  MATTER_PERMISSION_CODES,
  MATTER_RELATIONSHIPS,
  MATTER_STATUS_CODES,
  MATTER_WORKSPACE_CODES,
  MESSAGE_AUTHOR_RELATIONSHIPS,
  OBJECT_CONTRACT_SCHEMA_VERSION,
  OBJECT_PROJECTION_SHAPES,
  OBJECT_PROJECTION_TIERS,
  OBJECT_TYPES,
  ObjectContractError,
  PRESENTATION_TONES,
  TYPE_CONTRACTS,
  safeValidateObjectProjection,
  validateObjectProjection,
};
