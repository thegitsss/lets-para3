const crypto = require("crypto");
const axios = require("axios");
const { URLSearchParams } = require("url");

const MarketingChannelConnection = require("../../models/MarketingChannelConnection");
const {
  MARKETING_CHANNEL_CONNECTION_STATUSES,
  MARKETING_PUBLISHING_CHANNELS,
} = require("./constants");
const { decryptString, encryptString } = require("../../utils/dataEncryption");

const LINKEDIN_CONTENT_AUTHORIZATION_ACTION = "ORGANIC_SHARE_CREATE";
const LINKEDIN_DEFAULT_API_VERSION = "202503";
const LINKEDIN_REQUIRED_SCOPES = Object.freeze(["w_organization_social", "rw_organization_admin"]);

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "system",
    userId: actor.userId || actor._id || actor.id || null,
    label: actor.label || actor.email || "System",
  };
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .flatMap((value) => String(value || "").split(/[\n, ,]+/g))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function normalizeChannelKey(value = "") {
  const channelKey = String(value || "").trim();
  if (!MARKETING_PUBLISHING_CHANNELS.includes(channelKey)) {
    throw new Error("Unsupported marketing channel.");
  }
  return channelKey;
}

function normalizeApiVersion(value = "") {
  return String(value || "").trim().slice(0, 40) || LINKEDIN_DEFAULT_API_VERSION;
}

function getLinkedInOAuthConfig() {
  const clientId = String(process.env.LINKEDIN_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.LINKEDIN_CLIENT_SECRET || "").trim();
  const redirectUri =
    String(process.env.LINKEDIN_OAUTH_REDIRECT_URI || "").trim() ||
    `${String(process.env.APP_BASE_URL || "").replace(/\/+$/, "")}/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback`;
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes: ["openid", "profile", "email", "w_organization_social", "rw_organization_admin"],
  };
}

function ensureLinkedInOAuthConfigured() {
  const config = getLinkedInOAuthConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUri || !/^https?:\/\//.test(config.redirectUri)) {
    const error = new Error("LinkedIn OAuth is not configured on the server.");
    error.statusCode = 409;
    throw error;
  }
  return config;
}

function hashState(state = "") {
  return crypto.createHash("sha256").update(String(state || ""), "utf8").digest("hex");
}

function normalizeConnectionStatus(connection = {}) {
  const token = decryptString(connection.encryptedAccessToken || "") || "";
  const orgUrn = String(connection.organizationUrn || "").trim();
  const hasToken = Boolean(token);
  const expired = connection.tokenExpiresAt && new Date(connection.tokenExpiresAt).getTime() <= Date.now();

  if (!connection || connection.isActive === false) {
    return { status: "not_connected", note: "LinkedIn company posting is not connected." };
  }
  if (!hasToken) {
    return { status: "not_connected", note: "Connect LinkedIn to acquire an access token." };
  }
  if (expired) {
    return { status: "auth_failed", note: "LinkedIn access token is expired. Reconnect LinkedIn." };
  }
  if (connection.status === "auth_failed") {
    return { status: "auth_failed", note: connection.lastValidationNote || "LinkedIn authentication failed." };
  }
  const grantedScopes = new Set(Array.isArray(connection.scopeSnapshot) ? connection.scopeSnapshot : []);
  const missingScopes = LINKEDIN_REQUIRED_SCOPES.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length) {
    return {
      status: "blocked",
      note: `LinkedIn token is missing required scope${missingScopes.length > 1 ? "s" : ""}: ${missingScopes.join(", ")}.`,
    };
  }
  if (!orgUrn) {
    return {
      status: "connected_unvalidated",
      note: connection.lastValidationNote || "LinkedIn is connected, but the organization is not confirmed yet.",
    };
  }
  if (connection.authorizationGranted === true && connection.lastValidationStatus === "connected_validated") {
    return {
      status: "connected_validated",
      note: connection.lastValidationNote || "LinkedIn company connection is validated for organization posting.",
    };
  }
  if (connection.lastValidationStatus === "blocked" || connection.authorizationGranted === false) {
    return {
      status: "blocked",
      note: connection.lastValidationNote || "LinkedIn organization authorization is not validated.",
    };
  }
  return {
    status: "connected_unvalidated",
    note: connection.lastValidationNote || "LinkedIn is connected, but organization authorization still needs validation.",
  };
}

function serializeDiscoveredOrganizations(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    organizationId: String(item.organizationId || item.id || "").trim(),
    organizationUrn: String(item.organizationUrn || "").trim(),
    organizationName: String(item.organizationName || item.localizedName || item.name || "").trim(),
  }));
}

function serializeConnection(connection = null, { includeSecret = false } = {}) {
  if (!connection) {
    return {
      id: "",
      channelKey: "linkedin_company",
      provider: "linkedin",
      status: "not_connected",
      isActive: false,
      memberId: "",
      memberUrn: "",
      memberName: "",
      organizationId: "",
      organizationUrn: "",
      organizationName: "",
      authorizationAction: LINKEDIN_CONTENT_AUTHORIZATION_ACTION,
      authorizationGranted: false,
      discoveredOrganizations: [],
      accessTokenConfigured: false,
      accessTokenLast4: "",
      tokenExpiresAt: null,
      scopeSnapshot: [],
      apiVersion: LINKEDIN_DEFAULT_API_VERSION,
      lastValidatedAt: null,
      lastValidationStatus: "not_connected",
      lastValidationNote: "LinkedIn company posting is not connected.",
      oauthRequestedAt: null,
      oauthLastCompletedAt: null,
      oauthLastError: "",
      lastPublishSucceededAt: null,
      lastPublishFailedAt: null,
      lastPublishError: "",
      updatedAt: null,
      accessToken: includeSecret ? "" : undefined,
    };
  }

  const normalized = normalizeConnectionStatus(connection);
  const serialized = {
    id: connection._id ? String(connection._id) : "",
    channelKey: connection.channelKey || "linkedin_company",
    provider: connection.provider || "linkedin",
    status: normalized.status,
    isActive: connection.isActive !== false,
    memberId: connection.memberId || "",
    memberUrn: connection.memberUrn || "",
    memberName: connection.memberName || "",
    organizationId: connection.organizationId || "",
    organizationUrn: connection.organizationUrn || "",
    organizationName: connection.organizationName || "",
    authorizationAction: connection.authorizationAction || LINKEDIN_CONTENT_AUTHORIZATION_ACTION,
    authorizationGranted: connection.authorizationGranted === true,
    discoveredOrganizations: serializeDiscoveredOrganizations(connection.discoveredOrganizations),
    accessTokenConfigured: Boolean(decryptString(connection.encryptedAccessToken || "")),
    accessTokenLast4: connection.accessTokenLast4 || "",
    tokenExpiresAt: connection.tokenExpiresAt || null,
    scopeSnapshot: Array.isArray(connection.scopeSnapshot) ? connection.scopeSnapshot : [],
    apiVersion: connection.apiVersion || LINKEDIN_DEFAULT_API_VERSION,
    lastValidatedAt: connection.lastValidatedAt || null,
    lastValidationStatus: connection.lastValidationStatus || normalized.status,
    lastValidationNote: connection.lastValidationNote || normalized.note,
    oauthRequestedAt: connection.oauthRequestedAt || null,
    oauthLastCompletedAt: connection.oauthLastCompletedAt || null,
    oauthLastError: connection.oauthLastError || "",
    lastPublishSucceededAt: connection.lastPublishSucceededAt || null,
    lastPublishFailedAt: connection.lastPublishFailedAt || null,
    lastPublishError: connection.lastPublishError || "",
    updatedAt: connection.updatedAt || null,
  };

  if (includeSecret) {
    serialized.accessToken = decryptString(connection.encryptedAccessToken || "") || "";
  }

  return serialized;
}

async function getOrCreateConnection(channelKey = "linkedin_company") {
  const normalizedChannelKey = normalizeChannelKey(channelKey);
  let connection = await MarketingChannelConnection.findOne({ channelKey: normalizedChannelKey });
  if (connection) return connection;
  connection = await MarketingChannelConnection.create({
    channelKey: normalizedChannelKey,
    provider: normalizedChannelKey === "linkedin_company" ? "linkedin" : "facebook",
    status: normalizedChannelKey === "linkedin_company" ? "not_connected" : "blocked",
  });
  return connection;
}

async function getChannelConnection(channelKey = "", options = {}) {
  const normalizedChannelKey = normalizeChannelKey(channelKey);
  const connection = await MarketingChannelConnection.findOne({ channelKey: normalizedChannelKey });
  return serializeConnection(connection, options);
}

async function getChannelConnectionDoc(channelKey = "", options = {}) {
  const normalizedChannelKey = normalizeChannelKey(channelKey);
  const connection = await MarketingChannelConnection.findOne({ channelKey: normalizedChannelKey });
  if (!connection) return null;
  if (options.includeSecret) {
    const output = connection.toObject();
    output.accessToken = decryptString(connection.encryptedAccessToken || "") || "";
    return output;
  }
  return connection;
}

function normalizeOrganizationPayload(payload = {}) {
  const organizationUrn = String(payload.organizationUrn || "").trim().slice(0, 240);
  const organizationId =
    String(payload.organizationId || "")
      .trim()
      .replace(/^urn:li:organization:/, "")
      .slice(0, 120) || (organizationUrn ? organizationUrn.replace(/^urn:li:organization:/, "") : "");
  return {
    organizationId,
    organizationUrn: organizationUrn || (organizationId ? `urn:li:organization:${organizationId}` : ""),
    organizationName: String(payload.organizationName || "").trim().slice(0, 240),
  };
}

async function upsertChannelConnection({ channelKey = "", payload = {}, actor = {} } = {}) {
  const normalizedChannelKey = normalizeChannelKey(channelKey);
  const connection = await getOrCreateConnection(normalizedChannelKey);

  connection.isActive = payload.isActive !== false;
  const orgPayload = normalizeOrganizationPayload(payload);
  connection.organizationId = orgPayload.organizationId;
  connection.organizationUrn = orgPayload.organizationUrn;
  connection.organizationName = orgPayload.organizationName || connection.organizationName || "";
  connection.apiVersion = normalizeApiVersion(payload.apiVersion);
  connection.updatedBy = toActor(actor);
  if (Object.prototype.hasOwnProperty.call(payload, "scopeSnapshot")) {
    connection.scopeSnapshot = uniqueStrings(payload.scopeSnapshot || []);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "accessToken")) {
    const accessToken = String(payload.accessToken || "").trim();
    connection.encryptedAccessToken = accessToken ? encryptString(accessToken) : "";
    connection.accessTokenLast4 = accessToken ? accessToken.slice(-4) : "";
  }
  if (Object.prototype.hasOwnProperty.call(payload, "tokenExpiresAt")) {
    connection.tokenExpiresAt = payload.tokenExpiresAt ? new Date(payload.tokenExpiresAt) : null;
  }

  const normalized = normalizeConnectionStatus(connection);
  connection.status = normalized.status;
  connection.lastValidationStatus = normalized.status;
  connection.lastValidationNote = normalized.note;
  await connection.save();
  return serializeConnection(connection);
}

async function markConnectionPublishResult({
  channelKey = "",
  success = false,
  errorMessage = "",
} = {}) {
  const normalizedChannelKey = normalizeChannelKey(channelKey);
  const connection = await MarketingChannelConnection.findOne({ channelKey: normalizedChannelKey });
  if (!connection) return null;

  if (success) {
    connection.lastPublishSucceededAt = new Date();
    connection.lastPublishError = "";
  } else {
    connection.lastPublishFailedAt = new Date();
    connection.lastPublishError = String(errorMessage || "").trim().slice(0, 2000);
  }
  await connection.save();
  return serializeConnection(connection);
}

async function getChannelReadinessSummary(channelKey = "") {
  if (channelKey === "facebook_page") {
    return {
      channelKey,
      status: "blocked",
      note: "Facebook Page publishing is not implemented yet.",
    };
  }
  const serialized = await getChannelConnection(channelKey);
  return {
    channelKey,
    status: serialized.status || "not_connected",
    note: serialized.lastValidationNote || "LinkedIn company posting is not connected.",
  };
}

function buildLinkedInHeaders(accessToken = "", apiVersion = LINKEDIN_DEFAULT_API_VERSION) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Linkedin-Version": normalizeApiVersion(apiVersion),
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

function getAccessTokenExpiry(expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}

async function exchangeLinkedInAuthorizationCode({ code = "" } = {}) {
  const config = ensureLinkedInOAuthConfigured();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || "").trim(),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  const response = await axios.post("https://www.linkedin.com/oauth/v2/accessToken", body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300 || !response.data?.access_token) {
    const error = new Error(response.data?.error_description || response.data?.error || "LinkedIn OAuth exchange failed.");
    error.statusCode = response.status || 502;
    error.response = response;
    throw error;
  }
  return {
    accessToken: String(response.data.access_token || "").trim(),
    tokenExpiresAt: getAccessTokenExpiry(response.data.expires_in),
    scopeSnapshot: uniqueStrings(String(response.data.scope || "").split(" ")),
  };
}

async function fetchLinkedInUserInfo({ accessToken = "" } = {}) {
  const response = await axios.get("https://api.linkedin.com/v2/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300 || !response.data?.sub) {
    const error = new Error(response.data?.message || "Unable to retrieve LinkedIn member identity.");
    error.statusCode = response.status || 502;
    error.response = response;
    throw error;
  }
  const memberId = String(response.data.sub || "").trim();
  return {
    memberId,
    memberUrn: memberId ? `urn:li:person:${memberId}` : "",
    memberName:
      String(
        [response.data.given_name, response.data.family_name].filter(Boolean).join(" ") ||
          response.data.name ||
          ""
      )
        .trim()
        .slice(0, 240),
    email: String(response.data.email || "").trim(),
  };
}

async function discoverManagedOrganizations({ accessToken = "", apiVersion = LINKEDIN_DEFAULT_API_VERSION } = {}) {
  const response = await axios.get("https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&state=APPROVED", {
    headers: buildLinkedInHeaders(accessToken, apiVersion),
    timeout: 15000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(response.data?.message || "Unable to discover LinkedIn organizations.");
    error.statusCode = response.status || 502;
    error.response = response;
    throw error;
  }

  const organizations = uniqueStrings((response.data?.elements || []).map((item) => item.organization))
    .map((urn) => ({
      organizationUrn: urn,
      organizationId: String(urn || "").replace(/^urn:li:organization:/, ""),
    }))
    .filter((item) => item.organizationId);

  if (!organizations.length) return [];

  const ids = organizations.map((item) => item.organizationId).join(",");
  const lookupResponse = await axios.get(
    `https://api.linkedin.com/rest/organizationsLookup?ids=List(${ids})`,
    {
      headers: buildLinkedInHeaders(accessToken, apiVersion),
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  if (lookupResponse.status < 200 || lookupResponse.status >= 300) {
    return organizations;
  }

  const results = lookupResponse.data?.results || {};
  return organizations.map((item) => ({
    ...item,
    organizationName:
      String(results[item.organizationId]?.localizedName || results[item.organizationId]?.name?.localized?.en_US || "")
        .trim()
        .slice(0, 240),
  }));
}

async function validateOrganizationAuthorization({
  accessToken = "",
  memberUrn = "",
  organizationUrn = "",
  apiVersion = LINKEDIN_DEFAULT_API_VERSION,
} = {}) {
  const encodedMemberUrn = encodeURIComponent(memberUrn);
  const encodedOrganizationUrn = encodeURIComponent(organizationUrn);
  const response = await axios.get(
    `https://api.linkedin.com/rest/organizationAuthorizations/(impersonator:${encodedMemberUrn},organization:${encodedOrganizationUrn},action:(organizationContentAuthorizationAction:(actionType:${LINKEDIN_CONTENT_AUTHORIZATION_ACTION})))`,
    {
      headers: buildLinkedInHeaders(accessToken, apiVersion),
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  if (response.status === 401 || response.status === 403) {
    const error = new Error(response.data?.message || "LinkedIn authorization validation failed.");
    error.statusCode = response.status;
    error.response = response;
    error.failureStatus = "auth_failed";
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(response.data?.message || "LinkedIn authorization validation failed.");
    error.statusCode = response.status || 502;
    error.response = response;
    throw error;
  }

  const statusEntries = Object.entries(response.data?.status || {});
  const granted = statusEntries.some(([key, value]) => {
    if (!/Approved/i.test(key)) return false;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0;
    return value === true || String(value || "").toLowerCase() === "true";
  });
  return {
    granted,
    responseData: response.data || {},
  };
}

function pickOrganizationForValidation(connection = {}, discoveredOrganizations = []) {
  const hinted = normalizeOrganizationPayload(connection);
  if (hinted.organizationUrn) return hinted;
  if (discoveredOrganizations.length === 1) return discoveredOrganizations[0];
  return null;
}

async function validateLinkedInConnection({ actor = {}, forceRevalidate = false } = {}) {
  const connection = await getOrCreateConnection("linkedin_company");
  const accessToken = decryptString(connection.encryptedAccessToken || "") || "";
  if (!accessToken) {
    connection.status = "not_connected";
    connection.authorizationGranted = false;
    connection.lastValidatedAt = new Date();
    connection.lastValidationStatus = "not_connected";
    connection.lastValidationNote = "Connect LinkedIn to acquire an access token.";
    await connection.save();
    return serializeConnection(connection);
  }
  const grantedScopes = new Set(Array.isArray(connection.scopeSnapshot) ? connection.scopeSnapshot : []);
  const missingScopes = LINKEDIN_REQUIRED_SCOPES.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length) {
    connection.authorizationGranted = false;
    connection.lastValidatedAt = new Date();
    connection.status = "blocked";
    connection.lastValidationStatus = "blocked";
    connection.lastValidationNote = `LinkedIn token is missing required scope${missingScopes.length > 1 ? "s" : ""}: ${missingScopes.join(", ")}.`;
    await connection.save();
    return serializeConnection(connection);
  }

  if (!forceRevalidate && connection.status === "connected_validated" && connection.lastValidatedAt) {
    return serializeConnection(connection);
  }

  try {
    const userInfo = await fetchLinkedInUserInfo({
      accessToken,
    });
    connection.memberId = userInfo.memberId;
    connection.memberUrn = userInfo.memberUrn;
    connection.memberName = userInfo.memberName || connection.memberName || "";

    const discoveredOrganizations = await discoverManagedOrganizations({
      accessToken,
      apiVersion: connection.apiVersion || LINKEDIN_DEFAULT_API_VERSION,
    });
    connection.discoveredOrganizations = discoveredOrganizations;

    const candidateOrganization = pickOrganizationForValidation(connection, discoveredOrganizations);
    if (!candidateOrganization) {
      connection.authorizationGranted = false;
      connection.status = discoveredOrganizations.length ? "blocked" : "connected_unvalidated";
      connection.lastValidatedAt = new Date();
      connection.lastValidationStatus = connection.status;
      connection.lastValidationNote = discoveredOrganizations.length
        ? "Multiple LinkedIn organizations were discovered. Confirm the LPC organization before publishing."
        : "LinkedIn is connected, but no administered organization was discovered.";
      connection.updatedBy = toActor(actor);
      await connection.save();
      return serializeConnection(connection);
    }

    connection.organizationId = candidateOrganization.organizationId || connection.organizationId || "";
    connection.organizationUrn = candidateOrganization.organizationUrn || connection.organizationUrn || "";
    connection.organizationName = candidateOrganization.organizationName || connection.organizationName || "";
    connection.authorizationAction = LINKEDIN_CONTENT_AUTHORIZATION_ACTION;

    const validation = await validateOrganizationAuthorization({
      accessToken,
      memberUrn: connection.memberUrn,
      organizationUrn: connection.organizationUrn,
      apiVersion: connection.apiVersion || LINKEDIN_DEFAULT_API_VERSION,
    });

    connection.authorizationGranted = validation.granted === true;
    connection.lastValidatedAt = new Date();
    connection.updatedBy = toActor(actor);
    if (validation.granted) {
      connection.status = "connected_validated";
      connection.lastValidationStatus = "connected_validated";
      connection.lastValidationNote = `Validated for LinkedIn company posting as ${connection.organizationName || connection.organizationUrn}.`;
    } else {
      connection.status = "blocked";
      connection.lastValidationStatus = "blocked";
      connection.lastValidationNote = "LinkedIn connection does not have organization authorization to create company posts.";
    }
    await connection.save();
    return serializeConnection(connection);
  } catch (error) {
    connection.authorizationGranted = false;
    connection.lastValidatedAt = new Date();
    connection.updatedBy = toActor(actor);
    connection.status =
      error.failureStatus || error.statusCode === 401 || error.statusCode === 403
        ? "auth_failed"
        : "blocked";
    connection.lastValidationStatus = connection.status;
    connection.lastValidationNote = String(error.message || "LinkedIn validation failed.").trim().slice(0, 1000);
    await connection.save();
    return serializeConnection(connection);
  }
}

async function startLinkedInOAuth({ actor = {}, hints = {} } = {}) {
  const config = ensureLinkedInOAuthConfigured();
  const connection = await getOrCreateConnection("linkedin_company");
  const orgPayload = normalizeOrganizationPayload(hints);
  if (orgPayload.organizationId) connection.organizationId = orgPayload.organizationId;
  if (orgPayload.organizationUrn) connection.organizationUrn = orgPayload.organizationUrn;
  if (orgPayload.organizationName) connection.organizationName = orgPayload.organizationName;
  if (Object.prototype.hasOwnProperty.call(hints, "apiVersion")) {
    connection.apiVersion = normalizeApiVersion(hints.apiVersion);
  }

  const state = crypto.randomBytes(24).toString("hex");
  connection.oauthStateHash = hashState(state);
  connection.oauthStateExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  connection.oauthRequestedBy = toActor(actor);
  connection.oauthRequestedAt = new Date();
  connection.oauthLastError = "";
  connection.updatedBy = toActor(actor);
  await connection.save();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
  });
  return {
    connectUrl: `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`,
    expiresAt: connection.oauthStateExpiresAt,
  };
}

function buildCallbackPayload({ ok = false, message = "", connection = null } = {}) {
  return {
    ok,
    message,
    connection,
  };
}

function renderOAuthCallbackHtml(payload = {}) {
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>LinkedIn Connection</title>
</head>
<body>
  <script>
    (function () {
      const payload = ${safePayload};
      try {
        if (window.opener && typeof window.opener.postMessage === "function") {
          window.opener.postMessage({ type: "marketing-linkedin-oauth", payload }, window.location.origin);
        }
      } catch (_) {}
      window.close();
      document.body.innerHTML = payload.ok
        ? "<p>LinkedIn connection completed. You can close this window.</p>"
        : "<p>LinkedIn connection failed. You can close this window.</p>";
    })();
  </script>
</body>
</html>`;
}

async function completeLinkedInOAuth({ code = "", state = "", error = "", errorDescription = "" } = {}) {
  const stateHash = hashState(state);
  const connection = await MarketingChannelConnection.findOne({
    channelKey: "linkedin_company",
    oauthStateHash: stateHash,
    oauthStateExpiresAt: { $gt: new Date() },
  });

  if (!connection) {
    return buildCallbackPayload({
      ok: false,
      message: "LinkedIn connection state is invalid or expired.",
    });
  }

  connection.oauthStateHash = "";
  connection.oauthStateExpiresAt = null;
  connection.oauthLastCompletedAt = new Date();

  if (error) {
    connection.status = "auth_failed";
    connection.lastValidationStatus = "auth_failed";
    connection.lastValidationNote = String(errorDescription || error || "LinkedIn authorization was denied.")
      .trim()
      .slice(0, 1000);
    connection.oauthLastError = connection.lastValidationNote;
    await connection.save();
    return buildCallbackPayload({
      ok: false,
      message: connection.lastValidationNote,
      connection: serializeConnection(connection),
    });
  }

  try {
    const tokenResult = await exchangeLinkedInAuthorizationCode({ code });
    connection.encryptedAccessToken = encryptString(tokenResult.accessToken);
    connection.accessTokenLast4 = tokenResult.accessToken.slice(-4);
    connection.tokenExpiresAt = tokenResult.tokenExpiresAt;
    connection.scopeSnapshot = tokenResult.scopeSnapshot.length ? tokenResult.scopeSnapshot : connection.scopeSnapshot;
    connection.oauthLastError = "";
    connection.status = "connected_unvalidated";
    connection.lastValidationStatus = "connected_unvalidated";
    connection.lastValidationNote = "LinkedIn connected. Validating organization authorization.";
    await connection.save();

    const validated = await validateLinkedInConnection({
      actor: connection.oauthRequestedBy || {},
      forceRevalidate: true,
    });
    return buildCallbackPayload({
      ok: validated.status === "connected_validated",
      message: validated.lastValidationNote,
      connection: validated,
    });
  } catch (err) {
    connection.status = err.statusCode === 401 || err.statusCode === 403 ? "auth_failed" : "blocked";
    connection.lastValidationStatus = connection.status;
    connection.lastValidationNote = String(err.message || "LinkedIn connection failed.").trim().slice(0, 1000);
    connection.oauthLastError = connection.lastValidationNote;
    await connection.save();
    return buildCallbackPayload({
      ok: false,
      message: connection.lastValidationNote,
      connection: serializeConnection(connection),
    });
  }
}

module.exports = {
  LINKEDIN_CONTENT_AUTHORIZATION_ACTION,
  LINKEDIN_REQUIRED_SCOPES,
  buildCallbackPayload,
  completeLinkedInOAuth,
  discoverManagedOrganizations,
  ensureLinkedInOAuthConfigured,
  fetchLinkedInUserInfo,
  getChannelConnection,
  getChannelConnectionDoc,
  getChannelReadinessSummary,
  getLinkedInOAuthConfig,
  getOrCreateConnection,
  markConnectionPublishResult,
  normalizeConnectionStatus,
  renderOAuthCallbackHtml,
  serializeConnection,
  startLinkedInOAuth,
  upsertChannelConnection,
  validateLinkedInConnection,
  validateOrganizationAuthorization,
};
