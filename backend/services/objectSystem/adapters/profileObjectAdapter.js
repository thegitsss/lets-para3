const { buildProfileUrl } = require("../objectUrlPolicy");
const {
  action,
  assertFreshSource,
  iso,
  objectId,
  optionalText,
  projectEnvelope,
  text,
} = require("./adapterSupport");

const BOUNDARIES = new Set(["self", "public", "relationship", "administrator", "assistant_context"]);
const APPROVAL = new Set(["approved", "pending", "denied", "unknown"]);
const VISIBILITY = new Set(["visible", "hidden", "self_only", "unknown"]);
const AVAILABILITY = new Set(["available", "unavailable", "unknown"]);
const READINESS = new Set(["ready", "needs_attention", "unknown"]);
const PAYOUT = new Set(["ready", "not_ready", "not_applicable", "unknown"]);
const ALLOWED_PROFILE_KEYS = new Set([
  "schemaVersion", "id", "role", "firstName", "lastName", "location", "summary", "practiceAreas",
  "specialties", "yearsExperience", "availability", "stateAxes", "updatedAt",
]);

function safeList(value, maximum = 12) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => optionalText(entry, 160)).filter(Boolean))].slice(0, maximum);
}

function assertProfileInput(profile, authorizationEvidence, projectionTier) {
  if (!profile || profile.schemaVersion !== 1) throw new Error("authorized_profile_projection_required");
  const unknown = Object.keys(profile).filter((key) => !ALLOWED_PROFILE_KEYS.has(key));
  if (unknown.length) throw new Error("unsafe_profile_projection");
  if (!authorizationEvidence || authorizationEvidence.authorized !== true || !BOUNDARIES.has(authorizationEvidence.boundary)) {
    throw new Error("profile_not_authorized");
  }
  const boundary = authorizationEvidence.boundary;
  if (projectionTier === "assistant_context" && boundary !== "assistant_context") throw new Error("assistant_profile_context_required");
  if (projectionTier !== "assistant_context" && boundary === "assistant_context") throw new Error("profile_tier_boundary_mismatch");
  if (boundary === "public" && authorizationEvidence.publicVisibilityVerified !== true) throw new Error("public_profile_visibility_unverified");
  if (boundary === "relationship" && authorizationEvidence.relationshipVerified !== true) throw new Error("profile_relationship_unverified");
  if (boundary === "administrator" && authorizationEvidence.administratorVerified !== true) throw new Error("profile_administrator_unverified");
  if (boundary === "self" && authorizationEvidence.selfVerified !== true) throw new Error("profile_self_unverified");
  if (boundary === "assistant_context" && authorizationEvidence.contextAuthorized !== true) throw new Error("profile_assistant_context_unverified");
  return boundary;
}

function stateAxes(profile) {
  const axes = profile.stateAxes || {};
  if (!APPROVAL.has(axes.approval) || !VISIBILITY.has(axes.visibility) || !AVAILABILITY.has(axes.availability) ||
      !READINESS.has(axes.readiness) || !PAYOUT.has(axes.payoutReadiness)) {
    throw new Error("profile_state_unavailable");
  }
  return {
    approval: axes.approval,
    visibility: axes.visibility,
    availability: axes.availability,
    readiness: axes.readiness,
    payoutReadiness: axes.payoutReadiness,
  };
}

function projectProfileObject({ profileProjection, authorizationEvidence, expectedSourceUpdatedAt, projectionTier = "summary", now = new Date() } = {}) {
  const boundary = assertProfileInput(profileProjection, authorizationEvidence, projectionTier);
  assertFreshSource(profileProjection.updatedAt, expectedSourceUpdatedAt);
  const id = objectId(profileProjection.id, "invalid_profile_id");
  const role = String(profileProjection.role || "").toLowerCase();
  if (!['attorney', 'paralegal'].includes(role)) throw new Error("profile_role_unavailable");
  const axes = stateAxes(profileProjection);
  if (boundary === "public" && (axes.approval !== "approved" || axes.visibility !== "visible")) throw new Error("profile_not_visible");
  const name = text([profileProjection.firstName, profileProjection.lastName].filter(Boolean).join(" "), { fallback: role === "attorney" ? "Attorney" : "Paralegal", maximum: 160 });
  const canonicalUrl = buildProfileUrl({ profileId: id, role });
  const statusCode = axes.approval === "pending" ? "pending_approval"
    : axes.approval === "denied" ? "denied"
      : ["hidden", "self_only"].includes(axes.visibility) ? "hidden"
        : axes.approval === "approved" ? "active" : "unavailable";
  const statusPresentation = {
    active: ["Active", "success"], pending_approval: ["Pending approval", "warning"], denied: ["Unavailable", "danger"],
    hidden: ["Private", "neutral"], unavailable: ["Unavailable", "neutral"],
  }[statusCode];
  const relationship = boundary;
  const permissions = boundary === "administrator"
    ? ["viewProfile", "viewAdministrativeProfileSummary"]
    : boundary === "relationship" ? ["viewProfile", "viewRelationshipProfile"] : ["viewProfile"];
  const actions = [action({ code: "view_profile", labelCode: "profile_action_view_profile", enabled: true, href: canonicalUrl })];
  const practiceAreas = safeList(profileProjection.practiceAreas);
  const specialties = safeList(profileProjection.specialties);
  const location = optionalText(profileProjection.location, 200);
  const summary = optionalText(profileProjection.summary, 4000);
  let content;
  if (projectionTier === "summary") content = { role, location, practiceAreas };
  else if (projectionTier === "detail") content = {
    role, name, location, summary, practiceAreas, specialties,
    yearsExperience: Number.isInteger(profileProjection.yearsExperience) && profileProjection.yearsExperience >= 0 && profileProjection.yearsExperience <= 80 ? profileProjection.yearsExperience : null,
    availability: optionalText(profileProjection.availability, 200), stateAxes: axes,
  };
  else if (projectionTier === "contextual_panel") content = { role, location, summary: summary?.slice(0, 500) || null, practiceAreas: practiceAreas.slice(0, 6) };
  else if (projectionTier === "search_result") content = { role, subtitle: location, practiceAreas: practiceAreas.slice(0, 6) };
  else content = { role, location, practiceAreas, availability: optionalText(profileProjection.availability, 200), stateAxes: axes, proposedActionCodes: ["view_profile"] };
  return projectEnvelope({
    objectType: "profile", projectionTier, id, title: name, canonicalUrl,
    status: { code: statusCode, label: statusPresentation[0], tone: statusPresentation[1], reasonCode: null },
    relationship, permissions, actions, sourceUpdatedAt: iso(profileProjection.updatedAt), now, content,
  });
}

module.exports = Object.freeze({ objectType: "profile", project: projectProfileObject, projectProfileObject });
