const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const SUPPORTED_STRIPE_API_VERSION = "2026-07-29.dahlia";
const PRODUCTION_JWT_AUDIENCE = "lets-paraconnect-web";
const ATTORNEY_MANAGER_ROLLOUT_STAGES = new Set([0, 10, 25, 50, 100]);
const PRODUCTION_INCIDENT_RELEASE_MODES = new Set(["disabled", "webhook"]);
const { assertRenderReleaseIdentity } = require("./releaseIdentity");
const { assertPublishedPlatformFeePolicy } = require("../services/platformFeePolicy");

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function splitEmails(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requireTruthy(env, names) {
  for (const name of names) {
    if (!isTruthy(env[name])) throw new Error(`[config] ${name} must be true in production.`);
  }
}

function explicitBoolean(env, name) {
  const value = String(env[name] ?? "").trim().toLowerCase();
  if (!new Set(["true", "false"]).has(value)) {
    throw new Error(`[config] ${name} must be explicitly set to true or false in production.`);
  }
  return value === "true";
}

function explicitRolloutStage(env, name, allowedStages) {
  const raw = String(env[name] ?? "").trim();
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || !allowedStages.has(value)) {
    throw new Error(
      `[config] ${name} must be an approved stage: ${[...allowedStages].join(", ")}.`
    );
  }
  return value;
}

function parseUrl(value, label) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[config] ${label} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`[config] ${label} must be an absolute HTTP(S) URL.`);
  }
  return parsed;
}

function assertProductionUrl(value, label, canonicalOrigin, { exactOrigin = false } = {}) {
  const parsed = parseUrl(value, label);
  if (!parsed) return null;
  if (parsed.protocol !== "https:" || LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error(`[config] ${label} must use the canonical production HTTPS origin.`);
  }
  if (canonicalOrigin && parsed.origin !== canonicalOrigin) {
    throw new Error(`[config] ${label} must use ${canonicalOrigin}.`);
  }
  if (
    exactOrigin &&
    (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password)
  ) {
    throw new Error(`[config] ${label} must contain only the canonical origin.`);
  }
  return parsed;
}

function assertProductionOriginConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") return null;

  assertRenderReleaseIdentity(env, "web service");

  const appUrl = assertProductionUrl(env.APP_BASE_URL, "APP_BASE_URL", null, {
    exactOrigin: true,
  });
  if (!appUrl) {
    throw new Error("[config] APP_BASE_URL is required in production.");
  }
  const canonicalOrigin = appUrl.origin;

  const mongoUri = String(env.MONGO_URI || "").trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(mongoUri)) {
    throw new Error("[config] MONGO_URI must be a MongoDB connection URI in production.");
  }

  requireTruthy(env, [
    "ENABLE_CSRF",
    "REQUIRE_AUTH_SESSION",
    "REQUIRE_DATA_ENCRYPTION",
    "ENABLE_TWO_FACTOR",
    "TURNSTILE_ENFORCED",
    "S3_MALWARE_SCAN_REQUIRED",
  ]);
  if (String(env.EMAIL_DISABLE || "").trim().toLowerCase() !== "false") {
    throw new Error("[config] EMAIL_DISABLE must be false in production.");
  }
  if (Number(env.MESSAGE_EMAIL_SUPPRESS_MINUTES) !== 120) {
    throw new Error("[config] MESSAGE_EMAIL_SUPPRESS_MINUTES must be 120 in production.");
  }
  if (String(env.DEV_BYPASS_EMAILS || "").trim()) {
    throw new Error("[config] DEV_BYPASS_EMAILS must be empty in production.");
  }
  for (const name of ["APP_ENV", "ENVIRONMENT"]) {
    const value = String(env[name] || "").trim().toLowerCase();
    if (value && value !== "production") {
      throw new Error(`[config] ${name} cannot identify a production web service as ${value}.`);
    }
  }
  if (
    isTruthy(env.STAGING) ||
    String(env.RAILWAY_ENVIRONMENT || "").trim().toLowerCase() === "staging" ||
    String(env.VERCEL_ENV || "").trim().toLowerCase() === "preview"
  ) {
    throw new Error("[config] Production cannot expose staging or preview environment identity.");
  }
  for (const name of [
    "ENABLE_AI_CONTROL_ROOM_E2E_HARNESS",
    "ENABLE_CCO_AUTONOMY_HARNESS",
  ]) {
    if (isTruthy(env[name])) throw new Error(`[config] ${name} cannot be enabled in production.`);
  }
  if (String(env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET || "").trim()) {
    throw new Error("[config] AI_CONTROL_ROOM_E2E_HARNESS_SECRET cannot be configured in production.");
  }
  if (isTruthy(env.EMAIL_SKIP_VERIFY)) {
    throw new Error("[config] EMAIL_SKIP_VERIFY cannot be enabled in production.");
  }

  const incidentModes = {
    INCIDENT_PREVIEW_DEPLOY_MODE: String(env.INCIDENT_PREVIEW_DEPLOY_MODE || "disabled").trim().toLowerCase(),
    INCIDENT_PRODUCTION_DEPLOY_MODE: String(env.INCIDENT_PRODUCTION_DEPLOY_MODE || "disabled").trim().toLowerCase(),
    INCIDENT_ROLLBACK_MODE: String(env.INCIDENT_ROLLBACK_MODE || "disabled").trim().toLowerCase(),
  };
  for (const [name, mode] of Object.entries(incidentModes)) {
    if (!PRODUCTION_INCIDENT_RELEASE_MODES.has(mode)) {
      throw new Error(`[config] ${name} must be disabled or webhook in production.`);
    }
  }

  const incidentWebhookRequirements = [
    ["INCIDENT_PREVIEW_DEPLOY_MODE", "INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL"],
    ["INCIDENT_PRODUCTION_DEPLOY_MODE", "INCIDENT_PRODUCTION_DEPLOY_WEBHOOK_URL"],
    ["INCIDENT_ROLLBACK_MODE", "INCIDENT_PRODUCTION_ROLLBACK_WEBHOOK_URL"],
  ];
  for (const [modeName, urlName] of incidentWebhookRequirements) {
    if (incidentModes[modeName] === "webhook" && !String(env[urlName] || "").trim()) {
      throw new Error(`[config] ${urlName} is required when ${modeName}=webhook.`);
    }
  }
  if (
    isTruthy(env.INCIDENT_AUTO_DEPLOY_ENABLED) &&
    (incidentModes.INCIDENT_PREVIEW_DEPLOY_MODE !== "webhook" ||
      incidentModes.INCIDENT_PRODUCTION_DEPLOY_MODE !== "webhook")
  ) {
    throw new Error(
      "[config] INCIDENT_AUTO_DEPLOY_ENABLED requires webhook preview and production deploy modes in production."
    );
  }

  for (const name of [
    "INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL",
    "INCIDENT_PREVIEW_SMOKE_URL",
    "INCIDENT_PRODUCTION_DEPLOY_WEBHOOK_URL",
    "INCIDENT_PRODUCTION_HEALTH_URL",
    "INCIDENT_PRODUCTION_SMOKE_URL",
    "INCIDENT_PRODUCTION_LOG_WATCH_URL",
    "INCIDENT_PRODUCTION_ROLLBACK_WEBHOOK_URL",
  ]) {
    if (env[name]) assertProductionUrl(env[name], name, null);
  }

  if (Buffer.byteLength(String(env.JWT_SECRET || ""), "utf8") < 32) {
    throw new Error("[config] JWT_SECRET must contain at least 32 bytes in production.");
  }
  if (String(env.JWT_ISSUER || "").trim() !== canonicalOrigin) {
    throw new Error(`[config] JWT_ISSUER must be ${canonicalOrigin} in production.`);
  }
  if (String(env.JWT_AUDIENCE || "").trim() !== PRODUCTION_JWT_AUDIENCE) {
    throw new Error(
      `[config] JWT_AUDIENCE must be ${PRODUCTION_JWT_AUDIENCE} in production.`
    );
  }
  const encryptionKey = String(env.DATA_ENCRYPTION_KEY || "").trim();
  const validHexKey = /^[0-9a-fA-F]{64}$/.test(encryptionKey);
  let validBase64Key = false;
  if (encryptionKey) {
    try {
      validBase64Key = Buffer.from(encryptionKey, "base64").length === 32;
    } catch {
      validBase64Key = false;
    }
  }
  if (!validHexKey && !validBase64Key) {
    throw new Error("[config] DATA_ENCRYPTION_KEY must be a 32-byte base64 value or 64-character hex value in production.");
  }

  const stripeSecretKey = String(env.STRIPE_SECRET_KEY || "").trim();
  const stripePublishableKey = String(env.STRIPE_PUBLISHABLE_KEY || env.STRIPE_PK || "").trim();
  const stripeWebhookSecret = String(env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!/^sk_live_[A-Za-z0-9]+$/.test(stripeSecretKey)) {
    throw new Error("[config] STRIPE_SECRET_KEY must be a live-mode secret key in production.");
  }
  if (!/^pk_live_[A-Za-z0-9]+$/.test(stripePublishableKey)) {
    throw new Error("[config] STRIPE_PUBLISHABLE_KEY must be a live-mode publishable key in production.");
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(stripeWebhookSecret)) {
    throw new Error("[config] STRIPE_WEBHOOK_SECRET is required in production.");
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(String(env.STRIPE_CONNECT_WEBHOOK_SECRET || ""))) {
    throw new Error("[config] STRIPE_CONNECT_WEBHOOK_SECRET is required and must be a Stripe webhook signing secret.");
  }
  if (String(env.STRIPE_WEBHOOK_ALERTS_ENABLED || "").trim().toLowerCase() !== "true") {
    throw new Error("[config] STRIPE_WEBHOOK_ALERTS_ENABLED must be true in production.");
  }
  if (String(env.STRIPE_API_VERSION || "") !== SUPPORTED_STRIPE_API_VERSION) {
    throw new Error(
      `[config] STRIPE_API_VERSION must match the tested SDK version (${SUPPORTED_STRIPE_API_VERSION}).`
    );
  }
  assertPublishedPlatformFeePolicy(env);

  const s3Bucket = String(env.S3_BUCKET || "").trim();
  const s3Region = String(env.S3_REGION || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3Bucket) || s3Bucket.includes("..")) {
    throw new Error("[config] S3_BUCKET must be a valid production bucket name.");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(s3Region)) {
    throw new Error("[config] S3_REGION must be a valid AWS region.");
  }
  const hasS3AccessKey = Boolean(String(env.S3_ACCESS_KEY || "").trim());
  const hasS3SecretKey = Boolean(String(env.S3_SECRET_KEY || "").trim());
  if (hasS3AccessKey !== hasS3SecretKey) {
    throw new Error("[config] S3_ACCESS_KEY and S3_SECRET_KEY must be configured together, or both omitted for an IAM role.");
  }
  if (isTruthy(env.RENDER) && (!hasS3AccessKey || !hasS3SecretKey)) {
    throw new Error("[config] Render requires S3_ACCESS_KEY and S3_SECRET_KEY because it has no AWS workload IAM role.");
  }

  const openAiKey = String(env.OPENAI_API_KEY || "").trim();
  if (openAiKey.length < 20) {
    throw new Error("[config] OPENAI_API_KEY is required for enabled production AI workflows.");
  }
  if (Buffer.byteLength(String(env.OPENAI_SAFETY_SALT || ""), "utf8") < 32) {
    throw new Error("[config] OPENAI_SAFETY_SALT must contain at least 32 bytes in production.");
  }
  const supportManagerEnabled = explicitBoolean(env, "OPENAI_SUPPORT_MANAGER_ENABLED");
  const attorneyManagerEnabled = explicitBoolean(env, "OPENAI_ATTORNEY_MANAGER_ENABLED");
  const attorneyLegacyFallbackEnabled = explicitBoolean(env, "OPENAI_ATTORNEY_LEGACY_FALLBACK");
  const attorneyRolloutPercent = explicitRolloutStage(
    env,
    "OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT",
    ATTORNEY_MANAGER_ROLLOUT_STAGES
  );
  if ((!supportManagerEnabled || !attorneyManagerEnabled) && attorneyRolloutPercent !== 0) {
    throw new Error(
      "[config] A disabled Attorney Assistant manager requires OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT=0."
    );
  }
  if (
    supportManagerEnabled &&
    attorneyManagerEnabled &&
    attorneyRolloutPercent === 0 &&
    !String(env.OPENAI_ATTORNEY_MANAGER_ALLOWLIST || "").trim()
  ) {
    throw new Error(
      "[config] The 0% Attorney Assistant stage requires OPENAI_ATTORNEY_MANAGER_ALLOWLIST for internal production acceptance."
    );
  }
  if (attorneyLegacyFallbackEnabled) {
    throw new Error("[config] OPENAI_ATTORNEY_LEGACY_FALLBACK must be false in production.");
  }
  if (explicitBoolean(env, "OPENAI_PARALEGAL_MANAGER_ENABLED")) {
    throw new Error(
      "[config] OPENAI_PARALEGAL_MANAGER_ENABLED must remain false until its production acceptance is recorded."
    );
  }
  explicitRolloutStage(
    env,
    "OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT",
    new Set([0])
  );
  if (explicitBoolean(env, "OPENAI_PARALEGAL_LEGACY_FALLBACK")) {
    throw new Error("[config] OPENAI_PARALEGAL_LEGACY_FALLBACK must be false in production.");
  }
  if (String(env.TURNSTILE_SECRET || "").trim().length < 10) {
    throw new Error("[config] TURNSTILE_SECRET is required when Turnstile is enforced.");
  }

  const smtpPort = Number(env.SMTP_PORT);
  if (!String(env.SMTP_HOST || "").trim()) throw new Error("[config] SMTP_HOST is required in production.");
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error("[config] SMTP_PORT must be an integer from 1 to 65535.");
  }
  if (!["true", "false"].includes(String(env.SMTP_SECURE || "").trim().toLowerCase())) {
    throw new Error("[config] SMTP_SECURE must be true or false.");
  }
  if (!String(env.SMTP_USER || "").trim() || !String(env.SMTP_PASS || "").trim()) {
    throw new Error("[config] SMTP_USER and SMTP_PASS are required in production.");
  }
  if (!isEmail(env.SMTP_FROM_EMAIL)) throw new Error("[config] SMTP_FROM_EMAIL must be a valid email address.");
  if (!String(env.SMTP_FROM_NAME || "").trim()) throw new Error("[config] SMTP_FROM_NAME is required in production.");

  for (const name of ["OWNER_ALERT_EMAILS", "INCIDENT_FOUNDER_APPROVER_EMAILS", "INCIDENT_FOUNDER_ALERT_EMAILS"]) {
    const recipients = splitEmails(env[name]);
    if (!recipients.length || recipients.some((value) => !isEmail(value))) {
      throw new Error(`[config] ${name} must contain one or more valid email addresses.`);
    }
  }
  if (!isEmail(env.FOUNDER_EMAIL)) throw new Error("[config] FOUNDER_EMAIL must be a valid email address.");

  for (const name of ["CLIENT_BASE_URL", "FRONTEND_BASE_URL", "PUBLIC_ORIGIN", "EMAIL_BASE_URL"]) {
    if (!String(env[name] || "").trim()) throw new Error(`[config] ${name} is required in production.`);
    assertProductionUrl(env[name], name, canonicalOrigin, { exactOrigin: true });
  }
  const exactUrls = {
    STRIPE_CONNECT_RETURN_URL: `${canonicalOrigin}/profile-settings.html?stripe=return`,
    STRIPE_CONNECT_REFRESH_URL: `${canonicalOrigin}/profile-settings.html?stripe=refresh`,
    STRIPE_CHECKOUT_SUCCESS_URL: `${canonicalOrigin}/dashboard-attorney.html?payment=success#funds`,
    STRIPE_CHECKOUT_CANCEL_URL: `${canonicalOrigin}/dashboard-attorney.html?payment=cancel#funds`,
  };
  for (const [name, expected] of Object.entries(exactUrls)) {
    const parsed = assertProductionUrl(env[name], name, canonicalOrigin);
    if (!parsed || parsed.href !== expected) throw new Error(`[config] ${name} must be ${expected}.`);
  }
  if (String(env.STRIPE_CONNECT_COUNTRY || "").trim().toUpperCase() !== "US") {
    throw new Error("[config] STRIPE_CONNECT_COUNTRY must be US for the current payout contract.");
  }

  if (!env.WEBAUTHN_ORIGIN) throw new Error("[config] WEBAUTHN_ORIGIN is required in production.");
  assertProductionUrl(env.WEBAUTHN_ORIGIN, "WEBAUTHN_ORIGIN", canonicalOrigin, { exactOrigin: true });
  const rpId = String(env.WEBAUTHN_RP_ID || "").trim().toLowerCase();
  const hostname = appUrl.hostname.toLowerCase();
  if (!rpId || (hostname !== rpId && !hostname.endsWith(`.${rpId}`))) {
    throw new Error("[config] WEBAUTHN_RP_ID must be the production hostname or its parent domain.");
  }
  if (!String(env.WEBAUTHN_RP_NAME || "").trim()) throw new Error("[config] WEBAUTHN_RP_NAME is required in production.");

  const googleValues = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI];
  if (!googleValues.every((value) => String(value || "").trim())) {
    throw new Error(
      "[config] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI are required in production."
    );
  }
    const redirect = assertProductionUrl(
      env.GOOGLE_REDIRECT_URI,
      "GOOGLE_REDIRECT_URI",
      canonicalOrigin
    );
    if (
      redirect.pathname !== "/api/auth/google/callback" ||
      redirect.search ||
      redirect.hash ||
      redirect.username ||
      redirect.password
    ) {
      throw new Error(
        `[config] GOOGLE_REDIRECT_URI must be ${canonicalOrigin}/api/auth/google/callback.`
      );
    }

  const linkedInValues = [env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET, env.LINKEDIN_OAUTH_REDIRECT_URI];
  if (!linkedInValues.every((value) => String(value || "").trim())) {
    throw new Error("[config] LinkedIn OAuth configuration is required for the production publishing surface.");
  }
  const linkedInRedirect = assertProductionUrl(
    env.LINKEDIN_OAUTH_REDIRECT_URI,
    "LINKEDIN_OAUTH_REDIRECT_URI",
    canonicalOrigin
  );
  const expectedLinkedInPath = "/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback";
  if (linkedInRedirect.pathname !== expectedLinkedInPath || linkedInRedirect.search || linkedInRedirect.hash) {
    throw new Error(`[config] LINKEDIN_OAUTH_REDIRECT_URI must be ${canonicalOrigin}${expectedLinkedInPath}.`);
  }

  for (const name of [
    "ZOHO_MAIL_REFRESH_TOKEN",
    "ZOHO_MAIL_CLIENT_ID",
    "ZOHO_MAIL_CLIENT_SECRET",
    "DIRECTOR_SMTP_USER",
    "DIRECTOR_SMTP_PASS",
  ]) {
    if (!String(env[name] || "").trim()) throw new Error(`[config] ${name} is required for the production director portal.`);
  }

  const corsOrigins = String(env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (corsOrigins.includes("*")) {
    throw new Error("[config] CORS_ORIGINS cannot contain a wildcard in production.");
  }
  if (corsOrigins.length !== 1 || corsOrigins[0] !== canonicalOrigin) {
    throw new Error(`[config] CORS_ORIGINS must contain only ${canonicalOrigin}.`);
  }
  for (const origin of corsOrigins) {
    assertProductionUrl(origin, "CORS_ORIGINS", canonicalOrigin, { exactOrigin: true });
  }

  return canonicalOrigin;
}

module.exports = {
  assertProductionOriginConfiguration,
  PRODUCTION_JWT_AUDIENCE,
  SUPPORTED_STRIPE_API_VERSION,
};
