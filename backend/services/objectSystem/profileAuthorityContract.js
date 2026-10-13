const { z } = require("zod");

const {
  evaluateAttorneyAccountReadiness,
  evaluateParalegalApplicationReadiness,
  evaluateParalegalPublicSearchReadiness,
} = require("../readinessPolicy");
const { projectProfileObject } = require("./adapters/profileObjectAdapter");

const PROFILE_AUTHORITY_SCHEMA_VERSION = 1;
const PROFILE_TIERS = Object.freeze([
  "self",
  "public",
  "public_detail",
  "relationship",
  "administrator",
  "search_result",
  "contextual_panel",
  "assistant_context",
]);
const PROFILE_BOUNDARIES = Object.freeze([
  "self",
  "public",
  "relationship",
  "administrator",
  "assistant_context",
]);
const PROFILE_TIER_POLICY = Object.freeze({
  self: Object.freeze({ boundary: "self", projectionTier: "detail" }),
  public: Object.freeze({ boundary: "public", projectionTier: "summary" }),
  public_detail: Object.freeze({ boundary: "public", projectionTier: "detail" }),
  relationship: Object.freeze({ boundary: "relationship", projectionTier: "contextual_panel" }),
  administrator: Object.freeze({ boundary: "administrator", projectionTier: "detail" }),
  search_result: Object.freeze({ boundary: "public", projectionTier: "search_result" }),
  contextual_panel: Object.freeze({ boundary: "relationship", projectionTier: "contextual_panel" }),
  assistant_context: Object.freeze({ boundary: "assistant_context", projectionTier: "assistant_context" }),
});
const PROFILE_SOURCE_FIELDS = Object.freeze([
  "_id",
  "role",
  "firstName",
  "lastName",
  "location",
  "state",
  "bio",
  "about",
  "practiceAreas",
  "specialties",
  "skills",
  "yearsExperience",
  "availability",
  "status",
  "disabled",
  "deleted",
  "preferences.hideProfile",
  "email",
  "emailVerified",
  "termsAccepted",
  "attorneyPricingAccepted",
  "barNumber",
  "barState",
  "resumeURL",
  "profileImage",
  "avatarURL",
  "profilePhotoStatus",
  "pendingProfileImage",
  "updatedAt",
]);
const PROFILE_SOURCE_SELECT = PROFILE_SOURCE_FIELDS.join(" ");
const PROFILE_OUTPUT_ALLOWLISTS = Object.freeze({
  self: Object.freeze(["role", "name", "location", "summary", "practiceAreas", "specialties", "yearsExperience", "availability", "stateAxes"]),
  public: Object.freeze(["role", "location", "practiceAreas"]),
  public_detail: Object.freeze(["role", "name", "location", "summary", "practiceAreas", "specialties", "yearsExperience", "availability", "stateAxes"]),
  relationship: Object.freeze(["role", "location", "summary", "practiceAreas"]),
  administrator: Object.freeze(["role", "name", "location", "summary", "practiceAreas", "specialties", "yearsExperience", "availability", "stateAxes"]),
  search_result: Object.freeze(["role", "subtitle", "practiceAreas"]),
  contextual_panel: Object.freeze(["role", "location", "summary", "practiceAreas"]),
  assistant_context: Object.freeze(["role", "location", "practiceAreas", "availability", "stateAxes", "proposedActionCodes"]),
});
const PRIVATE_PROFILE_KEY_PATTERN = /(?:^|_)(?:email|phone|password|credential|provider|auth|token|secret|security|notification|preference|bank|stripe|payment|moderation|audit|resume|certificate|document|storage|encryption|idempotency|lease|fingerprint|internal|blocked)(?:_|$)/i;

const sourceSchema = z.object({
  _id: z.custom((value) => /^[a-f0-9]{24}$/i.test(String(value || ""))),
  role: z.enum(["attorney", "paralegal"]),
  firstName: z.string().max(160).optional().nullable(),
  lastName: z.string().max(160).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  state: z.string().max(120).optional().nullable(),
  bio: z.string().max(20_000).optional().nullable(),
  about: z.string().max(20_000).optional().nullable(),
  practiceAreas: z.array(z.string().max(160)).max(50).optional(),
  specialties: z.array(z.string().max(160)).max(50).optional(),
  skills: z.array(z.string().max(160)).max(50).optional(),
  yearsExperience: z.number().int().min(0).max(80).optional().nullable(),
  availability: z.union([z.string().max(200), z.boolean()]).optional().nullable(),
  status: z.string().max(40).optional().nullable(),
  disabled: z.boolean().optional(),
  deleted: z.boolean().optional(),
  preferences: z.object({ hideProfile: z.boolean().optional() }).passthrough().optional(),
  email: z.string().max(320).optional().nullable(),
  emailVerified: z.boolean().optional(),
  termsAccepted: z.boolean().optional(),
  attorneyPricingAccepted: z.boolean().optional(),
  barNumber: z.string().max(160).optional().nullable(),
  barState: z.string().max(120).optional().nullable(),
  resumeURL: z.string().max(2000).optional().nullable(),
  profileImage: z.unknown().optional(),
  avatarURL: z.string().max(2000).optional().nullable(),
  profilePhotoStatus: z.string().max(40).optional().nullable(),
  pendingProfileImage: z.string().max(2000).optional().nullable(),
  updatedAt: z.union([z.date(), z.string().datetime({ offset: true })]),
}).strict();

class ProfileAuthorityContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProfileAuthorityContractError";
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function cleanText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function cleanList(value, maximum = 12) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => cleanText(entry, 160)).filter(Boolean))].slice(0, maximum);
}

function normalizeApproval(source) {
  if (source.disabled === true || source.deleted === true) return "denied";
  const status = String(source.status || "").toLowerCase();
  if (status === "approved") return "approved";
  if (["pending", "pending_approval"].includes(status)) return "pending";
  if (["rejected", "denied", "disabled", "deleted"].includes(status)) return "denied";
  return "unknown";
}

function normalizeAvailability(value) {
  if (value === true) return "available";
  if (value === false) return "unavailable";
  const normalized = String(value || "").trim().toLowerCase();
  if (["available", "yes", "open", "immediately"].includes(normalized)) return "available";
  if (["unavailable", "no", "not available"].includes(normalized)) return "unavailable";
  return "unknown";
}

function readinessFor(source, boundary) {
  if (source.role === "attorney") return evaluateAttorneyAccountReadiness(source).ready ? "ready" : "needs_attention";
  const result = boundary === "public"
    ? evaluateParalegalPublicSearchReadiness(source)
    : evaluateParalegalApplicationReadiness(source);
  return result.ready ? "ready" : "needs_attention";
}

function normalizeSource(rawSource, boundary) {
  const plain = rawSource?.toObject ? rawSource.toObject({ depopulate: true, getters: false, virtuals: false }) : rawSource;
  const parsed = sourceSchema.safeParse(plain);
  if (!parsed.success) throw new ProfileAuthorityContractError("profile_source_invalid");
  const source = parsed.data;
  const id = String(source._id).toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(id)) throw new ProfileAuthorityContractError("profile_identity_invalid");
  const approval = normalizeApproval(source);
  const visibility = source.preferences?.hideProfile === true ? "hidden" : approval === "approved" ? "visible" : "unknown";
  return deepFreeze({
    schemaVersion: PROFILE_AUTHORITY_SCHEMA_VERSION,
    id,
    role: source.role,
    firstName: cleanText(source.firstName, 160),
    lastName: cleanText(source.lastName, 160),
    location: cleanText(source.location || source.state, 200),
    summary: cleanText(source.bio || source.about, 4000),
    practiceAreas: cleanList(source.practiceAreas),
    specialties: cleanList(source.specialties?.length ? source.specialties : source.skills),
    yearsExperience: Number.isInteger(source.yearsExperience) ? source.yearsExperience : null,
    availability: typeof source.availability === "string" ? cleanText(source.availability, 200) : null,
    stateAxes: {
      approval,
      visibility,
      availability: normalizeAvailability(source.availability),
      readiness: readinessFor(source, boundary),
      // Payout configuration is owned by financial services and is never inferred here.
      payoutReadiness: source.role === "attorney" ? "not_applicable" : "unknown",
    },
    updatedAt: new Date(source.updatedAt).toISOString(),
  });
}

function authorizationEvidenceFor(tier, evidence) {
  const policy = PROFILE_TIER_POLICY[tier];
  if (!policy || !evidence || evidence.authorized !== true || evidence.boundary !== policy.boundary) {
    throw new ProfileAuthorityContractError("profile_tier_not_authorized");
  }
  const exact = { authorized: true, boundary: policy.boundary };
  if (policy.boundary === "self") exact.selfVerified = evidence.selfVerified === true;
  if (policy.boundary === "public") exact.publicVisibilityVerified = evidence.publicVisibilityVerified === true;
  if (policy.boundary === "relationship") exact.relationshipVerified = evidence.relationshipVerified === true;
  if (policy.boundary === "administrator") exact.administratorVerified = evidence.administratorVerified === true;
  if (policy.boundary === "assistant_context") exact.contextAuthorized = evidence.contextAuthorized === true;
  if (!Object.values(exact).every((value) => value === true || PROFILE_BOUNDARIES.includes(value))) {
    throw new ProfileAuthorityContractError("profile_tier_not_authorized");
  }
  return exact;
}

function assertTierOutput(tier, projection) {
  const allowed = PROFILE_OUTPUT_ALLOWLISTS[tier];
  if (!allowed) throw new ProfileAuthorityContractError("profile_tier_unknown");
  const keys = Object.keys(projection.content || {});
  if (keys.some((key) => !allowed.includes(key))) throw new ProfileAuthorityContractError("profile_tier_overexposed");
  const serialized = JSON.stringify(projection);
  if (PRIVATE_PROFILE_KEY_PATTERN.test(serialized)) throw new ProfileAuthorityContractError("private_profile_evidence_exposed");
  return projection;
}

function projectCanonicalProfile({ source, tier, authorizationEvidence, expectedSourceUpdatedAt, now = new Date() } = {}) {
  if (!PROFILE_TIERS.includes(tier)) throw new ProfileAuthorityContractError("profile_tier_unknown");
  const policy = PROFILE_TIER_POLICY[tier];
  const authorized = authorizationEvidenceFor(tier, authorizationEvidence);
  const profileProjection = normalizeSource(source, policy.boundary);
  if (policy.boundary === "public" && (
    profileProjection.stateAxes.approval !== "approved" ||
    profileProjection.stateAxes.visibility !== "visible" ||
    profileProjection.stateAxes.readiness !== "ready"
  )) throw new ProfileAuthorityContractError("public_profile_not_eligible");
  const projection = projectProfileObject({
    profileProjection,
    authorizationEvidence: authorized,
    expectedSourceUpdatedAt,
    projectionTier: policy.projectionTier,
    now,
  });
  return assertTierOutput(tier, projection);
}

module.exports = Object.freeze({
  PRIVATE_PROFILE_KEY_PATTERN,
  PROFILE_AUTHORITY_SCHEMA_VERSION,
  PROFILE_BOUNDARIES,
  PROFILE_OUTPUT_ALLOWLISTS,
  PROFILE_SOURCE_FIELDS,
  PROFILE_SOURCE_SELECT,
  PROFILE_TIERS,
  PROFILE_TIER_POLICY,
  ProfileAuthorityContractError,
  normalizeSource,
  projectCanonicalProfile,
});
