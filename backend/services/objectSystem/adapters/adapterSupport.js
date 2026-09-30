const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  OBJECT_CONTRACT_SCHEMA_VERSION,
  OBJECT_PROJECTION_TIERS,
  validateObjectProjection,
} = require("../objectContract");

class ObjectAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "ObjectAdapterError";
    this.code = code;
  }
}

function objectId(value, code = "invalid_object_id") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!mongoose.isValidObjectId(normalized) || !/^[a-f0-9]{24}$/.test(normalized)) {
    throw new ObjectAdapterError(code);
  }
  return normalized;
}

function iso(value, code = "invalid_timestamp") {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) throw new ObjectAdapterError(code);
  return date.toISOString();
}

function nullableIso(value, code = "invalid_timestamp") {
  return value == null || value === "" ? null : iso(value, code);
}

function compatibilityId(namespace, parts) {
  const values = Array.isArray(parts) ? parts : [parts];
  if (!namespace || values.some((value) => value == null || String(value).trim() === "")) {
    throw new ObjectAdapterError("compatibility_identity_evidence_required");
  }
  return crypto.createHash("sha256")
    .update([namespace, ...values.map(String)].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

function text(value, { maximum = 300, fallback = null } = {}) {
  const normalized = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
    : "";
  if (!normalized) {
    if (fallback != null) return String(fallback).slice(0, maximum);
    throw new ObjectAdapterError("required_text_unavailable");
  }
  return normalized.slice(0, maximum);
}

function optionalText(value, maximum = 300) {
  if (value == null || value === "") return null;
  return text(value, { maximum });
}

function assertTier(projectionTier) {
  if (!OBJECT_PROJECTION_TIERS.includes(projectionTier)) {
    throw new ObjectAdapterError("unknown_projection_tier");
  }
  return projectionTier;
}

function assertAuthorizedProjection(projection, { schemaVersion = 1, relationships, code = "authorized_projection_required" } = {}) {
  if (!projection || projection.schemaVersion !== schemaVersion) throw new ObjectAdapterError(code);
  const relationship = String(projection.viewerRelationship || "");
  if (!relationships.includes(relationship)) throw new ObjectAdapterError("object_not_authorized");
  return relationship;
}

function assertFreshSource(sourceUpdatedAt, expectedSourceUpdatedAt) {
  if (!expectedSourceUpdatedAt) throw new ObjectAdapterError("source_version_required");
  const source = iso(sourceUpdatedAt, "source_freshness_unavailable");
  const expected = iso(expectedSourceUpdatedAt, "expected_source_version_invalid");
  if (source !== expected) throw new ObjectAdapterError("stale_object_evidence");
  return source;
}

function action({ code, labelCode, targetTab = null, enabled, reasonCode, href }) {
  const allowed = enabled === true;
  return {
    code,
    labelCode,
    targetTab,
    enabled: allowed,
    disabledReasonCode: allowed ? null : reasonCode || "action_unavailable",
    href: allowed ? href || null : null,
  };
}

function projectEnvelope({
  objectType,
  projectionTier,
  id,
  title,
  canonicalUrl,
  status,
  relationship,
  permissions = [],
  actions = [],
  sourceUpdatedAt,
  now = new Date(),
  timelineSummary = null,
  content,
}) {
  assertTier(projectionTier);
  const updatedAt = iso(sourceUpdatedAt, "source_freshness_unavailable");
  return validateObjectProjection({
    schemaVersion: OBJECT_CONTRACT_SCHEMA_VERSION,
    objectType,
    projectionTier,
    object: {
      id: objectId(id),
      title: text(title),
      canonicalUrl,
      version: updatedAt,
      updatedAt,
    },
    status,
    relationship: { code: relationship, candidateKind: null },
    permissions,
    actions,
    links: { self: canonicalUrl },
    freshness: {
      state: "current",
      projectedAt: iso(now, "projection_time_unavailable"),
      sourceUpdatedAt: updatedAt,
      staleAfter: null,
    },
    timelineSummary: timelineSummary || { latestVisibleEventAt: null, visibleEventCount: null },
    content,
  });
}

module.exports = {
  ObjectAdapterError,
  action,
  assertAuthorizedProjection,
  assertFreshSource,
  assertTier,
  compatibilityId,
  iso,
  nullableIso,
  objectId,
  optionalText,
  projectEnvelope,
  text,
};
