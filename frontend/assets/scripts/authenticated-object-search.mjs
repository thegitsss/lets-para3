const PRESENTATION_OBJECT_TYPES = new Set(["matter", "profile", "application", "invitation", "assignment", "file", "message", "financial_summary", "conversation"]);
const STATUS_TONES = new Set(["neutral", "info", "success", "warning", "danger"]);
const MATTER_TABS = new Set(["overview", "applications", "work", "files", "messages", "activity", "financials"]);
const MATTER_ATTENTION_CODES = new Set(["none", "attorney_action", "paralegal_action", "payment_attention", "administrative_review"]);
const PRESENTATION_POLICY_BY_TYPE = Object.freeze({
  matter: Object.freeze({
    statuses: Object.freeze(["archived", "under_administrative_review", "under_dispute_review", "withdrawal_review", "relisted_replacement_selection", "paused", "closed", "completed_release_pending", "completed_payment_released", "in_progress", "funding_required", "selection_in_progress", "open_for_applications"]),
    relationships: Object.freeze(["owner_attorney", "assigned_paralegal", "candidate_paralegal", "withdrawn_paralegal", "admin"]),
    actions: Object.freeze(["complete_preengagement", "complete_and_release", "continue_selection", "continue_work", "download_archive", "inspect_matter", "invite_paralegal", "open_messages", "respond_invitation", "resolve_withdrawal", "review_applications", "review_preengagement", "select_replacement", "verify_replacement_funding", "view_application", "view_applications", "view_files", "view_financials", "view_matter", "view_payout", "view_review_status"]),
  }),
  profile: Object.freeze({ statuses: Object.freeze(["active", "pending_approval", "denied", "hidden", "unavailable"]), relationships: Object.freeze(["self", "public", "relationship", "administrator", "assistant_context"]), actions: Object.freeze(["view_profile"]) }),
  application: Object.freeze({ statuses: Object.freeze(["pending", "submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn", "declined", "expired"]), relationships: Object.freeze(["owner_attorney", "candidate_paralegal", "admin"]), actions: Object.freeze(["review_candidate", "view_application", "respond_application"]) }),
  invitation: Object.freeze({ statuses: Object.freeze(["pending", "accepted", "declined", "revoked", "expired", "superseded"]), relationships: Object.freeze(["inviter_attorney", "invited_paralegal", "admin"]), actions: Object.freeze(["respond_invitation", "view_invitation"]) }),
  assignment: Object.freeze({ statuses: Object.freeze(["assigned", "replacement_pending", "pending_funding", "active", "withdrawal_pending", "withdrawn", "replaced", "completed", "revoked", "cancelled"]), relationships: Object.freeze(["owner_attorney", "assigned_paralegal", "withdrawn_paralegal", "admin"]), actions: Object.freeze(["view_assignment", "view_payout"]) }),
  financial_summary: Object.freeze({ statuses: Object.freeze(["funded", "funding_pending", "verification_required", "reconciling", "held", "disputed", "partially_refunded", "refunded", "release_pending", "released", "payout_pending", "administratively_blocked"]), relationships: Object.freeze(["owner_attorney", "assigned_paralegal", "withdrawn_paralegal", "admin"]), actions: Object.freeze(["download_receipt"]) }),
  file: Object.freeze({ statuses: Object.freeze(["pending_review", "approved", "attorney_revision", "unavailable"]), relationships: Object.freeze(["owner_attorney", "assigned_paralegal", "admin"]), actions: Object.freeze(["download_file", "view_file"]) }),
  message: Object.freeze({ statuses: Object.freeze(["sent"]), relationships: Object.freeze(["owner_attorney", "assigned_paralegal"]), actions: Object.freeze(["view_message"]) }),
  conversation: Object.freeze({ statuses: Object.freeze(["active", "read_only"]), relationships: Object.freeze(["owner_attorney", "assigned_paralegal"]), actions: Object.freeze(["view_conversation"]) }),
});
const UNSAFE_PRESENTATION_VALUE = /(?:^|\b)(?:pi|ch|tr|acct|pm|seti|cus|src|tok)_[a-z0-9_]+/i;

function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function iso(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safePresentationHref(value, origin, objectType, objectId, { canonicalUrl = null, actionCode = null } = {}) {
  const href = boundedText(value, 900);
  if (!href || href.startsWith("//") || href.includes("\\")) return null;
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.hash) return null;
    const entries = [...url.searchParams.entries()];
    if (actionCode && ["view_application", "review_candidate", "view_invitation", "respond_invitation", "view_assignment", "view_file", "view_message"].includes(actionCode)) {
      return href === canonicalUrl ? href : null;
    }
    if (objectType === "file" && actionCode === "download_file") {
      const canonical = new URL(canonicalUrl, origin);
      const matterId = canonical.searchParams.get("caseId");
      return url.pathname === `/api/uploads/case/${matterId}/${objectId}/download` && entries.length === 0 ? href : null;
    }
    if (objectType === "assignment" && actionCode === "view_payout") {
      const canonical = new URL(canonicalUrl, origin);
      return url.pathname === "/case-detail.html" && entries.length === 2 &&
        url.searchParams.get("caseId") === canonical.searchParams.get("caseId") &&
        url.searchParams.get("tab") === "financials" ? href : null;
    }
    if (objectType === "financial_summary" && actionCode === "download_receipt") {
      const canonical = new URL(canonicalUrl, origin);
      const matterId = canonical.searchParams.get("caseId");
      const match = url.pathname.match(/^\/api\/payments\/receipt\/(attorney|paralegal)\/([^/]+)$/);
      return match && entries.length === 0 && decodeURIComponent(match[2]) === matterId ? href : null;
    }
    if (objectType === "conversation" && actionCode === "view_conversation") return href === canonicalUrl ? href : null;
    if (actionCode && ["file", "message"].includes(objectType)) return null;
    if (objectType === "matter") {
      if (url.pathname !== "/case-detail.html" || entries.length !== 2 ||
          url.searchParams.get("caseId") !== objectId || !MATTER_TABS.has(url.searchParams.get("tab"))) return null;
    } else if (objectType === "profile") {
      const isParalegal = url.pathname === "/profile-paralegal.html" && entries.length === 1 && url.searchParams.get("paralegalId") === objectId;
      const isAttorney = url.pathname === "/profile-attorney.html" && entries.length === 1 && url.searchParams.get("id") === objectId;
      if (!isParalegal && !isAttorney) return null;
    } else if (["financial_summary", "conversation"].includes(objectType)) {
      const tab = objectType === "financial_summary" ? "financials" : "messages";
      if (url.pathname !== "/case-detail.html" || entries.length !== 2 ||
          !/^[a-f0-9]{24}$/i.test(url.searchParams.get("caseId") || "") || url.searchParams.get("tab") !== tab) return null;
    } else if (["application", "invitation", "assignment", "file", "message"].includes(objectType)) {
      const anchor = objectType;
      const tab = ["application", "invitation"].includes(objectType) ? "applications"
        : objectType === "assignment" ? "overview"
          : objectType === "file" ? "files" : "messages";
      if (url.pathname !== "/case-detail.html" || entries.length !== 3 ||
          !/^[a-f0-9]{24}$/i.test(url.searchParams.get("caseId") || "") ||
          url.searchParams.get("tab") !== tab || url.searchParams.get(anchor) !== objectId) return null;
    } else return null;
    return href;
  } catch {
    return null;
  }
}

export function normalizePresentation(value, origin, { expectedKind, expectedType = null, expectedId = null, expectedMatterId = null } = {}) {
  if (UNSAFE_PRESENTATION_VALUE.test(JSON.stringify(value || {}))) return null;
  if (!exactKeys(value, ["schemaVersion", "source", "kind", "objectType", "object", "status", "attention", "relationship", "readOnly", "actions", "details", "summary", "freshness", "links"]) ||
      value.schemaVersion !== 1 || value.source !== "server_projection" || value.kind !== expectedKind ||
      !PRESENTATION_OBJECT_TYPES.has(value.objectType) || (expectedType && value.objectType !== expectedType)) return null;
  const policy = PRESENTATION_POLICY_BY_TYPE[value.objectType];
  if (!policy) return null;
  if (!exactKeys(value.object, ["id", "title", "canonicalUrl", "version"]) || !/^[a-f0-9]{24}$/i.test(value.object.id || "") ||
      (expectedId && value.object.id !== expectedId) || !boundedText(value.object.title, 300) || !iso(value.object.version)) return null;
  const canonicalUrl = safePresentationHref(value.object.canonicalUrl, origin, value.objectType, value.object.id);
  if (!canonicalUrl || !exactKeys(value.links, ["self"]) || value.links.self !== canonicalUrl) return null;
  if (expectedMatterId && new URL(canonicalUrl, origin).searchParams.get("caseId") !== expectedMatterId) return null;
  const status = value.status;
  if (!exactKeys(status, ["code", "label", "tone"]) || !policy.statuses.includes(status.code) ||
      !boundedText(status.label, 140) || !STATUS_TONES.has(status.tone)) return null;
  if (value.attention !== null && (!exactKeys(value.attention, ["code", "label", "tone"]) ||
      value.objectType !== "matter" || !MATTER_ATTENTION_CODES.has(value.attention.code) || !boundedText(value.attention.label, 180) || !STATUS_TONES.has(value.attention.tone))) return null;
  if (!exactKeys(value.relationship, ["code", "label"]) || !policy.relationships.includes(value.relationship.code) ||
      !boundedText(value.relationship.label, 180) || typeof value.readOnly !== "boolean") return null;
  if (!Array.isArray(value.actions) || value.actions.length > 6 || value.actions.some((action) =>
    !exactKeys(action, ["code", "label", "enabled", "disabledReason", "href"]) || !policy.actions.includes(action.code) ||
    !boundedText(action.label, 140) || typeof action.enabled !== "boolean" ||
    (action.enabled ? !safePresentationHref(action.href, origin, value.objectType, value.object.id, { canonicalUrl, actionCode: action.code }) || action.disabledReason !== null : action.href !== null || !boundedText(action.disabledReason, 260)))) return null;
  if (value.readOnly !== !value.actions.some((action) => action.enabled)) return null;
  if (!Array.isArray(value.details) || value.details.length > 8 || value.details.some((detail) =>
    !exactKeys(detail, ["label", "value"]) || !boundedText(detail.label, 80) || !boundedText(detail.value, 500))) return null;
  if (value.summary !== null && !boundedText(value.summary, 800)) return null;
  if (!exactKeys(value.freshness, ["state", "sourceUpdatedAt", "projectedAt"]) || value.freshness.state !== "current" ||
      !iso(value.freshness.sourceUpdatedAt) || !iso(value.freshness.projectedAt) || value.freshness.sourceUpdatedAt !== value.object.version) return null;
  return Object.freeze(value);
}

export const PRESENTATION_BROWSER_POLICY = PRESENTATION_POLICY_BY_TYPE;
