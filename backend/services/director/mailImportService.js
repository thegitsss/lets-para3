const axios = require("axios");

const {
  DIRECTOR_FOLLOW_UP_SUBJECT,
  DIRECTOR_OUTREACH_SUBJECT,
} = require("./constants");

const DEFAULT_ZOHO_BASE_URL = "https://mail.zoho.com/api";
const DEFAULT_ZOHO_ACCOUNTS_BASE_URL = "https://accounts.zoho.com";
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;
const zohoAccessTokenCache = new Map();

function normalizeEmail(value = "") {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function normalizeSubject(value = "") {
  return String(value || "")
    .replace(/^\s*(re|fw|fwd):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseAddress(value = "") {
  if (!value) return { name: "", email: "" };
  if (typeof value === "object") {
    return {
      name: String(value.name || value.displayName || value.address || "").replace(/["<>]/g, "").trim(),
      email: normalizeEmail(value.address || value.email || value.mail || value.value || ""),
    };
  }
  const text = String(value || "").trim();
  const email = normalizeEmail(text);
  const name = text
    .replace(/<[^>]+>/g, "")
    .replace(email, "")
    .replace(/["<>]/g, "")
    .trim();
  return { name, email };
}

function flattenAddressList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenAddressList);
  if (typeof value === "object") return [parseAddress(value)].filter((item) => item.email);
  return String(value)
    .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
    .map(parseAddress)
    .filter((item) => item.email);
}

function inferAttorneyName(address = {}) {
  const explicit = String(address.name || "").trim();
  if (explicit && !/@/.test(explicit)) return explicit.slice(0, 240);
  const local = String(address.email || "").split("@")[0] || "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 240);
}

function getDirectorZohoEnvKey(email = "", suffix = "TOKEN") {
  const local = String(email || "")
    .toUpperCase()
    .replace(/@.*/, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `DIRECTOR_ZOHO_${local}_${suffix}`;
}

function getDirectorZohoConfig(profile = {}) {
  const email = String(profile.zohoEmail || profile.email || "").trim().toLowerCase();
  const token =
    process.env[getDirectorZohoEnvKey(email, "TOKEN")] ||
    process.env.ZOHO_MAIL_OAUTH_TOKEN ||
    "";
  const refreshToken =
    process.env[getDirectorZohoEnvKey(email, "REFRESH_TOKEN")] ||
    process.env.ZOHO_MAIL_REFRESH_TOKEN ||
    "";
  const clientId =
    process.env[getDirectorZohoEnvKey(email, "CLIENT_ID")] ||
    process.env.ZOHO_MAIL_CLIENT_ID ||
    process.env.ZOHO_CLIENT_ID ||
    "";
  const clientSecret =
    process.env[getDirectorZohoEnvKey(email, "CLIENT_SECRET")] ||
    process.env.ZOHO_MAIL_CLIENT_SECRET ||
    process.env.ZOHO_CLIENT_SECRET ||
    "";
  return {
    baseUrl: String(process.env.ZOHO_MAIL_BASE_URL || DEFAULT_ZOHO_BASE_URL).replace(/\/+$/, ""),
    accountsBaseUrl: String(process.env.ZOHO_ACCOUNTS_BASE_URL || DEFAULT_ZOHO_ACCOUNTS_BASE_URL).replace(/\/+$/, ""),
    token: String(token || "").trim(),
    refreshToken: String(refreshToken || "").trim(),
    clientId: String(clientId || "").trim(),
    clientSecret: String(clientSecret || "").trim(),
    accountId:
      process.env[getDirectorZohoEnvKey(email, "ACCOUNT_ID")] ||
      process.env.ZOHO_MAIL_ACCOUNT_ID ||
      "",
    sentFolderId:
      process.env[getDirectorZohoEnvKey(email, "SENT_FOLDER_ID")] ||
      process.env.ZOHO_MAIL_SENT_FOLDER_ID ||
      "",
    inboxFolderId:
      process.env[getDirectorZohoEnvKey(email, "INBOX_FOLDER_ID")] ||
      process.env.ZOHO_MAIL_INBOX_FOLDER_ID ||
      "",
  };
}

function assertConfigured(config = {}) {
  if (config.token) return;
  if (config.refreshToken && config.clientId && config.clientSecret) return;
  if (config.refreshToken && (!config.clientId || !config.clientSecret)) {
    const error = new Error("Zoho Mail refresh token is configured, but Zoho client ID or client secret is missing.");
    error.statusCode = 409;
    throw error;
  }
  if (!config.token) {
    const error = new Error("Zoho Mail import is not configured for this director.");
    error.statusCode = 409;
    throw error;
  }
}

function getZohoCacheKey(config = {}) {
  return [config.accountsBaseUrl, config.clientId, config.refreshToken].join("|");
}

async function refreshZohoAccessToken(config = {}) {
  assertConfigured(config);
  if (!config.refreshToken) return config.token;

  const cacheKey = getZohoCacheKey(config);
  const cached = zohoAccessTokenCache.get(cacheKey);
  if (cached?.accessToken && cached.expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });
  const res = await axios.post(`${config.accountsBaseUrl}/oauth/v2/token`, body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    timeout: 20_000,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300 || !res.data?.access_token) {
    const error = new Error(res.data?.error_description || res.data?.error || `Zoho token refresh failed with ${res.status}.`);
    error.statusCode = res.status;
    error.response = res;
    throw error;
  }

  const expiresInSeconds = Number(res.data.expires_in || 0);
  const ttlMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? expiresInSeconds * 1000
    : DEFAULT_ACCESS_TOKEN_TTL_MS;
  const accessToken = String(res.data.access_token || "").trim();
  zohoAccessTokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + ttlMs,
  });
  return accessToken;
}

function clearZohoAccessTokenCache(config = {}) {
  if (config.refreshToken) {
    zohoAccessTokenCache.delete(getZohoCacheKey(config));
    return;
  }
  zohoAccessTokenCache.clear();
}

async function zohoGet(config, path, params = {}, attempt = 0) {
  assertConfigured(config);
  const accessToken = await refreshZohoAccessToken(config);
  const res = await axios.get(`${config.baseUrl}${path}`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: "application/json",
    },
    params,
    timeout: 20_000,
    validateStatus: () => true,
  });
  if (res.status === 401 && config.refreshToken && attempt === 0) {
    clearZohoAccessTokenCache(config);
    return zohoGet(config, path, params, attempt + 1);
  }
  if (res.status < 200 || res.status >= 300) {
    const error = new Error(res.data?.message || res.data?.error || `Zoho Mail request failed with ${res.status}.`);
    error.statusCode = res.status;
    error.response = res;
    throw error;
  }
  return res.data || {};
}

async function resolveAccountId(config) {
  if (config.accountId) return String(config.accountId);
  const payload = await zohoGet(config, "/accounts");
  const accounts = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.accounts) ? payload.accounts : [];
  const account = accounts[0] || null;
  const accountId = account?.accountId || account?.accountID || account?.id || "";
  if (!accountId) throw new Error("Unable to find Zoho Mail account id.");
  return String(accountId);
}

async function resolveFolderId(config, accountId, folderKind) {
  const existing = folderKind === "sent" ? config.sentFolderId : config.inboxFolderId;
  if (existing) return String(existing);
  const payload = await zohoGet(config, `/accounts/${encodeURIComponent(accountId)}/folders`);
  const folders = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.folders) ? payload.folders : [];
  const wanted = folderKind === "sent" ? ["sent", "sent items", "sent mail"] : ["inbox"];
  const folder =
    folders.find((item) => wanted.includes(String(item.folderName || item.name || "").trim().toLowerCase())) ||
    folders.find((item) => wanted.some((name) => String(item.path || "").toLowerCase().includes(name)));
  const folderId = folder?.folderId || folder?.folderID || folder?.id || "";
  if (!folderId) throw new Error(`Unable to find Zoho ${folderKind} folder id.`);
  return String(folderId);
}

function extractMessageList(payload = {}) {
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.messages)) return payload.messages;
  if (Array.isArray(payload.emailList)) return payload.emailList;
  return [];
}

function getMessageTimestamp(message = {}) {
  const value =
    message.sentDateInGMT ||
    message.receivedTime ||
    message.receivedDate ||
    message.sentDate ||
    message.date ||
    message.time ||
    "";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function extractMessageId(message = {}) {
  return String(
    message.messageId ||
      message.messageID ||
      message.mailId ||
      message.mailID ||
      message.id ||
      ""
  ).trim();
}

function mapSentMessage(message = {}, profile = {}) {
  const subject = String(message.subject || "").trim();
  const normalized = normalizeSubject(subject);
  const outreachSubject = normalizeSubject(DIRECTOR_OUTREACH_SUBJECT);
  const followUpSubject = normalizeSubject(DIRECTOR_FOLLOW_UP_SUBJECT);
  let eventType = "";
  if (normalized === outreachSubject) eventType = "outreach_sent";
  if (normalized === followUpSubject) eventType = "follow_up_sent";
  if (!eventType) return [];

  const recipients = flattenAddressList(
    message.toAddress || message.toEmailAddress || message.to || message.recipients || message.toList
  );
  return recipients.map((recipient) => ({
    eventType,
    attorneyEmail: recipient.email,
    attorneyName: inferAttorneyName(recipient),
    subject,
    occurredAt: getMessageTimestamp(message),
    providerMessageId: extractMessageId(message),
    providerThreadId: String(message.threadId || message.threadID || message.conversationId || "").trim(),
    metadata: {
      importedFrom: "zoho_sent",
      zohoEmail: profile.zohoEmail || profile.email || "",
    },
  }));
}

function mapInboxMessage(message = {}, profile = {}) {
  const subject = String(message.subject || "").trim();
  const normalized = normalizeSubject(subject);
  const allowed = [normalizeSubject(DIRECTOR_OUTREACH_SUBJECT), normalizeSubject(DIRECTOR_FOLLOW_UP_SUBJECT)];
  if (!allowed.includes(normalized)) return null;
  const from = parseAddress(message.fromAddress || message.fromEmailAddress || message.from || message.sender);
  if (!from.email) return null;
  return {
    eventType: "reply_received",
    attorneyEmail: from.email,
    attorneyName: inferAttorneyName(from),
    subject,
    occurredAt: getMessageTimestamp(message),
    providerMessageId: extractMessageId(message),
    providerThreadId: String(message.threadId || message.threadID || message.conversationId || "").trim(),
    summary: String(message.summary || message.snippet || message.content || "").replace(/\s+/g, " ").trim().slice(0, 500),
    metadata: {
      importedFrom: "zoho_inbox",
      zohoEmail: profile.zohoEmail || profile.email || "",
    },
  };
}

async function fetchZohoMessages({ profile, folderKind = "sent", fromDate, toDate } = {}) {
  const config = getDirectorZohoConfig(profile);
  const accountId = await resolveAccountId(config);
  const folderId = await resolveFolderId(config, accountId, folderKind);
  const payload = await zohoGet(
    config,
    `/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folderId)}/messages/view`,
    {
      limit: 200,
      includeto: true,
      fromDate: fromDate ? new Date(fromDate).getTime() : undefined,
      toDate: toDate ? new Date(toDate).getTime() : undefined,
    }
  );
  return extractMessageList(payload);
}

module.exports = {
  clearZohoAccessTokenCache,
  fetchZohoMessages,
  flattenAddressList,
  getDirectorZohoConfig,
  mapInboxMessage,
  mapSentMessage,
  normalizeEmail,
  normalizeSubject,
  refreshZohoAccessToken,
};
