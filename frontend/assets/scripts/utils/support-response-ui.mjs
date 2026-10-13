const SUPPORTED_ESCALATION_REASONS = new Set([
  "request_human_help",
  "payment_released_bank_timing_unconfirmed",
  "payout_finalized_without_release_record",
  "stripe_ready_but_user_reports_blocker",
  "workspace_access_needs_review",
  "messaging_should_be_available",
  "case_requires_review",
  "interaction_responsiveness_review",
]);

export function isManagerResponse(metadata = {}) {
  return String(metadata?.provider || "").trim().toLowerCase().startsWith("openai_manager");
}

export function getAssistantActionLimit(metadata = {}) {
  return isManagerResponse(metadata) ? 1 : 2;
}

export function getAssistantSuggestionLimit(metadata = {}) {
  return isManagerResponse(metadata) ? 2 : 3;
}

export function isSupportedEscalationMetadata(metadata = {}) {
  const escalation = metadata?.escalation && typeof metadata.escalation === "object"
    ? metadata.escalation
    : {};
  if (escalation.requested === true) return true;
  const available = escalation.available === true || metadata?.needsEscalation === true;
  if (!available) return false;
  // Package 4 hardens only the attorney manager response contract. Preserve
  // established paralegal/admin card behavior until their replication packages.
  if (!isManagerResponse(metadata)) return true;
  const reason = String(
    escalation.reason || escalation.escalationReason || metadata?.escalationReason || metadata?.primaryAsk || ""
  ).trim().toLowerCase();
  return SUPPORTED_ESCALATION_REASONS.has(reason);
}
