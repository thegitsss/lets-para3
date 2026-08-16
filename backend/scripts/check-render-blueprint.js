const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const { parseDocument } = require("yaml");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("../utils/legalDocuments");
const {
  PUBLISHED_ATTORNEY_PLATFORM_FEE_PERCENT,
  PUBLISHED_PARALEGAL_PLATFORM_FEE_PERCENT,
} = require("../services/platformFeePolicy");

const RENDER_SCHEMA_URL = "https://render.com/schema/render.yaml.json";
const RENDER_SCHEMA_SHA256 = "665539cb0c191856ba38d292b985a963880bb69b030d666e5fe7788e78e7e696";
const CANONICAL_ORIGIN = "https://www.lets-paraconnect.com";

function fail(message) {
  throw new Error(`[deploy] ${message}`);
}

function parseArguments(argv) {
  const args = [...argv];
  let blueprintPath = "../render.yaml";
  let schemaPath = "";
  if (args[0] && args[0] !== "--schema") blueprintPath = args.shift();
  while (args.length) {
    const flag = args.shift();
    if (flag === "--schema" && args[0]) {
      schemaPath = args.shift();
      continue;
    }
    fail(`Unknown or incomplete argument: ${flag}`);
  }
  return { blueprintPath, schemaPath };
}

function parseYaml(source, filePath) {
  const document = parseDocument(source, {
    maxAliasCount: 20,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) {
    fail(`${filePath} is not valid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value = document.toJS({ maxAliasCount: 20 });
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${filePath} must contain a YAML object.`);
  return value;
}

async function loadPinnedSchema(schemaPath) {
  let source;
  if (schemaPath) {
    source = fs.readFileSync(path.resolve(process.cwd(), schemaPath), "utf8");
  } else {
    const response = await fetch(RENDER_SCHEMA_URL, {
      headers: { Accept: "application/schema+json, application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) fail(`Unable to download Render's schema (${response.status}).`);
    source = await response.text();
  }
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  if (digest !== RENDER_SCHEMA_SHA256) {
    fail(
      `Render schema digest changed (received ${digest}). Review the upstream schema before updating the pinned digest.`
    );
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`Render schema is not valid JSON: ${error.message}`);
  }
}

function formatSchemaErrors(errors = []) {
  return errors
    .slice(0, 20)
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`);
}

function validateEnvironment(service, fixedValues, requiredSecrets) {
  const label = service.name;
  const entries = Array.isArray(service.envVars) ? service.envVars : [];
  const names = new Set();
  const allowed = new Set([...Object.keys(fixedValues), ...requiredSecrets]);
  for (const entry of entries) {
    if (!entry?.key || names.has(entry.key)) fail(`${label} environment variable ${entry?.key || "<missing>"} is duplicated or unnamed.`);
    names.add(entry.key);
    if (!allowed.has(entry.key)) fail(`${label} contains unexpected environment variable ${entry.key}.`);
    if (Object.prototype.hasOwnProperty.call(fixedValues, entry.key)) {
      requireEqual(entry.value, fixedValues[entry.key], `${label}.envVars.${entry.key}`);
      if (entry.sync === false) fail(`${label} non-secret ${entry.key} must be drift-controlled in the Blueprint.`);
      continue;
    }
    requireEqual(entry.sync, false, `${label}.envVars.${entry.key}.sync`);
    if (Object.prototype.hasOwnProperty.call(entry, "value")) fail(`${label} secret ${entry.key} must not contain a checked-in value.`);
  }
  for (const key of Object.keys(fixedValues)) if (!names.has(key)) fail(`${label} is missing drift-controlled environment variable ${key}.`);
  for (const key of requiredSecrets) if (!names.has(key)) fail(`${label} is missing secret environment variable declaration ${key}.`);
}

function validateServiceBase(service, expected) {
  const common = {
    runtime: "node",
    repo: "https://github.com/thegitsss/lets-para3",
    branch: "main",
    autoDeployTrigger: "checksPass",
    ...expected,
  };
  for (const [key, value] of Object.entries(common)) requireEqual(service[key], value, `${service.name}.${key}`);
  if (Object.prototype.hasOwnProperty.call(service, "rootDir")) {
    fail(`${service.name}.rootDir must remain unset because commands and web serving depend on repository-root siblings.`);
  }
}

function validateDeploymentContract(blueprint) {
  if (!Array.isArray(blueprint.services) || blueprint.services.length !== 4) {
    fail("The production Blueprint must define the web service, incident worker, automation cron, and operations-monitor cron.");
  }
  const services = new Map(blueprint.services.map((service) => [service?.name, service]));
  if (services.size !== blueprint.services.length) fail("Every production service must have a unique name.");
  const service = services.get("lets-para3");
  const incidentWorker = services.get("lets-para3-incident-runner");
  const automationCron = services.get("lets-para3-automation");
  const opsCron = services.get("lets-para3-ops-monitor");
  if (!service || !incidentWorker || !automationCron || !opsCron) fail("One or more required production services are missing.");

  validateServiceBase(service, {
    type: "web",
    name: "lets-para3",
    buildCommand: "cd backend && node scripts/verify-runtime.js && npm ci",
    preDeployCommand: "cd backend && npm run migrate:production:apply",
    startCommand: "cd backend && npm start",
    healthCheckPath: "/api/health",
    maxShutdownDelaySeconds: 30,
    renderSubdomainPolicy: "disabled",
  });
  if (JSON.stringify(service.domains) !== JSON.stringify(["www.lets-paraconnect.com"])) {
    fail("lets-para3.domains must contain only the canonical www hostname.");
  }
  requireEqual(service.previews?.generation, "manual", "lets-para3.previews.generation");

  const webFixedValues = {
    NODE_ENV: "production",
    NODE_VERSION: "24.18.0",
    APP_BASE_URL: CANONICAL_ORIGIN,
    CLIENT_BASE_URL: CANONICAL_ORIGIN,
    FRONTEND_BASE_URL: CANONICAL_ORIGIN,
    PUBLIC_ORIGIN: CANONICAL_ORIGIN,
    EMAIL_BASE_URL: CANONICAL_ORIGIN,
    CORS_ORIGINS: CANONICAL_ORIGIN,
    WEBAUTHN_ORIGIN: CANONICAL_ORIGIN,
    WEBAUTHN_RP_ID: "www.lets-paraconnect.com",
    WEBAUTHN_RP_NAME: "Let's-ParaConnect",
    JWT_ISSUER: CANONICAL_ORIGIN,
    JWT_AUDIENCE: "lets-paraconnect-web",
    STRIPE_API_VERSION: "2026-07-29.dahlia",
    STRIPE_CONNECT_COUNTRY: "US",
    STRIPE_WEBHOOK_ALERTS_ENABLED: "true",
    PLATFORM_FEE_ATTORNEY_PERCENT: String(PUBLISHED_ATTORNEY_PLATFORM_FEE_PERCENT),
    PLATFORM_FEE_PARALEGAL_PERCENT: String(PUBLISHED_PARALEGAL_PLATFORM_FEE_PERCENT),
    STRIPE_CONNECT_RETURN_URL: `${CANONICAL_ORIGIN}/profile-settings.html?stripe=return`,
    STRIPE_CONNECT_REFRESH_URL: `${CANONICAL_ORIGIN}/profile-settings.html?stripe=refresh`,
    STRIPE_CHECKOUT_SUCCESS_URL: `${CANONICAL_ORIGIN}/dashboard-attorney.html?payment=success#funds`,
    STRIPE_CHECKOUT_CANCEL_URL: `${CANONICAL_ORIGIN}/dashboard-attorney.html?payment=cancel#funds`,
    GOOGLE_REDIRECT_URI: `${CANONICAL_ORIGIN}/api/auth/google/callback`,
    ENABLE_CSRF: "true",
    REQUIRE_AUTH_SESSION: "true",
    REQUIRE_DATA_ENCRYPTION: "true",
    S3_MALWARE_SCAN_REQUIRED: "true",
    ENABLE_TWO_FACTOR: "true",
    TURNSTILE_ENFORCED: "true",
    EMAIL_DISABLE: "false",
    MESSAGE_EMAIL_SUPPRESS_MINUTES: "120",
    INCIDENT_AUTO_DEPLOY_ENABLED: "false",
    INCIDENT_PREVIEW_DEPLOY_MODE: "disabled",
    INCIDENT_PRODUCTION_DEPLOY_MODE: "disabled",
    INCIDENT_ROLLBACK_MODE: "disabled",
    BUSINESS_TIME_ZONE: "America/New_York",
    TZ: "America/New_York",
    LEGAL_APPROVED_TERMS_VERSION: CURRENT_TERMS_VERSION,
    LEGAL_APPROVED_PRIVACY_VERSION: CURRENT_PRIVACY_VERSION,
    OPENAI_SUPPORT_MANAGER_ENABLED: "true",
    OPENAI_ATTORNEY_LEGACY_FALLBACK: "false",
    OPENAI_PARALEGAL_MANAGER_ENABLED: "false",
    OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "0",
    OPENAI_PARALEGAL_LEGACY_FALLBACK: "false",
  };
  const webSecrets = new Set([
    "MONGO_URI",
    "JWT_SECRET",
    "DATA_ENCRYPTION_KEY",
    "OPENAI_API_KEY",
    "OPENAI_SAFETY_SALT",
    "OPENAI_ATTORNEY_MANAGER_ENABLED",
    "OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT",
    "OPENAI_ATTORNEY_MANAGER_ALLOWLIST",
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "TURNSTILE_SECRET",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM_EMAIL",
    "SMTP_FROM_NAME",
    "OWNER_ALERT_EMAILS",
    "FOUNDER_EMAIL",
    "INCIDENT_FOUNDER_APPROVER_EMAILS",
    "INCIDENT_FOUNDER_ALERT_EMAILS",
    "LINKEDIN_CLIENT_ID",
    "LINKEDIN_CLIENT_SECRET",
    "ZOHO_MAIL_REFRESH_TOKEN",
    "ZOHO_MAIL_CLIENT_ID",
    "ZOHO_MAIL_CLIENT_SECRET",
    "DIRECTOR_SMTP_USER",
    "DIRECTOR_SMTP_PASS",
    "LEGAL_COUNSEL_APPROVAL_ID",
    "LEGAL_APPROVED_TERMS_SHA256",
    "LEGAL_APPROVED_PRIVACY_SHA256",
  ]);
  webFixedValues.LINKEDIN_OAUTH_REDIRECT_URI = `${CANONICAL_ORIGIN}/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback`;
  validateEnvironment(service, webFixedValues, webSecrets);

  const leanBuild = "cd backend && node scripts/verify-runtime.js && PUPPETEER_SKIP_DOWNLOAD=true MONGOMS_DISABLE_POSTINSTALL=true npm ci";
  validateServiceBase(incidentWorker, {
    type: "worker",
    name: "lets-para3-incident-runner",
    buildCommand: leanBuild,
    startCommand: "cd backend && npm run incident:runner",
    maxShutdownDelaySeconds: 300,
  });
  validateEnvironment(incidentWorker, {
    NODE_ENV: "production",
    NODE_VERSION: "24.18.0",
    APP_BASE_URL: CANONICAL_ORIGIN,
    EMAIL_BASE_URL: CANONICAL_ORIGIN,
    EMAIL_DISABLE: "false",
    PUPPETEER_SKIP_DOWNLOAD: "true",
    MONGOMS_DISABLE_POSTINSTALL: "true",
    INCIDENT_RUNNER_MAX_JOBS: "1",
    INCIDENT_RUNNER_POLL_MS: "5000",
    INCIDENT_RUNNER_LOCK_MS: "240000",
    INCIDENT_RUNNER_LOCK_RENEW_MS: "30000",
    INCIDENT_RUNNER_HEARTBEAT_MS: "300000",
    INCIDENT_RUNNER_SHUTDOWN_GRACE_MS: "270000",
    INCIDENT_AUTO_DEPLOY_ENABLED: "false",
    INCIDENT_PREVIEW_DEPLOY_MODE: "disabled",
    INCIDENT_PRODUCTION_DEPLOY_MODE: "disabled",
    INCIDENT_ROLLBACK_MODE: "disabled",
    TZ: "America/New_York",
  }, new Set([
    "MONGO_URI", "DATA_ENCRYPTION_KEY", "OPENAI_API_KEY", "OPENAI_SAFETY_SALT",
    "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM_EMAIL", "SMTP_FROM_NAME",
    "INCIDENT_FOUNDER_APPROVER_EMAILS", "INCIDENT_FOUNDER_ALERT_EMAILS",
  ]));

  validateServiceBase(automationCron, {
    type: "cron",
    name: "lets-para3-automation",
    schedule: "*/5 * * * *",
    buildCommand: leanBuild,
    startCommand: "cd backend && npm run automation:cycle",
  });
  validateEnvironment(automationCron, {
    NODE_ENV: "production",
    NODE_VERSION: "24.18.0",
    APP_BASE_URL: CANONICAL_ORIGIN,
    EMAIL_BASE_URL: CANONICAL_ORIGIN,
    EMAIL_DISABLE: "false",
    PUPPETEER_SKIP_DOWNLOAD: "true",
    MONGOMS_DISABLE_POSTINSTALL: "true",
    MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED: "false",
    TZ: "America/New_York",
    LINKEDIN_OAUTH_REDIRECT_URI: `${CANONICAL_ORIGIN}/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback`,
  }, new Set([
    "MONGO_URI", "DATA_ENCRYPTION_KEY", "OPENAI_API_KEY", "OPENAI_SAFETY_SALT",
    "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY",
    "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM_EMAIL", "SMTP_FROM_NAME",
    "FOUNDER_EMAIL", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET",
    "ZOHO_MAIL_REFRESH_TOKEN", "ZOHO_MAIL_CLIENT_ID", "ZOHO_MAIL_CLIENT_SECRET",
    "DIRECTOR_SMTP_USER", "DIRECTOR_SMTP_PASS",
  ]));

  validateServiceBase(opsCron, {
    type: "cron",
    name: "lets-para3-ops-monitor",
    schedule: "*/5 * * * *",
    buildCommand: leanBuild,
    startCommand: "cd backend && npm run ops:monitor",
  });
  validateEnvironment(opsCron, {
    NODE_ENV: "production",
    NODE_VERSION: "24.18.0",
    APP_BASE_URL: CANONICAL_ORIGIN,
    OPS_HEALTHCHECK_URL: `${CANONICAL_ORIGIN}/api/health`,
    EMAIL_DISABLE: "false",
    PUPPETEER_SKIP_DOWNLOAD: "true",
    MONGOMS_DISABLE_POSTINSTALL: "true",
    MONITOR_CHECK_WEBHOOKS: "true",
    MONITOR_REQUIRE_BACKUP: "true",
    MONITOR_PERSIST_STATE: "true",
    MONITOR_SEND_OWNER_ALERTS: "true",
    MONITOR_ALERT_ON_OK: "true",
    BACKUP_MAX_AGE_HOURS: "36",
    WEBHOOK_FAILURE_LOOKBACK_MINUTES: "30",
    ATLAS_CLUSTER_TYPE: "replica_set",
    TZ: "America/New_York",
  }, new Set([
    "MONGO_URI", "ATLAS_PROJECT_ID", "ATLAS_CLUSTER_NAME", "ATLAS_CLIENT_ID", "ATLAS_CLIENT_SECRET",
    "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM_EMAIL", "SMTP_FROM_NAME",
    "OWNER_ALERT_EMAILS",
  ]));
}

async function main() {
  const { blueprintPath, schemaPath } = parseArguments(process.argv.slice(2));
  const resolvedBlueprint = path.resolve(process.cwd(), blueprintPath);
  const blueprint = parseYaml(fs.readFileSync(resolvedBlueprint, "utf8"), resolvedBlueprint);
  const schema = await loadPinnedSchema(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(blueprint)) fail(`Blueprint schema validation failed: ${formatSchemaErrors(validate.errors)}`);
  validateDeploymentContract(blueprint);
  console.log(`[deploy] ${resolvedBlueprint} matches Render's pinned schema and LPC's production contract.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
