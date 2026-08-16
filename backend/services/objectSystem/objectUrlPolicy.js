const mongoose = require("mongoose");

const MATTER_WORKSPACE_TABS = Object.freeze([
  "overview",
  "applications",
  "work",
  "files",
  "messages",
  "activity",
  "financials",
]);

const MATTER_DEEP_LINKS = Object.freeze({
  application: Object.freeze({ tab: "applications", parameter: "application" }),
  invitation: Object.freeze({ tab: "applications", parameter: "invitation" }),
  assignment: Object.freeze({ tab: "overview", parameter: "assignment" }),
  file: Object.freeze({ tab: "files", parameter: "file" }),
  message: Object.freeze({ tab: "messages", parameter: "message" }),
  event: Object.freeze({ tab: "activity", parameter: "event" }),
});

const PROFILE_ROLES = Object.freeze(["attorney", "paralegal"]);
const LEGACY_OBJECT_PATHS = Object.freeze({
  applications: "case-applications.html",
  invitations: "paralegal-invitations.html",
});

const ALLOWED_QUERY_KEYS = new Set([
  "caseId",
  "tab",
  ...Object.values(MATTER_DEEP_LINKS).map((entry) => entry.parameter),
]);

function objectUrlError(code) {
  const error = new Error(code);
  error.name = "ObjectUrlPolicyError";
  error.code = code;
  return error;
}

function assertObjectId(value, code = "invalid_object_id") {
  const normalized = String(value || "").trim();
  if (!mongoose.isValidObjectId(normalized) || !/^[a-f0-9]{24}$/i.test(normalized)) {
    throw objectUrlError(code);
  }
  return normalized.toLowerCase();
}

function assertMatterTab(value) {
  const tab = String(value || "").trim().toLowerCase();
  if (!MATTER_WORKSPACE_TABS.includes(tab)) throw objectUrlError("invalid_matter_tab");
  return tab;
}

function buildMatterWorkspaceUrl({ matterId, tab = "overview", anchor = null } = {}) {
  const normalizedMatterId = assertObjectId(matterId, "invalid_matter_id");
  const normalizedTab = assertMatterTab(tab);
  const params = new URLSearchParams({ caseId: normalizedMatterId, tab: normalizedTab });

  if (anchor != null) {
    const type = String(anchor?.type || "").trim().toLowerCase();
    const policy = MATTER_DEEP_LINKS[type];
    if (!policy) throw objectUrlError("invalid_matter_anchor_type");
    if (policy.tab !== normalizedTab) throw objectUrlError("matter_anchor_tab_mismatch");
    params.set(policy.parameter, assertObjectId(anchor.id, "invalid_matter_anchor_id"));
  }

  return `case-detail.html?${params.toString()}`;
}

function buildMatterWorkspaceLinks(matterId) {
  const normalizedMatterId = assertObjectId(matterId, "invalid_matter_id");
  return Object.freeze({
    self: buildMatterWorkspaceUrl({ matterId: normalizedMatterId, tab: "overview" }),
    tabs: Object.freeze(Object.fromEntries(
      MATTER_WORKSPACE_TABS.map((tab) => [
        tab,
        buildMatterWorkspaceUrl({ matterId: normalizedMatterId, tab }),
      ])
    )),
  });
}

function parseMatterWorkspaceUrl(value) {
  const raw = String(value || "").trim();
  if (
    !raw ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(raw)
  ) {
    throw objectUrlError("unsafe_object_url");
  }

  let parsed;
  try {
    parsed = new URL(raw, "https://lpc-object-policy.invalid/");
  } catch (_error) {
    throw objectUrlError("invalid_object_url");
  }
  if (parsed.origin !== "https://lpc-object-policy.invalid" || parsed.pathname !== "/case-detail.html") {
    throw objectUrlError("unsafe_object_url");
  }
  if (parsed.hash) throw objectUrlError("object_url_fragment_not_allowed");

  const seen = new Set();
  for (const [key] of parsed.searchParams.entries()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw objectUrlError("unknown_object_url_parameter");
    if (seen.has(key)) throw objectUrlError("duplicate_object_url_parameter");
    seen.add(key);
  }
  if (!seen.has("caseId") || !seen.has("tab")) throw objectUrlError("incomplete_object_url");

  const matterId = assertObjectId(parsed.searchParams.get("caseId"), "invalid_matter_id");
  const tab = assertMatterTab(parsed.searchParams.get("tab"));
  const anchors = Object.entries(MATTER_DEEP_LINKS).filter(([, policy]) =>
    parsed.searchParams.has(policy.parameter)
  );
  if (anchors.length > 1) throw objectUrlError("multiple_matter_anchors");

  let anchor = null;
  if (anchors.length === 1) {
    const [type, policy] = anchors[0];
    if (policy.tab !== tab) throw objectUrlError("matter_anchor_tab_mismatch");
    anchor = Object.freeze({
      type,
      id: assertObjectId(parsed.searchParams.get(policy.parameter), "invalid_matter_anchor_id"),
    });
  }

  return Object.freeze({ matterId, tab, anchor });
}

function isSafeMatterWorkspaceUrl(value) {
  try {
    parseMatterWorkspaceUrl(value);
    return true;
  } catch (_error) {
    return false;
  }
}

function buildProfileUrl({ profileId, role, matterId = null } = {}) {
  const normalizedProfileId = assertObjectId(profileId, "invalid_profile_id");
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (!PROFILE_ROLES.includes(normalizedRole)) throw objectUrlError("invalid_profile_role");
  const parameter = normalizedRole === "paralegal" ? "paralegalId" : "id";
  const params = new URLSearchParams({ [parameter]: normalizedProfileId });
  if (matterId != null) params.set("caseId", assertObjectId(matterId, "invalid_matter_id"));
  return `profile-${normalizedRole}.html?${params.toString()}`;
}

function buildCompatibilityObjectUrl({ kind, matterId } = {}) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  const path = LEGACY_OBJECT_PATHS[normalizedKind];
  if (!path) throw objectUrlError("invalid_compatibility_object_kind");
  if (normalizedKind === "invitations") return path;
  const params = new URLSearchParams({ caseId: assertObjectId(matterId, "invalid_matter_id") });
  return `${path}?${params.toString()}`;
}

function parseExplicitObjectUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || raw.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw objectUrlError("unsafe_object_url");
  }
  let parsed;
  try {
    parsed = new URL(raw, "https://lpc-object-policy.invalid/");
  } catch (_error) {
    throw objectUrlError("invalid_object_url");
  }
  if (parsed.origin !== "https://lpc-object-policy.invalid") throw objectUrlError("unsafe_object_url");

  if (parsed.pathname === "/case-detail.html") return parseMatterWorkspaceUrl(raw);

  const exact = (allowedKeys) => {
    const seen = new Set();
    for (const [key] of parsed.searchParams.entries()) {
      if (!allowedKeys.includes(key)) throw objectUrlError("unknown_object_url_parameter");
      if (seen.has(key)) throw objectUrlError("duplicate_object_url_parameter");
      seen.add(key);
    }
    return seen;
  };

  if (["/profile-paralegal.html", "/profile-attorney.html"].includes(parsed.pathname)) {
    if (parsed.hash) throw objectUrlError("object_url_fragment_not_allowed");
    const role = parsed.pathname.includes("paralegal") ? "paralegal" : "attorney";
    const parameter = role === "paralegal" ? "paralegalId" : "id";
    const seen = exact([parameter, "caseId"]);
    if (!seen.has(parameter)) throw objectUrlError("incomplete_object_url");
    const profileId = assertObjectId(parsed.searchParams.get(parameter), "invalid_profile_id");
    const matterId = seen.has("caseId")
      ? assertObjectId(parsed.searchParams.get("caseId"), "invalid_matter_id")
      : null;
    return Object.freeze({ kind: "profile", role, profileId, matterId });
  }

  if (parsed.pathname === "/case-applications.html") {
    if (parsed.hash) throw objectUrlError("object_url_fragment_not_allowed");
    const seen = exact(["caseId"]);
    if (!seen.has("caseId")) throw objectUrlError("incomplete_object_url");
    return Object.freeze({ kind: "applications", matterId: assertObjectId(parsed.searchParams.get("caseId"), "invalid_matter_id") });
  }
  if (parsed.pathname === "/paralegal-invitations.html") {
    if (parsed.hash || [...parsed.searchParams].length) throw objectUrlError("unsafe_object_url");
    return Object.freeze({ kind: "invitations" });
  }
  if (["/dashboard-attorney.html", "/dashboard-paralegal.html"].includes(parsed.pathname)) {
    if ([...parsed.searchParams].length || !["#cases", "#applications"].includes(parsed.hash)) {
      throw objectUrlError("unsafe_object_url");
    }
    return Object.freeze({ kind: "legacy_dashboard", path: parsed.pathname.slice(1), anchor: parsed.hash.slice(1) });
  }
  if (/^\/api\/payments\/receipt\/(?:attorney|paralegal)\/[a-f0-9]{24}$/i.test(parsed.pathname)) {
    if (parsed.hash || [...parsed.searchParams].length) throw objectUrlError("unsafe_object_url");
    return Object.freeze({ kind: "receipt" });
  }
  if (/^\/api\/uploads\/case\/[a-f0-9]{24}\/[a-f0-9]{24}\/download$/i.test(parsed.pathname)) {
    if (parsed.hash || [...parsed.searchParams].length) throw objectUrlError("unsafe_object_url");
    return Object.freeze({ kind: "file_download" });
  }
  throw objectUrlError("unsafe_object_url");
}

function isSafeObjectUrl(value) {
  try {
    parseExplicitObjectUrl(value);
    return true;
  } catch (_error) {
    return false;
  }
}

function assertCanonicalObjectUrl({ objectType, objectId, matterId = null, url } = {}) {
  const type = String(objectType || "").trim().toLowerCase();
  const id = assertObjectId(objectId, "invalid_object_id");
  const expectedMatterId = matterId == null
    ? null
    : assertObjectId(matterId, "invalid_matter_id");
  let parsed;
  try {
    parsed = parseExplicitObjectUrl(url);
  } catch (_error) {
    throw objectUrlError("object_canonical_url_mismatch");
  }

  const exactMatterLink = (tab, anchorType = null) => {
    const linkedMatterId = expectedMatterId || (type === "matter" || type === "conversation" ? id : null);
    return Boolean(
      linkedMatterId &&
      parsed?.matterId === linkedMatterId &&
      parsed?.tab === tab &&
      (anchorType
        ? parsed?.anchor?.type === anchorType && parsed.anchor.id === id
        : parsed?.anchor === null)
    );
  };

  const valid = type === "matter"
    ? exactMatterLink("overview")
    : type === "profile"
      ? parsed?.kind === "profile" && parsed.profileId === id
      : type === "application"
        ? exactMatterLink("applications", "application")
        : type === "invitation"
          ? exactMatterLink("applications", "invitation")
          : type === "assignment"
            ? exactMatterLink("overview", "assignment")
            : type === "file"
              ? exactMatterLink("files", "file")
              : type === "message"
                ? exactMatterLink("messages", "message")
                : type === "financial_summary"
                  ? exactMatterLink("financials")
                  : type === "conversation"
                    ? exactMatterLink("messages")
                    : false;
  if (!valid) throw objectUrlError("object_canonical_url_mismatch");
  return String(url);
}

module.exports = {
  MATTER_DEEP_LINKS,
  MATTER_WORKSPACE_TABS,
  assertCanonicalObjectUrl,
  assertObjectId,
  buildCompatibilityObjectUrl,
  buildMatterWorkspaceLinks,
  buildMatterWorkspaceUrl,
  buildProfileUrl,
  isSafeObjectUrl,
  isSafeMatterWorkspaceUrl,
  parseExplicitObjectUrl,
  parseMatterWorkspaceUrl,
};
