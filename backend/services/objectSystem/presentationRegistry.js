const PRESENTATION_SCHEMA_VERSION = 1;

const PRESENTABLE_OBJECT_REGISTRY = Object.freeze({
  matter: Object.freeze({ identity: "canonical", ownerService: "matter_workspace", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: true }),
  profile: Object.freeze({ identity: "canonical", ownerService: "profile_services", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
  application: Object.freeze({ identity: "canonical_only", ownerService: "application_authority", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
  invitation: Object.freeze({ identity: "canonical_only", ownerService: "invitation_authority", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
  assignment: Object.freeze({ identity: "canonical_only", ownerService: "assignment_authority", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
  file: Object.freeze({ identity: "canonical_only", ownerService: "case_file_services", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
  message: Object.freeze({ identity: "canonical", ownerService: "message_services", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
  financial_summary: Object.freeze({ identity: "matter_scoped_singleton", ownerService: "matter_workspace_financials", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
  conversation: Object.freeze({ identity: "matter_scoped_singleton", ownerService: "matter_workspace_messages", tiers: Object.freeze(["summary", "detail", "contextual_panel", "assistant_context"]), panelProof: false }),
});

const EXCLUDED_PRESENTATION_OBJECTS = Object.freeze({});

const COMMAND_REGISTRY = Object.freeze({
  navigate_object: Object.freeze({ capability: "navigate", label: "Open full page", executionPolicy: "client_navigation", consequential: false }),
  refresh_object: Object.freeze({ capability: "refresh", label: "Refresh", executionPolicy: "read_only_server_refresh", consequential: false }),
  explain_object: Object.freeze({ capability: "explain", label: "Explain", executionPolicy: "assistant_proposal_only", consequential: false }),
  draft_note: Object.freeze({ capability: "draft", label: "Draft a note", executionPolicy: "assistant_proposal_only", consequential: false }),
  propose_authorized_action: Object.freeze({ capability: "propose", label: "Propose next action", executionPolicy: "proposal_only", consequential: false }),
});

const ACTION_LABELS = Object.freeze({
  complete_preengagement: "Complete pre-engagement",
  complete_and_release: "Complete and release",
  continue_selection: "Continue selection",
  continue_work: "Continue work",
  download_archive: "Download archive",
  inspect_matter: "Inspect matter",
  invite_paralegal: "Invite paralegal",
  open_messages: "Open messages",
  respond_invitation: "Respond to invitation",
  resolve_withdrawal: "Resolve withdrawal",
  review_applications: "Review applications",
  review_preengagement: "Review pre-engagement",
  select_replacement: "Select replacement",
  verify_replacement_funding: "Verify replacement funding",
  view_application: "View application",
  view_applications: "View applications",
  view_files: "View files",
  view_financials: "View financials",
  view_matter: "View matter",
  view_payout: "View payout",
  view_review_status: "View review status",
  review_candidate: "Review candidate",
  respond_application: "Respond to application",
  view_profile: "View profile",
  download_file: "Download file",
  view_file: "View file",
  view_message: "View message",
  view_invitation: "View invitation",
  view_assignment: "View assignment",
  download_receipt: "Download receipt",
  view_conversation: "View conversation",
});

const DISABLED_REASON_LABELS = Object.freeze({
  action_unavailable: "This action is currently unavailable.",
  attorney_ownership_required: "Only the matter owner can take this action.",
  hire_required: "A funded engagement is required.",
  incomplete_scope_tasks: "Complete the required scope tasks first.",
  payout_already_finalized: "The payout is already finalized.",
  scope_task_required: "A required scope task is incomplete.",
  completion_unavailable: "Completion is not available in the current state.",
  verification_required: "Verification is required.",
  verified_funding_required: "Verified funding is required.",
  withdrawal_resolution_unavailable: "Withdrawal resolution is unavailable.",
  withdrawal_state_required: "The matter must be in the withdrawal lifecycle.",
  workspace_not_active: "The workspace is not active.",
  application_not_actionable: "The application is not actionable.",
  application_read_only: "The application is read-only.",
  invitation_not_actionable: "The invitation is not actionable.",
  invitation_read_only: "The invitation is read-only.",
  assignment_read_only: "The assignment is read-only.",
  payout_not_available: "Payout information is not available.",
  profile_link_unavailable: "The profile link is unavailable.",
  profile_not_visible: "The profile is not visible.",
  file_not_downloadable: "The file is not downloadable.",
  file_compatibility_only: "The file requires compatibility review.",
  receipt_not_available: "A receipt is not available.",
  financials_read_only: "Financial actions remain in the authorized payment workflow.",
  conversation_read_only: "This conversation is read-only.",
});

const RELATIONSHIP_LABELS = Object.freeze({
  owner_attorney: "Matter owner",
  assigned_paralegal: "Assigned paralegal",
  candidate_paralegal: "Candidate",
  withdrawn_paralegal: "Former assigned paralegal",
  admin: "Administrator",
  self: "You",
  public: "Public profile",
  relationship: "Authorized professional relationship",
  administrator: "Administrator",
  inviter_attorney: "Inviting attorney",
  invited_paralegal: "Invited paralegal",
  assistant_context: "Private Assistant context",
});

const ATTENTION_LABELS = Object.freeze({
  none: "No action needed",
  attorney_action: "Attorney action needed",
  paralegal_action: "Paralegal action needed",
  payment_attention: "Payment attention needed",
  administrative_review: "Administrative review",
});

const FILE_CATEGORY_LABELS = Object.freeze({
  pdf: "PDF",
  image: "Image",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  text: "Text",
  document: "Document",
  other: "File",
});

module.exports = Object.freeze({
  ACTION_LABELS,
  ATTENTION_LABELS,
  COMMAND_REGISTRY,
  DISABLED_REASON_LABELS,
  EXCLUDED_PRESENTATION_OBJECTS,
  FILE_CATEGORY_LABELS,
  PRESENTABLE_OBJECT_REGISTRY,
  PRESENTATION_SCHEMA_VERSION,
  RELATIONSHIP_LABELS,
});
